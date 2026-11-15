import { parseOptionalBoolean, parseOptionalInteger } from "./memory-service-utils";
import { startAllTenantSearch, finishAllTenantSearch, mergeTenantRanks } from "./all-tenant-search";
import { parseOptionalStrictString as parseOptionalString } from "./request-value-utils";
import { HttpError, collapseWhitespace, estimateJsonTokens, shouldSampleMemoryEffectVerification, ulid, type MemoryWorkType } from "@org-brain/shared";
import type { Env } from "./types";
import { validateBusinessClassification } from "./business-category-service";
import { recordMemoryUsage } from "./memory-effect-service";
import { prepareAgentLoadoutContext } from "./agent-loadout-service";
import {
  TASK_TYPES, parseEnum, parseStringArray, normalizePrincipal, clamp, filterSourceRefs,
  filterReadableDecisionMemories, compareScored, detectConflicts, loadDecisionMemories,
  toDecisionMemory, scoreDecisionMemory, buildTrustSignals, buildProvenance,
  durableAutoDecisionSource, type DecisionMemoryRow, type ScoredDecisionMemory,
  type PrincipalIdentityOptions, type SourceRef, type TaskType
} from "./decision-memory-service";

const DEFAULT_MAX_TOKENS = 6000;

type ContextEnrichRequest = {
  orgId?: string;
  tenant_id?: string;
  projectId?: string | null;
  project_id?: string | null;
  agentId?: string;
  agent_id?: string;
  agentKey?: string;
  agent_key?: string;
  userId?: string;
  user_id?: string;
  taskType?: TaskType;
  task_type?: TaskType;
  task?: {
    title?: string;
    description?: string;
    targetFiles?: string[];
    target_files?: string[];
    relatedIssueIds?: string[];
    related_issue_ids?: string[];
  };
  maxTokens?: number;
  max_tokens?: number;
  includeSources?: boolean;
  include_sources?: boolean;
  includeConflicts?: boolean;
  include_conflicts?: boolean;
  debugScores?: boolean;
  debug_scores?: boolean;
  includeProvenance?: boolean;
  include_provenance?: boolean;
  authorityScoring?: boolean;
  authority_scoring?: boolean;
  verificationView?: boolean;
  verification_view?: boolean;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
};

function buildTaskText(task: { title?: string; description?: string; relatedIssueIds?: string[]; related_issue_ids?: string[] }): string {
  return collapseWhitespace(`${task.title ?? ""} ${task.description ?? ""} ${(task.relatedIssueIds ?? task.related_issue_ids ?? []).join(" ")}`);
}

function parseEnrichRequest(rawBody: unknown, principal?: string | null) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as ContextEnrichRequest;
  const requestPrincipal = normalizePrincipal(principal);
  const task = body.task;
  if (!task || typeof task !== "object") throw new HttpError(400, "invalid_payload", "task is required");
  const issueIds = task.relatedIssueIds ?? task.related_issue_ids ?? [];
  if (!Array.isArray(issueIds) || !issueIds.every((id) => typeof id === "string")) {
    throw new HttpError(400, "invalid_related_issue_ids", "task.relatedIssueIds must be an array of strings");
  }
  const taskTitle = parseOptionalString(task.title, "task.title", 240);
  const taskDescription = parseOptionalString(task.description, "task.description", 2000);
  const taskText = buildTaskText({ ...task, title: taskTitle ?? "", description: taskDescription ?? "" });
  if (!taskText) throw new HttpError(400, "invalid_payload", "task title or description is required");
  return {
    tenantId: parseOptionalString(body.orgId ?? body.tenant_id, "orgId", 128) ?? "default",
    projectId: parseOptionalString(body.projectId ?? body.project_id, "projectId", 128),
    agentId: requestPrincipal ?? parseOptionalString(body.agentId ?? body.agent_id, "agentId", 128),
    agentKey: parseOptionalString(body.agentKey ?? body.agent_key, "agentKey", 128),
    userId: requestPrincipal ?? parseOptionalString(body.userId ?? body.user_id, "userId", 128),
    taskType: parseEnum(body.taskType ?? body.task_type, "taskType", TASK_TYPES, "implementation"),
    taskTitle: taskTitle ?? "",
    taskDescription: taskDescription ?? "",
    taskText,
    targetFiles: parseStringArray(task.targetFiles ?? task.target_files, "task.targetFiles", 32, 256),
    maxTokens: parseOptionalInteger(body.maxTokens ?? body.max_tokens, "maxTokens", DEFAULT_MAX_TOKENS, 500, 32000),
    includeSources: parseOptionalBoolean(body.includeSources ?? body.include_sources, "includeSources", true),
    includeConflicts: parseOptionalBoolean(body.includeConflicts ?? body.include_conflicts, "includeConflicts", true),
    debugScores: parseOptionalBoolean(body.debugScores ?? body.debug_scores, "debugScores", false),
    includeProvenance: parseOptionalBoolean(body.includeProvenance ?? body.include_provenance, "includeProvenance", false),
    authorityScoring: parseOptionalBoolean(body.authorityScoring ?? body.authority_scoring, "authorityScoring", false),
    verificationView: parseOptionalBoolean(body.verificationView ?? body.verification_view, "verificationView", false),
    businessCategoryId: parseOptionalString(body.business_category_id, "business_category_id", 128),
    workType: body.work_type ?? null
  };
}

