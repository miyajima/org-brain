import { HttpError, collapseWhitespace, ulid } from "@org-brain/shared";
import type { Env } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 6000;
const DEFAULT_SEARCH_LIMIT = 8;

const TASK_TYPES = ["implementation", "review", "debug", "proposal", "support"] as const;
const DECISION_DOMAINS = ["engineering", "sales", "cs", "ops", "finance", "general"] as const;
const DECISION_STATUSES = ["active", "deprecated", "superseded", "uncertain"] as const;
const VISIBILITIES = ["tenant", "project", "restricted"] as const;

const DEFAULT_SOURCE_AUTHORITY: Record<string, number> = {
  current_code: 1.0,
  merged_pr: 0.95,
  adr: 0.9,
  issue_final_comment: 0.82,
  incident_postmortem: 0.8,
  official_doc: 0.75,
  slack_thread: 0.55,
  old_readme: 0.45,
  unknown: 0.3
};

export type TaskType = (typeof TASK_TYPES)[number];
type DecisionDomain = (typeof DECISION_DOMAINS)[number];
type DecisionStatus = (typeof DECISION_STATUSES)[number];
type DecisionVisibility = (typeof VISIBILITIES)[number];

type SourceRef = {
  type?: string;
  id?: string;
  title?: string;
  url?: string;
  updatedAt?: string;
  allowedPrincipals?: string[];
};

type OwnerRef = {
  type?: string;
  id?: string;
  name?: string;
};

type RejectedAlternative = {
  alternative: string;
  reasonRejected: string;
};

type DecisionMemoryRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  domain: string;
  title: string;
  decision: string;
  rationale: string;
  rejected_alternatives_json: string | null;
  constraints_json: string | null;
  known_pitfalls_json: string | null;
  source_refs_json: string | null;
  owner_refs_json: string | null;
  valid_from: number | null;
  valid_until: number | null;
  status: string;
  superseded_by: string | null;
  confidence: number | null;
  visibility: string | null;
  allowed_principals_json: string | null;
  created_at: number;
  updated_at: number;
};

type DecisionMemory = {
  id: string;
  tenantId: string;
  projectId: string | null;
  domain: DecisionDomain;
  title: string;
  decision: string;
  rationale: string;
  rejectedAlternatives: RejectedAlternative[];
  constraints: string[];
  knownPitfalls: string[];
  sourceRefs: SourceRef[];
  ownerRefs: OwnerRef[];
  validFrom: number | null;
  validUntil: number | null;
  status: DecisionStatus;
  supersededBy: string | null;
  confidence: number;
  visibility: DecisionVisibility;
  allowedPrincipals: string[];
  createdAt: number;
  updatedAt: number;
};

export type ContextScoreBreakdown = {
  semanticRelevance: number;
  recency: number;
  sourceAuthority: number;
  sourceProximity: number;
  taskSpecificity: number;
  permissionFit: number;
  conflictPenalty: number;
  stalenessPenalty: number;
  finalScore: number;
};

type ScoredDecisionMemory = {
  memory: DecisionMemory;
  score: ContextScoreBreakdown;
};

type ContextEnrichRequest = {
  orgId?: string;
  tenant_id?: string;
  projectId?: string | null;
  project_id?: string | null;
  agentId?: string;
  agent_id?: string;
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
};

type DecisionMemoryCreateRequest = {
  orgId?: string;
  tenant_id?: string;
  projectId?: string | null;
  project_id?: string | null;
  domain?: DecisionDomain;
  title?: string;
  decision?: string;
  rationale?: string;
  rejectedAlternatives?: RejectedAlternative[];
  rejected_alternatives?: RejectedAlternative[];
  constraints?: string[];
  knownPitfalls?: string[];
  known_pitfalls?: string[];
  sourceRefs?: SourceRef[];
  source_refs?: SourceRef[];
  ownerRefs?: OwnerRef[];
  owner_refs?: OwnerRef[];
  validFrom?: string | number | null;
  valid_from?: string | number | null;
  validUntil?: string | number | null;
  valid_until?: string | number | null;
  status?: DecisionStatus;
  supersededBy?: string | null;
  superseded_by?: string | null;
  confidence?: number;
  visibility?: DecisionVisibility;
  allowedPrincipals?: string[];
  allowed_principals?: string[];
};