function toPublicDecisionContext(item: ScoredDecisionMemory, includeSources: boolean, userId: string | null, agentId: string | null, debugScores: boolean) {
  return {
    id: item.memory.id,
    projectId: item.memory.projectId,
    businessCategoryId: item.memory.businessCategoryId,
    workType: item.memory.workType,
    title: item.memory.title,
    decision: item.memory.decision,
    rationale: item.memory.rationale,
    constraints: item.memory.constraints,
    knownPitfalls: item.memory.knownPitfalls,
    status: item.memory.status,
    confidence: item.memory.confidence,
    confirmationState: item.memory.confirmationState,
    validFrom: item.memory.validFrom,
    validUntil: item.memory.validUntil,
    sources: includeSources ? filterSourceRefs(item.memory.sourceRefs, userId, agentId) : undefined,
    score: debugScores ? item.score : undefined
  };
}

function toPublicDecisionContextWithFlags(args: {
  item: ScoredDecisionMemory;
  includeSources: boolean;
  includeProvenance: boolean;
  authorityScoring: boolean;
  verificationView: boolean;
  conflicts: ReturnType<typeof detectConflicts>;
  userId: string | null;
  agentId: string | null;
  debugScores: boolean;
}) {
  const result: Record<string, unknown> = {
    ...toPublicDecisionContext(args.item, args.includeSources, args.userId, args.agentId, args.debugScores),
    tenant_id: args.item.memory.tenantId
  };
  if (args.includeProvenance || args.verificationView) {
    result.provenance = buildProvenance(args.item.memory, args.userId, args.agentId);
  }
  if (args.authorityScoring || args.verificationView) {
    result.trustSignals = buildTrustSignals(args.item.memory, args.conflicts, args.userId, args.agentId);
  }
  return result;
}

function trimToMaxTokens(response: Record<string, unknown>, maxTokens: number): Record<string, unknown> {
  const trimmed = response;
  const decisionContext = Array.isArray(trimmed.decisionContext) ? trimmed.decisionContext : [];
  const knownPitfalls = Array.isArray(trimmed.knownPitfalls) ? trimmed.knownPitfalls : [];
  const constraints = Array.isArray(trimmed.constraints) ? trimmed.constraints : [];
  const nextActions = Array.isArray(trimmed.recommendedNextActions) ? trimmed.recommendedNextActions : [];
  const conflicts = Array.isArray(trimmed.conflicts) ? trimmed.conflicts : [];
  const meta = trimmed.meta as { estimatedTokens: number; selectedMemoryCount: number };
  const overBudget = () => {
    let estimate: number;
    do {
      estimate = meta.estimatedTokens;
      meta.estimatedTokens = estimateJsonTokens(trimmed);
    } while (estimate !== meta.estimatedTokens);
    return meta.estimatedTokens > maxTokens;
  };
  const popNested = (field: "knownPitfalls" | "constraints" | "sources") => {
    for (let index = decisionContext.length - 1; index >= 0; index -= 1) {
      const entry = decisionContext[index];
      if (!entry || typeof entry !== "object") continue;
      const values = (entry as Record<string, unknown>)[field];
      if (Array.isArray(values) && values.length > 0) {
        values.pop();
        return true;
      }
    }
    return false;
  };

  while (overBudget() && knownPitfalls.length > 0) knownPitfalls.pop();
  while (overBudget() && nextActions.length > 0) nextActions.pop();
  while (overBudget() && constraints.length > 0) constraints.pop();
  while (overBudget() && decisionContext.length > 1) decisionContext.pop();
  while (overBudget() && popNested("knownPitfalls")) continue;
  while (overBudget() && popNested("constraints")) continue;
  while (overBudget() && popNested("sources")) continue;
  while (overBudget() && conflicts.length > 0) conflicts.pop();

  if (overBudget() && decisionContext[0] && typeof decisionContext[0] === "object") {
    const entry = decisionContext[0] as Record<string, unknown>;
    delete entry.provenance;
    delete entry.trustSignals;
    if (typeof entry.rationale === "string") entry.rationale = entry.rationale.slice(0, 320);
    if (typeof entry.decision === "string") entry.decision = entry.decision.slice(0, 480);
    if (typeof entry.title === "string") entry.title = entry.title.slice(0, 160);
  }
  if (overBudget()) {
    trimmed.summary = String(trimmed.summary ?? "").slice(0, Math.max(80, Math.min(480, maxTokens)));
  }
  if (overBudget()) decisionContext.splice(0);
  if (overBudget()) {
    trimmed.summary = String(trimmed.summary ?? "").slice(0, 160);
  }
  if (decisionContext.length === 0 && meta.selectedMemoryCount > 0) {
    trimmed.summary = "文章量の上限により、判断の詳細は省略しました。";
  }
  if (overBudget()) delete trimmed.agentContext;
  if (overBudget() && trimmed.project_index) {
    trimmed.project_index = { status: "omitted", reason: "token_budget", requires_read: true };
  }
  if (overBudget()) trimmed.summary = "";
  if (overBudget()) throw new HttpError(400, "token_budget_too_small", "maxTokens is too small for the required response");
  return trimmed;
}