type DecisionMemorySearchRequest = {
  orgId?: string;
  tenant_id?: string;
  projectId?: string | null;
  project_id?: string | null;
  q?: string;
  limit?: number;
  userId?: string;
  user_id?: string;
  agentId?: string;
  agent_id?: string;
};

function parseRequiredString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  return trimmed.slice(0, maxLength);
}

function parseOptionalString(value: unknown, field: string, maxLength = 256): string | null {
  if (value === undefined || value === null) return null;
  return parseRequiredString(value, field, maxLength);
}

function parseOptionalBoolean(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_payload", `${field} must be a boolean`);
  return value;
}

function parseOptionalInteger(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be an integer`);
  }
  if (value < min || value > max) throw new HttpError(400, "invalid_payload", `${field} must be between ${min} and ${max}`);
  return value;
}

function parseOptionalNumber(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be a finite number`);
  }
  if (value < min || value > max) throw new HttpError(400, "invalid_payload", `${field} must be between ${min} and ${max}`);
  return value;
}

function parseEnum<T extends readonly string[]>(value: unknown, field: string, allowed: T, fallback: T[number]): T[number] {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function parseStringArray(value: unknown, field: string, maxItems = 32, maxLength = 500): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_payload", `${field} must be an array`);
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, maxLength))
        .filter(Boolean)
    )
  ].slice(0, maxItems);
}

function parseTimestamp(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new HttpError(400, "invalid_payload", `${field} must be an ISO date string or timestamp`);
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function normalizeStatus(raw: unknown): DecisionStatus {
  return raw === "deprecated" || raw === "superseded" || raw === "uncertain" ? raw : "active";
}

function normalizeDomain(raw: unknown): DecisionDomain {
  return raw === "engineering" || raw === "sales" || raw === "cs" || raw === "ops" || raw === "finance" ? raw : "general";
}

function normalizeVisibility(raw: unknown): DecisionVisibility {
  return raw === "project" || raw === "restricted" ? raw : "tenant";
}

function toDecisionMemory(row: DecisionMemoryRow): DecisionMemory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    domain: normalizeDomain(row.domain),
    title: row.title,
    decision: row.decision,
    rationale: row.rationale,
    rejectedAlternatives: parseJsonArray<RejectedAlternative>(row.rejected_alternatives_json),
    constraints: parseJsonArray<string>(row.constraints_json),
    knownPitfalls: parseJsonArray<string>(row.known_pitfalls_json),
    sourceRefs: parseJsonArray<SourceRef>(row.source_refs_json),
    ownerRefs: parseJsonArray<OwnerRef>(row.owner_refs_json),
    validFrom: row.valid_from ?? null,
    validUntil: row.valid_until ?? null,
    status: normalizeStatus(row.status),
    supersededBy: row.superseded_by ?? null,
    confidence: clamp(Number(row.confidence ?? 0.5), 0, 1),
    visibility: normalizeVisibility(row.visibility),
    allowedPrincipals: parseJsonArray<string>(row.allowed_principals_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function tokenize(raw: string): string[] {
  return [
    ...new Set(
      collapseWhitespace(raw)
        .toLowerCase()
        .split(/[^a-z0-9一-龠ぁ-んァ-ヶ_#-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  ];
}

function semanticRelevance(memory: DecisionMemory, taskText: string): number {
  const taskTokens = tokenize(taskText);
  if (taskTokens.length === 0) return 0;
  const memoryText = `${memory.title} ${memory.decision} ${memory.rationale} ${memory.constraints.join(" ")} ${memory.knownPitfalls.join(" ")}`;
  const memoryTokens = new Set(tokenize(memoryText));
  const normalizedMemoryText = memoryText.toLowerCase();
  const hits = taskTokens.filter((token) => memoryTokens.has(token) || normalizedMemoryText.includes(token)).length;
  return clamp(hits / Math.min(taskTokens.length, 12), 0, 1);
}

function recencyScore(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, (now - updatedAt) / DAY_MS);
  if (ageDays <= 30) return 1;
  if (ageDays >= 365) return 0.15;
  return Number((1 - (ageDays - 30) / 400).toFixed(3));
}

function sourceAuthorityScore(sourceRefs: SourceRef[]): number {
  if (sourceRefs.length === 0) return DEFAULT_SOURCE_AUTHORITY.unknown;
  const scores = sourceRefs.map((source) => DEFAULT_SOURCE_AUTHORITY[source.type ?? "unknown"] ?? DEFAULT_SOURCE_AUTHORITY.unknown);
  return Math.max(...scores);
}

function taskSpecificityScore(memory: DecisionMemory, taskType: TaskType, targetFiles: string[]): number {
  let score = memory.domain === "engineering" && (taskType === "implementation" || taskType === "review" || taskType === "debug") ? 0.25 : 0.1;
  const fileText = targetFiles.join(" ").toLowerCase();
  const memoryText = `${memory.title} ${memory.decision} ${memory.rationale}`.toLowerCase();
  if (fileText && tokenize(fileText).some((token) => memoryText.includes(token))) score += 0.35;
  if (memory.constraints.length > 0) score += 0.2;
  if (memory.knownPitfalls.length > 0) score += 0.2;
  return clamp(score, 0, 1);
}

function sourceProximityScore(memory: DecisionMemory, projectId: string | null): number {
  if (projectId && memory.projectId === projectId) return 1;
  if (!memory.projectId) return 0.7;
  return 0.35;
}

function principalsFor(userId: string | null, agentId: string | null): string[] {
  return [userId, agentId, userId ? `user:${userId}` : null, agentId ? `agent:${agentId}` : null].filter((item): item is string => Boolean(item));
}

function canReadMemory(memory: DecisionMemory, userId: string | null, agentId: string | null): boolean {
  if (memory.visibility !== "restricted" && memory.allowedPrincipals.length === 0) return true;
  const principals = principalsFor(userId, agentId);
  return memory.allowedPrincipals.some((principal) => principals.includes(principal));
}

function filterSourceRefs(sourceRefs: SourceRef[], userId: string | null, agentId: string | null): SourceRef[] {
  const principals = principalsFor(userId, agentId);
  return sourceRefs.filter((source) => {
    if (!source.allowedPrincipals || source.allowedPrincipals.length === 0) return true;
    return source.allowedPrincipals.some((principal) => principals.includes(principal));
  });
}

function permissionFit(memory: DecisionMemory, userId: string | null, agentId: string | null): number {
  return canReadMemory(memory, userId, agentId) ? 1 : 0;
}

function statusPenalty(memory: DecisionMemory): number {
  if (memory.status === "active") return 0;
  if (memory.status === "uncertain") return 0.18;
  if (memory.status === "deprecated") return 0.35;
  return 0.45;
}

function stalenessPenalty(memory: DecisionMemory, now: number): number {
  if (memory.validUntil && memory.validUntil < now) return 0.5;
  const ageDays = Math.max(0, (now - memory.updatedAt) / DAY_MS);
  return ageDays > 365 ? 0.2 : 0;
}

export function scoreDecisionMemory(args: {
  memory: DecisionMemory;
  taskText: string;
  taskType: TaskType;
  targetFiles: string[];
  projectId: string | null;
  userId: string | null;
  agentId: string | null;
  conflictPenalty?: number;
  now?: number;
}): ContextScoreBreakdown {
  const now = args.now ?? Date.now();
  const semantic = semanticRelevance(args.memory, args.taskText);
  const recency = recencyScore(args.memory.updatedAt, now);
  const authority = sourceAuthorityScore(filterSourceRefs(args.memory.sourceRefs, args.userId, args.agentId));
  const proximity = sourceProximityScore(args.memory, args.projectId);
  const specificity = taskSpecificityScore(args.memory, args.taskType, args.targetFiles);
  const permission = permissionFit(args.memory, args.userId, args.agentId);
  const conflictPenalty = args.conflictPenalty ?? statusPenalty(args.memory);
  const stalePenalty = stalenessPenalty(args.memory, now);
  const finalScore = permission === 0
    ? 0
    : clamp(
        semantic * 0.28 +
          recency * 0.14 +
          authority * 0.2 +
          proximity * 0.12 +
          specificity * 0.16 +
          permission * 0.1 -
          conflictPenalty -
          stalePenalty,
        0,
        1
      );
  return {
    semanticRelevance: Number(semantic.toFixed(3)),
    recency: Number(recency.toFixed(3)),
    sourceAuthority: Number(authority.toFixed(3)),
    sourceProximity: Number(proximity.toFixed(3)),
    taskSpecificity: Number(specificity.toFixed(3)),
    permissionFit: Number(permission.toFixed(3)),
    conflictPenalty: Number(conflictPenalty.toFixed(3)),
    stalenessPenalty: Number(stalePenalty.toFixed(3)),
    finalScore: Number(finalScore.toFixed(3))
  };
}

function topicKey(memory: DecisionMemory): string {
  return collapseWhitespace(memory.title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim();
}

function compareScored(left: ScoredDecisionMemory, right: ScoredDecisionMemory): number {
  return right.score.finalScore - left.score.finalScore || right.memory.updatedAt - left.memory.updatedAt;
}

function detectConflicts(scored: ScoredDecisionMemory[], now: number) {
  const byTopic = new Map<string, ScoredDecisionMemory[]>();
  for (const item of scored) {
    const key = topicKey(item.memory);
    if (!key) continue;
    byTopic.set(key, [...(byTopic.get(key) ?? []), item]);
  }

  const conflicts = [];
  for (const [topic, items] of byTopic.entries()) {
    if (items.length < 2) continue;
    const hasInactive = items.some((item) => item.memory.status !== "active" || Boolean(item.memory.supersededBy) || Boolean(item.memory.validUntil && item.memory.validUntil < now));
    const hasActive = items.some((item) => item.memory.status === "active" && (!item.memory.validUntil || item.memory.validUntil >= now));
    if (!hasInactive || !hasActive) continue;
    const sorted = [...items].sort(compareScored);
    const preferred = sorted.find((item) => item.memory.status === "active" && (!item.memory.validUntil || item.memory.validUntil >= now)) ?? sorted[0];
    const conflicting = sorted.filter((item) => item.memory.id !== preferred.memory.id);
    conflicts.push({
      topic,
      preferredMemoryId: preferred.memory.id,
      conflictingMemoryIds: conflicting.map((item) => item.memory.id),
      preferredReason: "Active, current, higher-authority decision memory is preferred over deprecated, superseded, or expired context.",
      severity: conflicting.some((item) => item.memory.status === "active") ? "high" : "medium",
      requiresHumanReview: conflicting.some((item) => item.memory.status === "active")
    });
  }
  return conflicts;
}

function buildTaskText(task: { title?: string; description?: string; relatedIssueIds?: string[]; related_issue_ids?: string[] }): string {
  return collapseWhitespace(`${task.title ?? ""} ${task.description ?? ""} ${(task.relatedIssueIds ?? task.related_issue_ids ?? []).join(" ")}`);
}

function parseEnrichRequest(rawBody: unknown) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as ContextEnrichRequest;
  const task = body.task;
  if (!task || typeof task !== "object") throw new HttpError(400, "invalid_payload", "task is required");
  const taskTitle = parseOptionalString(task.title, "task.title", 240);
  const taskDescription = parseOptionalString(task.description, "task.description", 2000);
  const taskText = buildTaskText({ ...task, title: taskTitle ?? "", description: taskDescription ?? "" });
  if (!taskText) throw new HttpError(400, "invalid_payload", "task title or description is required");
  return {
    tenantId: parseOptionalString(body.orgId ?? body.tenant_id, "orgId", 128) ?? "default",
    projectId: parseOptionalString(body.projectId ?? body.project_id, "projectId", 128),
    agentId: parseOptionalString(body.agentId ?? body.agent_id, "agentId", 128),
    userId: parseOptionalString(body.userId ?? body.user_id, "userId", 128),
    taskType: parseEnum(body.taskType ?? body.task_type, "taskType", TASK_TYPES, "implementation"),
    taskTitle: taskTitle ?? "",
    taskDescription: taskDescription ?? "",
    taskText,
    targetFiles: parseStringArray(task.targetFiles ?? task.target_files, "task.targetFiles", 32, 256),
    maxTokens: parseOptionalInteger(body.maxTokens ?? body.max_tokens, "maxTokens", DEFAULT_MAX_TOKENS, 500, 32000),
    includeSources: parseOptionalBoolean(body.includeSources ?? body.include_sources, "includeSources", true),
    includeConflicts: parseOptionalBoolean(body.includeConflicts ?? body.include_conflicts, "includeConflicts", true),
    debugScores: parseOptionalBoolean(body.debugScores ?? body.debug_scores, "debugScores", false)
  };
}

function parseCreateDecisionRequest(rawBody: unknown): DecisionMemory {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as DecisionMemoryCreateRequest;
  const now = Date.now();
  return {
    id: ulid(now),
    tenantId: parseOptionalString(body.orgId ?? body.tenant_id, "orgId", 128) ?? "default",
    projectId: parseOptionalString(body.projectId ?? body.project_id, "projectId", 128),
    domain: parseEnum(body.domain, "domain", DECISION_DOMAINS, "general"),
    title: parseRequiredString(body.title, "title", 240),
    decision: parseRequiredString(body.decision, "decision", 1000),
    rationale: parseRequiredString(body.rationale, "rationale", 2000),
    rejectedAlternatives: ((body.rejectedAlternatives ?? body.rejected_alternatives ?? []) as RejectedAlternative[]).slice(0, 16),
    constraints: parseStringArray(body.constraints, "constraints", 32, 500),
    knownPitfalls: parseStringArray(body.knownPitfalls ?? body.known_pitfalls, "knownPitfalls", 32, 500),
    sourceRefs: ((body.sourceRefs ?? body.source_refs ?? []) as SourceRef[]).slice(0, 16),
    ownerRefs: ((body.ownerRefs ?? body.owner_refs ?? []) as OwnerRef[]).slice(0, 16),
    validFrom: parseTimestamp(body.validFrom ?? body.valid_from, "validFrom"),
    validUntil: parseTimestamp(body.validUntil ?? body.valid_until, "validUntil"),
    status: parseEnum(body.status, "status", DECISION_STATUSES, "active"),
    supersededBy: parseOptionalString(body.supersededBy ?? body.superseded_by, "supersededBy", 128),
    confidence: parseOptionalNumber(body.confidence, "confidence", 0.5, 0, 1),
    visibility: parseEnum(body.visibility, "visibility", VISIBILITIES, "tenant"),
    allowedPrincipals: parseStringArray(body.allowedPrincipals ?? body.allowed_principals, "allowedPrincipals", 64, 128),
    createdAt: now,
    updatedAt: now
  };
}

function parseSearchDecisionRequest(rawBody: unknown) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as DecisionMemorySearchRequest;
  return {
    tenantId: parseOptionalString(body.orgId ?? body.tenant_id, "orgId", 128) ?? "default",
    projectId: parseOptionalString(body.projectId ?? body.project_id, "projectId", 128),
    q: parseOptionalString(body.q, "q", 500) ?? "",
    limit: parseOptionalInteger(body.limit, "limit", DEFAULT_SEARCH_LIMIT, 1, 50),
    userId: parseOptionalString(body.userId ?? body.user_id, "userId", 128),
    agentId: parseOptionalString(body.agentId ?? body.agent_id, "agentId", 128)
  };
}

async function loadDecisionMemories(env: Env, args: { tenantId: string; projectId: string | null; q: string; limit: number }): Promise<DecisionMemory[]> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, domain, title, decision, rationale,
            rejected_alternatives_json, constraints_json, known_pitfalls_json, source_refs_json, owner_refs_json,
            valid_from, valid_until, status, superseded_by, confidence, visibility, allowed_principals_json,
            created_at, updated_at
     FROM decision_memories
     WHERE tenant_id = ?
       AND (? IS NULL OR project_id = ? OR project_id IS NULL)
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(args.tenantId, args.projectId, args.projectId, Math.max(args.limit, 64))
    .all<DecisionMemoryRow>();
  const memories = result.results.map(toDecisionMemory);
  const queryTokens = tokenize(args.q);
  if (queryTokens.length === 0) return memories.slice(0, args.limit);
  const matched = memories.filter((memory) => semanticRelevance(memory, args.q) > 0);
  return (matched.length > 0 ? matched : memories).slice(0, args.limit);
}

function toPublicDecisionContext(item: ScoredDecisionMemory, includeSources: boolean, userId: string | null, agentId: string | null, debugScores: boolean) {
  return {
    id: item.memory.id,
    title: item.memory.title,
    decision: item.memory.decision,
    rationale: item.memory.rationale,
    status: item.memory.status,
    confidence: item.memory.confidence,
    sources: includeSources ? filterSourceRefs(item.memory.sourceRefs, userId, agentId) : undefined,
    score: debugScores ? item.score : undefined
  };
}

function trimToMaxTokens(response: Record<string, unknown>, maxTokens: number): Record<string, unknown> {
  const trimmed = response;
  const decisionContext = Array.isArray(trimmed.decisionContext) ? trimmed.decisionContext : [];
  const knownPitfalls = Array.isArray(trimmed.knownPitfalls) ? trimmed.knownPitfalls : [];
  const constraints = Array.isArray(trimmed.constraints) ? trimmed.constraints : [];
  const nextActions = Array.isArray(trimmed.recommendedNextActions) ? trimmed.recommendedNextActions : [];

  while (estimateTokens(trimmed) > maxTokens && knownPitfalls.length > 1) knownPitfalls.pop();
  while (estimateTokens(trimmed) > maxTokens && nextActions.length > 1) nextActions.pop();
  while (estimateTokens(trimmed) > maxTokens && constraints.length > 1) constraints.pop();
  while (estimateTokens(trimmed) > maxTokens && decisionContext.length > 1) decisionContext.pop();
  if (estimateTokens(trimmed) > maxTokens) {
    trimmed.summary = String(trimmed.summary ?? "").slice(0, Math.max(80, maxTokens * 2));
  }
  return trimmed;
}

export async function createDecisionMemory(env: Env, rawBody: unknown) {
  const memory = parseCreateDecisionRequest(rawBody);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO decision_memories(
       id, tenant_id, project_id, domain, title, decision, rationale,
       rejected_alternatives_json, constraints_json, known_pitfalls_json, source_refs_json, owner_refs_json,
       valid_from, valid_until, status, superseded_by, confidence, visibility, allowed_principals_json,
       created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      memory.id,
      memory.tenantId,
      memory.projectId,
      memory.domain,
      memory.title,
      memory.decision,
      memory.rationale,
      JSON.stringify(memory.rejectedAlternatives),
      JSON.stringify(memory.constraints),
      JSON.stringify(memory.knownPitfalls),
      JSON.stringify(memory.sourceRefs),
      JSON.stringify(memory.ownerRefs),
      memory.validFrom,
      memory.validUntil,
      memory.status,
      memory.supersededBy,
      memory.confidence,
      memory.visibility,
      JSON.stringify(memory.allowedPrincipals),
      memory.createdAt,
      memory.updatedAt
    )
    .run();
  return { decisionMemory: memory };
}

export async function searchDecisionMemories(env: Env, rawBody: unknown) {
  const request = parseSearchDecisionRequest(rawBody);
  const memories = await loadDecisionMemories(env, request);
  const visible = memories.filter((memory) => canReadMemory(memory, request.userId, request.agentId));
  const scored = visible
    .map((memory) => ({
      memory,
      score: scoreDecisionMemory({
        memory,
        taskText: request.q,
        taskType: "implementation",
        targetFiles: [],
        projectId: request.projectId,
        userId: request.userId,
        agentId: request.agentId
      })
    }))
    .sort(compareScored)
    .slice(0, request.limit);
  return {
    tenant_id: request.tenantId,
    project_id: request.projectId,
    q: request.q,
    results: scored.map((item) => ({
      ...item.memory,
      sourceRefs: filterSourceRefs(item.memory.sourceRefs, request.userId, request.agentId),
      score: item.score
    }))
  };
}

export async function enrichContext(env: Env, rawBody: unknown) {
  const request = parseEnrichRequest(rawBody);
  const memories = await loadDecisionMemories(env, {
    tenantId: request.tenantId,
    projectId: request.projectId,
    q: request.taskText,
    limit: 24
  });
  const visibleMemories = memories.filter((memory) => canReadMemory(memory, request.userId, request.agentId));
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
  const selected = scored.slice(0, 8);
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

  const response = trimToMaxTokens(
    {
      summary: top
        ? `このタスクでは「${top.memory.title}」の判断を優先してください: ${top.memory.decision}`
        : "このタスクに十分関連するdecision memoryは見つかりませんでした。",
      decisionContext: selected.map((item) => toPublicDecisionContext(item, request.includeSources, request.userId, request.agentId, request.debugScores)),
      constraints,
      knownPitfalls,
      conflicts,
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
        conflictCount: conflicts.length,
        estimatedTokens: 0
      }
    },
    request.maxTokens
  );
  const meta = response.meta as { estimatedTokens?: number } | undefined;
  if (meta) meta.estimatedTokens = estimateTokens(response);
  return response;
}