async function assembleContext(env: Env, rawBody: unknown, options: PrincipalIdentityOptions & { projectIndex?: Record<string, unknown> } = {}) {
  const request = parseEnrichRequest(rawBody, options.principal);
  const sharedPending = startAllTenantSearch<DecisionMemoryRow>(env, {
    ...request, kind: "decision_memory", q: request.taskText, limit: 8
  });
  await validateBusinessClassification(
    env,
    request.tenantId,
    request.businessCategoryId,
    request.workType,
    { required: false }
  );
  const memories = await loadDecisionMemories(env, {
    tenantId: request.tenantId,
    projectId: request.projectId,
    q: request.taskText,
    limit: 24,
    businessCategoryId: request.businessCategoryId,
    workType: request.workType
  });
  const visibleMemories = await filterReadableDecisionMemories(
    env,
    request.tenantId,
    memories,
    request.userId,
    request.agentId,
    options.principal
  );
  const scored = visibleMemories
    .map((memory) => ({
      memory,
      score: scoreDecisionMemory({
        memory,
        taskText: request.taskText,
        taskType: request.taskType,
        targetFiles: request.targetFiles,
        projectId: request.projectId,
        userId: request.userId,
        agentId: request.agentId
      })
    }))
    .sort(compareScored);

  const conflicts = request.includeConflicts ? detectConflicts(scored, Date.now()) : [];
  const shared = await finishAllTenantSearch(sharedPending);
  const global = shared.rows.map(toDecisionMemory).map((memory) => ({
    memory, score: scoreDecisionMemory({
      memory, taskText: request.taskText, taskType: request.taskType, targetFiles: request.targetFiles,
      projectId: null, userId: request.userId, agentId: request.agentId
    })
  }));
  const selected = mergeTenantRanks(scored, global, 8);
  const constraints = [...new Set(selected.flatMap((item) => item.memory.constraints))].slice(0, 12);
  const knownPitfalls = [...new Set(selected.flatMap((item) => item.memory.knownPitfalls))].slice(0, 12);
  const top = selected[0];
  const confidence = selected.length === 0
    ? 0
    : clamp(selected.reduce((sum, item) => sum + item.score.finalScore * item.memory.confidence, 0) / selected.length, 0, 1);
  const requiresHumanReview =
    confidence < 0.45 ||
    selected.some((item) => item.memory.status === "uncertain") ||
    conflicts.some((conflict) => conflict.requiresHumanReview);
  const preparedLoadout = request.agentKey
    ? await prepareAgentLoadoutContext(env, {
        tenantId: request.tenantId,
        agentKey: request.agentKey,
        principal: normalizePrincipal(options.principal) ?? request.agentId ?? request.userId ?? "api",
        projectId: request.projectId,
        taskText: request.taskText,
        maxTokens: Math.max(500, Math.floor(request.maxTokens / 2)),
        recordUsage: options.recordUsage !== false,
        usageEvent: "resolved",
        enforceRuntimeFlag: true
      })
    : null;

  const agentContext = preparedLoadout?.context;
  const usageId = options.recordUsage !== false ? ulid() : null;
  let projectIndex = options.projectIndex;
  if (projectIndex && estimateJsonTokens({ project_index: projectIndex }) > request.maxTokens - 500)
    projectIndex = { status: "omitted", reason: "token_budget", requires_read: true };
  const fullResponse = {
      ...(projectIndex ? { project_index: projectIndex } : {}),
      summary: top
        ? `このタスクでは「${top.memory.title}」の判断を優先してください: ${top.memory.decision}`
        : "このタスクに十分関連するdecision memoryは見つかりませんでした。",
      decisionContext: selected.map((item) =>
        toPublicDecisionContextWithFlags({
          item,
          includeSources: request.includeSources,
          includeProvenance: request.includeProvenance,
          authorityScoring: request.authorityScoring,
          verificationView: request.verificationView,
          conflicts,
          userId: request.userId,
          agentId: request.agentId,
          debugScores: request.debugScores
        })
      ),
      constraints,
      knownPitfalls,
      conflicts,
      ...(agentContext ? { agentContext } : {}),
      recommendedNextActions: [
        request.taskType === "implementation" ? "対象ファイルで既存方針に沿う実装例を確認する" : "差分が既存方針に反していないか確認する",
        constraints.length > 0 ? "PR前にconstraintsに対応するテストまたはレビュー観点を確認する" : "不足する組織文脈があればdecision memoryとして記録する"
      ],
      confidence: Number(confidence.toFixed(3)),
      requiresHumanReview,
      meta: {
        tenant_id: request.tenantId,
        project_id: request.projectId,
        task_type: request.taskType,
        selectedMemoryCount: selected.length,
        shared_search: shared.shared_search,
        conflictCount: conflicts.length,
        featureFlags: {
          includeProvenance: request.includeProvenance,
          authorityScoring: request.authorityScoring,
          verificationView: request.verificationView
        },
        estimatedTokens: 0,
        usage_recorded: Boolean(usageId),
        ...(usageId ? {
          usage_id: usageId,
          verification_sampled: shouldSampleMemoryEffectVerification(request.tenantId, usageId)
        } : {}),
        retrieval: {
          generation_id: "gen_structured_context",
          unit_schema_version: "2",
          extractor_name: "decision-memory-projector",
          extractor_version: "1",
          ranking_profile_id: "rank_default",
          embedding_profile_id: null
        }
      }
    };
  const policyContext = structuredClone({
    confidence: fullResponse.confidence,
    requiresHumanReview: fullResponse.requiresHumanReview,
    conflicts: fullResponse.conflicts,
    decisionContext: fullResponse.decisionContext
  }) as {
    confidence: number;
    requiresHumanReview: boolean;
    conflicts: ReturnType<typeof detectConflicts>;
    decisionContext: Array<{
      id?: string;
      projectId?: string | null;
      businessCategoryId?: string | null;
      workType?: MemoryWorkType | null;
      decision?: string;
      rationale?: string;
      constraints?: string[];
      status?: string;
      confidence?: number;
      confirmationState?: string;
      validFrom?: number | null;
      validUntil?: number | null;
      sources?: SourceRef[];
    }>;
  };
  const response = trimToMaxTokens(fullResponse, request.maxTokens) as typeof fullResponse;
  if (response.agentContext) await preparedLoadout?.recordUsage?.();
  if (usageId) {
    try {
      const returned = response.decisionContext as Array<Record<string, unknown>>;
      const selectedByIdentity = new Map(selected.map((item) => [
        JSON.stringify([item.memory.tenantId, item.memory.id]), item
      ]));
      await recordMemoryUsage(env, {
        id: usageId,
        tenant_id: request.tenantId,
        project_id: request.projectId,
        capability: "context_enrich",
        access_path: "context",
        request_source: "api",
        requested_business_category_id: request.businessCategoryId,
        requested_work_type: request.workType,
        retrieval_generation_id: "gen_structured_context",
        ranking_profile_id: "rank_default",
        actor_principal: options.principal ?? null,
        items: returned.map((entry, index) => {
          const item = selectedByIdentity.get(JSON.stringify([entry.tenant_id, entry.id]))!;
          return {
            source_type: "decision_memory" as const,
            source_id: item.memory.id,
            source_tenant_id: item.memory.tenantId,
            rank: index + 1,
            score: item.score.finalScore,
            reference_type: "injected" as const,
            used_state: "unknown" as const,
            injected_token_estimate: estimateJsonTokens(entry)
          };
        })
      });
    } catch (error) {
      if (!options.bestEffortUsage) throw error;
      console.warn({
        event: "orgbrain.context.usage_recording_skipped",
        tenant_id: request.tenantId,
        project_id: request.projectId,
        error_code: error instanceof HttpError ? error.code : "unknown"
      });
      const meta = response.meta as Record<string, unknown>;
      meta.usage_recorded = false;
      delete meta.usage_id;
      delete meta.verification_sampled;
      trimToMaxTokens(response, request.maxTokens);
    }
  }
  return { response, policyContext };
}

export async function enrichContext(env: Env, rawBody: unknown, options: PrincipalIdentityOptions & { projectIndex?: Record<string, unknown> } = {}) {
  return (await assembleContext(env, rawBody, options)).response;
}

export async function preActionDecisionGate(
  env: Env,
  rawBody: unknown,
  options: PrincipalIdentityOptions = {}
) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as ContextEnrichRequest & { minimum_confidence?: number };
  const minimumConfidence =
    typeof body.minimum_confidence === "number" && Number.isFinite(body.minimum_confidence)
      ? clamp(body.minimum_confidence, 0, 1)
      : 0.45;
  const task = body.task && typeof body.task === "object" ? body.task : {};
  const projectId = parseOptionalString(body.project_id ?? body.projectId, "project_id", 128);
  const businessCategoryId = parseOptionalString(body.business_category_id, "business_category_id", 128);
  const workType = body.work_type ?? null;
  const { response, policyContext: context } = await assembleContext(
    env,
    {
      ...body,
      includeConflicts: true,
      includeProvenance: true,
      authorityScoring: true,
      verificationView: true
    },
    options
  );
  const confidence = Number(context.confidence ?? 0);
  const conflicts = Array.isArray(context.conflicts) ? context.conflicts : [];
  const unresolvedConflict = conflicts.some(
    (conflict) => conflict.severity === "high" && conflict.requiresHumanReview === true
  );
  const conflictingDecisionIds = new Set(conflicts.flatMap((conflict) => [
    conflict.preferredMemoryId,
    ...(conflict.conflictingMemoryIds ?? [])
  ].filter((id): id is string => Boolean(id))));
  const now = Date.now();
  const decisionContext = context.decisionContext ?? [];
  const isPolicyDecision = (decision: (typeof decisionContext)[number]) => {
    const policyText = `${decision.decision ?? ""}\n${(decision.constraints ?? []).join("\n")}`;
    return /\b(?:must not|never|prohibited|forbidden|do not|required|must)\b|(?:禁止|してはいけない|不可|必須|必ず)/iu.test(policyText);
  };
  const policyDecisions = decisionContext.filter(isPolicyDecision);
  const blockingDecisions = decisionContext.filter((decision) => {
    const policyText = `${decision.decision ?? ""}\n${(decision.constraints ?? []).join("\n")}`;
    if (!isPolicyDecision(decision)) return false;
    if (decision.status !== "active") return false;
    if (decision.validFrom && decision.validFrom > now) return false;
    if (decision.validUntil && decision.validUntil <= now) return false;
    if (decision.id && conflictingDecisionIds.has(decision.id)) return false;
    if (projectId && decision.projectId !== projectId) return false;
    if (businessCategoryId && decision.businessCategoryId !== businessCategoryId) return false;
    if (workType && decision.workType !== workType) return false;
    const state = decision.confirmationState;
    if (state === "user_confirmed" || state === "user_corrected" || state === "reviewed") {
      return Number(decision.confidence ?? 0) >= minimumConfidence;
    }
    if (state !== "inferred_unconfirmed" || env.ORGBRAIN_UNCONFIRMED_DECISION_BLOCKING !== "on") return false;
    const threshold = Math.max(0.9, minimumConfidence);
    const explicit = /\b(?:decided|decision|must|must not|required|prohibited|forbidden|never|always|will use)\b|(?:決定|採用|方針|必須|禁止|不可|制約|必ず)/iu.test(policyText);
    const sameScope = Boolean(projectId) && Boolean(businessCategoryId) &&
      decision.projectId === projectId && decision.businessCategoryId === businessCategoryId;
    const sourceBacked = (decision.sources ?? []).some(durableAutoDecisionSource);
    return Number(decision.confidence ?? 0) >= threshold &&
      explicit && Boolean(decision.rationale?.trim()) && sameScope && sourceBacked;
  });
  const blockingDecisionIds = new Set(blockingDecisions.map((decision) => decision.id).filter(Boolean));
  const reviewOnlyDecisionIds = policyDecisions
    .filter((decision) => !decision.id || !blockingDecisionIds.has(decision.id))
    .filter((decision) => decision.confirmationState === "inferred_unconfirmed" ||
      decision.status !== "active" ||
      Boolean(decision.validFrom && decision.validFrom > now) ||
      Boolean(decision.validUntil && decision.validUntil <= now) ||
      Boolean(decision.id && conflictingDecisionIds.has(decision.id)))
    .map((decision) => decision.id)
    .filter((id): id is string => Boolean(id));
  const reasons: string[] = [];
  if (unresolvedConflict) reasons.push("conflicting active decisions require human resolution");
  if (blockingDecisions.length > 0) reasons.push("an eligible decision memory contains a relevant requirement or prohibition");
  if (reviewOnlyDecisionIds.length > 0) reasons.push("a relevant decision requires review before it can block");
  if (confidence < minimumConfidence) reasons.push(`confidence ${confidence.toFixed(3)} is below ${minimumConfidence.toFixed(3)}`);
  if (decisionContext.length === 0) reasons.push("no relevant decision memory was found");
  if (context.requiresHumanReview && reasons.length === 0) reasons.push("selected decision memory requires human review");
  const outcome = blockingDecisions.length > 0
    ? "block"
    : unresolvedConflict || reviewOnlyDecisionIds.length > 0 || context.requiresHumanReview || confidence < minimumConfidence
      ? "review"
      : "allow";

  return {
    outcome,
    allowed: outcome === "allow",
    reasons,
    policy: {
      minimum_confidence: minimumConfidence,
      inferred_unconfirmed_block_threshold: Math.max(0.9, minimumConfidence),
      unconfirmed_blocking_enabled: env.ORGBRAIN_UNCONFIRMED_DECISION_BLOCKING === "on",
      block_on_high_conflict: false,
      fail_open_on_missing_context: false
    },
      context: {
        ...response,
      blocking_decision_memory_ids: [...blockingDecisionIds],
      review_decision_memory_ids: reviewOnlyDecisionIds
      }
  };
}

