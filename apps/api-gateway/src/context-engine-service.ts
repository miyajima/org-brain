import { HttpError, collapseWhitespace, sha256, ulid, type MemoryWorkType } from "@org-brain/shared";
import { buildAuthzContext, loadReadableResourceIds } from "./authz-service";
import { screenMemoryWriteText, screenOptionalMemoryWriteText } from "./memory-screening-service";
import type { Env } from "./types";
import { validateBusinessClassification } from "./business-category-service";
import { recordMemoryUsage } from "./memory-effect-service";
import { resolveRetrievalGenerationAssignment } from "./retrieval-generation-service";
import { resolveAgentLoadoutContext } from "./agent-loadout-service";
import { ensureAccessPolicy } from "./access-policy-service";

const DAY_MS = 24 * 60 * 60 * 1000;
const INFERRED_DECISION_TTL_MS = 180 * DAY_MS;
const DEFAULT_MAX_TOKENS = 6000;
const DEFAULT_SEARCH_LIMIT = 8;

const TASK_TYPES = ["implementation", "review", "debug", "proposal", "support"] as const;
const DECISION_DOMAINS = ["engineering", "sales", "cs", "ops", "finance", "general"] as const;
const DECISION_STATUSES = ["active", "deprecated", "superseded", "uncertain"] as const;
const VISIBILITIES = ["tenant", "project", "restricted"] as const;
const CONFIRMATION_STATES = ["draft", "inferred_unconfirmed", "user_confirmed", "user_corrected", "reviewed"] as const;

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
type ConfirmationState = (typeof CONFIRMATION_STATES)[number];

export type SourceRef = {
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
  reviewer_refs_json: string | null;
  valid_from: number | null;
  valid_until: number | null;
  status: string;
  superseded_by: string | null;
  confidence: number | null;
  visibility: string | null;
  allowed_principals_json: string | null;
  confirmation_state: string | null;
  confirmation_note: string | null;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
  business_category_id: string | null;
  work_type: MemoryWorkType | null;
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
  reviewerRefs: OwnerRef[];
  validFrom: number | null;
  validUntil: number | null;
  status: DecisionStatus;
  supersededBy: string | null;
  confidence: number;
  visibility: DecisionVisibility;
  allowedPrincipals: string[];
  confirmationState: ConfirmationState;
  confirmationNote: string | null;
  confirmedAt: number | null;
  createdAt: number;
  updatedAt: number;
  businessCategoryId: string | null;
  workType: MemoryWorkType | null;
};

type DecisionMemoryVersionRow = {
  id: string;
  decision_memory_id: string;
  tenant_id: string;
  operation: string;
  snapshot_json: string;
  actor_refs_json: string | null;
  reviewer_refs_json: string | null;
  note: string | null;
  created_at: number;
};

type DecisionMemoryVersion = {
  id: string;
  decisionMemoryId: string;
  tenantId: string;
  operation: string;
  snapshot: Record<string, unknown>;
  actorRefs: OwnerRef[];
  reviewerRefs: OwnerRef[];
  note: string | null;
  createdAt: number;
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
  reviewerRefs?: OwnerRef[];
  reviewer_refs?: OwnerRef[];
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
  confirmationState?: ConfirmationState;
  confirmation_state?: ConfirmationState;
  confirmationNote?: string | null;
  confirmation_note?: string | null;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
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
  personId?: string;
  person_id?: string;
  reviewerId?: string;
  reviewer_id?: string;
  confirmationState?: ConfirmationState;
  confirmation_state?: ConfirmationState;
  validAt?: string | number | null;
  valid_at?: string | number | null;
  hasConflicts?: boolean;
  has_conflicts?: boolean;
  taskContext?: string;
  task_context?: string;
  includeProvenance?: boolean;
  include_provenance?: boolean;
  authorityScoring?: boolean;
  authority_scoring?: boolean;
  verificationView?: boolean;
  verification_view?: boolean;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
  generation_id?: string | null;
  ranking_profile_id?: string | null;
  task_id?: string | null;
  trace_id?: string | null;
  external_run_id?: string | null;
};

type DecisionMemoryReviseRequest = Partial<DecisionMemoryCreateRequest> & {
  note?: string;
  actorRefs?: OwnerRef[];
  actor_refs?: OwnerRef[];
};

type DecisionMemoryConfirmRequest = {
  orgId?: string;
  tenant_id?: string;
  reviewerRefs?: OwnerRef[];
  reviewer_refs?: OwnerRef[];
  confirmationState?: ConfirmationState;
  confirmation_state?: ConfirmationState;
  confirmationNote?: string | null;
  confirmation_note?: string | null;
  confidenceDelta?: number;
  confidence_delta?: number;
  confidence?: number;
  validFrom?: string | number | null;
  valid_from?: string | number | null;
  validUntil?: string | number | null;
  valid_until?: string | number | null;
};

type PrincipalIdentityOptions = {
  principal?: string | null;
  recordUsage?: boolean;
  bestEffortUsage?: boolean;
  autoOrigin?: {
    memoryId: string | null;
    source: string;
    externalKey: string;
  };
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

function parseOptionalEnum<T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] | null {
  if (value === undefined || value === null || value === "") return null;
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

function parseOptionalTimestamp(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  return parseTimestamp(value, field);
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

function parseOwnerRefs(value: unknown, field: string, maxItems = 16): OwnerRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_payload", `${field} must be an array`);
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      type: typeof item.type === "string" ? item.type.slice(0, 64) : undefined,
      id: typeof item.id === "string" ? item.id.slice(0, 128) : undefined,
      name: typeof item.name === "string" ? item.name.slice(0, 160) : undefined
    }))
    .filter((item) => Boolean(item.id || item.name))
    .slice(0, maxItems);
}

function parseSourceRefs(value: unknown, field: string, maxItems = 16): SourceRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_payload", `${field} must be an array`);
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      type: typeof item.type === "string" ? item.type.slice(0, 80) : undefined,
      id: typeof item.id === "string" ? item.id.slice(0, 160) : undefined,
      title: typeof item.title === "string" ? item.title.slice(0, 240) : undefined,
      url: typeof item.url === "string" ? item.url.slice(0, 500) : undefined,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt.slice(0, 80) : undefined,
      allowedPrincipals: Array.isArray(item.allowedPrincipals)
        ? item.allowedPrincipals.filter((principal): principal is string => typeof principal === "string").slice(0, 32)
        : undefined
    }))
    .filter((item) => Boolean(item.type || item.id || item.title || item.url))
    .slice(0, maxItems);
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

function normalizeConfirmationState(raw: unknown): ConfirmationState {
  if (raw === "draft" || raw === "user_confirmed" || raw === "user_corrected" || raw === "reviewed") return raw;
  return "inferred_unconfirmed";
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
    reviewerRefs: parseJsonArray<OwnerRef>(row.reviewer_refs_json),
    validFrom: row.valid_from ?? null,
    validUntil: row.valid_until ?? null,
    status: normalizeStatus(row.status),
    supersededBy: row.superseded_by ?? null,
    confidence: clamp(Number(row.confidence ?? 0.5), 0, 1),
    visibility: normalizeVisibility(row.visibility),
    allowedPrincipals: parseJsonArray<string>(row.allowed_principals_json),
    confirmationState: normalizeConfirmationState(row.confirmation_state),
    confirmationNote: row.confirmation_note ?? null,
    confirmedAt: row.confirmed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    businessCategoryId: row.business_category_id ?? null,
    workType: row.work_type ?? null
  };
}

function toDecisionMemoryVersion(row: DecisionMemoryVersionRow): DecisionMemoryVersion {
  let snapshot: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.snapshot_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) snapshot = parsed as Record<string, unknown>;
  } catch {
    snapshot = {};
  }
  return {
    id: row.id,
    decisionMemoryId: row.decision_memory_id,
    tenantId: row.tenant_id,
    operation: row.operation,
    snapshot,
    actorRefs: parseJsonArray<OwnerRef>(row.actor_refs_json),
    reviewerRefs: parseJsonArray<OwnerRef>(row.reviewer_refs_json),
    note: row.note ?? null,
    createdAt: row.created_at
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

function normalizePrincipal(principal: string | null | undefined): string | null {
  const trimmed = principal?.trim();
  return trimmed ? trimmed.slice(0, 128) : null;
}

function principalOwnerRef(principal: string): OwnerRef {
  return { type: "principal", id: principal, name: principal };
}

function ensurePrincipalOwner(ownerRefs: OwnerRef[], principal: string | null): OwnerRef[] {
  if (!principal) return ownerRefs;
  if (ownerRefs.some((ref) => ref.id === principal)) return ownerRefs;
  return [principalOwnerRef(principal), ...ownerRefs].slice(0, 16);
}

function ensurePrincipalAllowed(allowedPrincipals: string[], principal: string | null): string[] {
  if (!principal) return allowedPrincipals;
  return [...new Set([principal, ...allowedPrincipals])].slice(0, 64);
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

async function filterReadableDecisionMemories(
  env: Env,
  tenantId: string,
  memories: DecisionMemory[],
  userId: string | null,
  agentId: string | null,
  principal?: string | null
): Promise<DecisionMemory[]> {
  const direct = memories.filter((memory) => canReadMemory(memory, userId, agentId));
  const directIds = new Set(direct.map((memory) => memory.id));
  const needsAcl = memories.filter((memory) => !directIds.has(memory.id) && memory.visibility === "restricted");
  const normalizedPrincipal = normalizePrincipal(principal);
  if (!normalizedPrincipal || needsAcl.length === 0) return direct;
  const authz = await buildAuthzContext(env, tenantId, normalizedPrincipal);
  const allowedIds = await loadReadableResourceIds(env, {
    tenantId,
    resourceType: "decision_memory",
    resourceIds: needsAcl.map((memory) => memory.id),
    authz
  });
  return memories
    .filter((memory) => directIds.has(memory.id) || allowedIds.has(memory.id))
    .map((memory) =>
      allowedIds.has(memory.id)
        ? { ...memory, allowedPrincipals: ensurePrincipalAllowed(memory.allowedPrincipals, normalizedPrincipal) }
        : memory
    );
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

export function normalizeDecisionTopic(title: string): string {
  return collapseWhitespace(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim();
}

function topicKey(memory: DecisionMemory): string {
  return normalizeDecisionTopic(memory.title);
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

function parseEnrichRequest(rawBody: unknown, principal?: string | null) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as ContextEnrichRequest;
  const requestPrincipal = normalizePrincipal(principal);
  const task = body.task;
  if (!task || typeof task !== "object") throw new HttpError(400, "invalid_payload", "task is required");
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

type DecisionRetrievalGeneration = {
  id: string;
  unit_schema_version: number;
  extractor_name: string;
  extractor_version: string;
  embedding_profile_id: string | null;
  ranking_profile_id: string;
  ranking_algorithm: string;
  ranking_config: Record<string, number>;
  shadow_generation_id: string | null;
  shadow_sample_rate: number;
};

function parseRankingConfig(raw: string): Record<string, number> {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])
      )
    );
  } catch {
    throw new HttpError(500, "invalid_ranking_profile_config", "ranking profile config is invalid");
  }
}

function shouldRunDecisionShadow(rate: number, sampleKey: string) {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  let hash = 2166136261;
  for (let index = 0; index < sampleKey.length; index += 1) {
    hash ^= sampleKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000 < rate;
}

async function resolveDecisionRetrievalGeneration(
  env: Env,
  request: ReturnType<typeof parseSearchDecisionRequest>
): Promise<DecisionRetrievalGeneration | null> {
  if (
    !request.generationId &&
    !request.rankingProfileId &&
    (!env.RETRIEVAL_GENERATION_ROUTING || env.RETRIEVAL_GENERATION_ROUTING === "legacy")
  ) {
    return null;
  }
  try {
    const assignment = await resolveRetrievalGenerationAssignment(env, request.tenantId, request.projectId);
    const generationId = request.generationId ?? assignment.active_generation_id;
    if (generationId !== assignment.active_generation_id && generationId !== assignment.shadow_generation_id) {
      throw new HttpError(403, "generation_not_assigned", "requested generation is not assigned to tenant/project");
    }
    const generationRow = await env.OPEN_BRAIN_DB.prepare(
      `SELECT g.id, g.unit_schema_version, g.extractor_name, g.extractor_version,
              g.embedding_profile_id, g.ranking_profile_id,
              p.algorithm AS ranking_algorithm, p.config_json AS ranking_config_json
       FROM retrieval_generations g
       JOIN retrieval_ranking_profiles p ON p.id = g.ranking_profile_id AND p.retired_at IS NULL
       WHERE g.id = ?`
    ).bind(generationId).first<Omit<DecisionRetrievalGeneration, "ranking_config" | "shadow_generation_id" | "shadow_sample_rate"> & {
      ranking_config_json: string;
    }>();
    if (!generationRow) throw new HttpError(404, "retrieval_generation_not_found", "generation or ranking profile not found");
    const generation: DecisionRetrievalGeneration = {
      ...generationRow,
      ranking_config: parseRankingConfig(generationRow.ranking_config_json),
      shadow_generation_id: null,
      shadow_sample_rate: 0
    };
    if (request.rankingProfileId) {
      const ranking = await env.OPEN_BRAIN_DB.prepare(
        "SELECT id, algorithm, config_json FROM retrieval_ranking_profiles WHERE id = ? AND retired_at IS NULL"
      ).bind(request.rankingProfileId).first<{ id: string; algorithm: string; config_json: string }>();
      if (!ranking) throw new HttpError(404, "retrieval_ranking_profile_not_found", "ranking profile not found or retired");
      generation.ranking_profile_id = ranking.id;
      generation.ranking_algorithm = ranking.algorithm;
      generation.ranking_config = parseRankingConfig(ranking.config_json);
    }
    return {
      ...generation,
      shadow_generation_id: request.generationId ? null : assignment.shadow_generation_id,
      shadow_sample_rate: request.generationId ? 0 : assignment.shadow_sample_rate
    };
  } catch (error) {
    if (!request.generationId && env.RETRIEVAL_GENERATION_ROUTING === "observe") return null;
    throw error;
  }
}

async function stableDecisionCandidateIds(
  env: Env,
  request: ReturnType<typeof parseSearchDecisionRequest>,
  generationId: string,
  query: string
) {
  const tokens = [...new Set(tokenize(query))].slice(0, 16);
  const bindings: unknown[] = [generationId, request.tenantId];
  const projectSql = request.projectId ? " AND (u.project_id = ? OR u.project_id IS NULL)" : "";
  const categorySql = request.businessCategoryId ? " AND u.business_category_id = ?" : "";
  const workSql = request.workType ? " AND u.work_type = ?" : "";
  if (tokens.length) bindings.push(tokens.map((token) => `"${token.replaceAll('"', '')}"*`).join(" AND "));
  if (request.projectId) bindings.push(request.projectId);
  if (request.businessCategoryId) bindings.push(request.businessCategoryId);
  if (request.workType) bindings.push(request.workType);
  const result = tokens.length
    ? await env.OPEN_BRAIN_DB.prepare(
      `SELECT u.source_id
       FROM retrieval_units_fts
       JOIN retrieval_units u
         ON u.id = retrieval_units_fts.unit_id
        AND u.generation_id = retrieval_units_fts.generation_id
        AND u.tenant_id = retrieval_units_fts.tenant_id
       WHERE u.generation_id = ? AND u.tenant_id = ?
         AND u.source_type = 'decision_memory' AND retrieval_units_fts MATCH ?
         ${projectSql}${categorySql}${workSql}
       ORDER BY bm25(retrieval_units_fts), u.created_at DESC LIMIT 200`
    ).bind(...bindings).all<{ source_id: string }>()
    : await env.OPEN_BRAIN_DB.prepare(
      `SELECT u.source_id FROM retrieval_units u
       WHERE u.generation_id = ? AND u.tenant_id = ? AND u.source_type = 'decision_memory'
         ${projectSql}${categorySql}${workSql}
       ORDER BY u.created_at DESC LIMIT 200`
    ).bind(...bindings).all<{ source_id: string }>();
  return [...new Set(result.results.map((row) => row.source_id))];
}

function parseCreateDecisionRequest(rawBody: unknown, principal?: string | null): DecisionMemory {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as DecisionMemoryCreateRequest;
  const now = Date.now();
  const requestPrincipal = normalizePrincipal(principal);
  const visibility = parseEnum(body.visibility, "visibility", VISIBILITIES, "tenant");
  const confirmationState = parseEnum(
    body.confirmationState ?? body.confirmation_state,
    "confirmationState",
    CONFIRMATION_STATES,
    "inferred_unconfirmed"
  );
  const requestedValidUntil = parseTimestamp(body.validUntil ?? body.valid_until, "validUntil");
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
    sourceRefs: parseSourceRefs(body.sourceRefs ?? body.source_refs, "sourceRefs", 16),
    ownerRefs: ensurePrincipalOwner(parseOwnerRefs(body.ownerRefs ?? body.owner_refs, "ownerRefs", 16), requestPrincipal),
    reviewerRefs: parseOwnerRefs(body.reviewerRefs ?? body.reviewer_refs, "reviewerRefs", 16),
    validFrom: parseTimestamp(body.validFrom ?? body.valid_from, "validFrom"),
    validUntil: confirmationState === "inferred_unconfirmed" && requestedValidUntil === null
      ? now + INFERRED_DECISION_TTL_MS
      : requestedValidUntil,
    status: parseEnum(body.status, "status", DECISION_STATUSES, "active"),
    supersededBy: parseOptionalString(body.supersededBy ?? body.superseded_by, "supersededBy", 128),
    confidence: parseOptionalNumber(body.confidence, "confidence", 0.5, 0, 1),
    visibility,
    allowedPrincipals:
      visibility === "restricted"
        ? ensurePrincipalAllowed(
            parseStringArray(body.allowedPrincipals ?? body.allowed_principals, "allowedPrincipals", 64, 128),
            requestPrincipal
          )
        : parseStringArray(body.allowedPrincipals ?? body.allowed_principals, "allowedPrincipals", 64, 128),
    confirmationState,
    confirmationNote: parseOptionalString(body.confirmationNote ?? body.confirmation_note, "confirmationNote", 1000),
    confirmedAt: null,
    createdAt: now,
    updatedAt: now,
    businessCategoryId: parseOptionalString(body.business_category_id, "business_category_id", 128),
    workType: body.work_type ?? null
  };
}

function parseSearchDecisionRequest(rawBody: unknown, principal?: string | null) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as DecisionMemorySearchRequest;
  const requestPrincipal = normalizePrincipal(principal);
  return {
    tenantId: parseOptionalString(body.orgId ?? body.tenant_id, "orgId", 128) ?? "default",
    projectId: parseOptionalString(body.projectId ?? body.project_id, "projectId", 128),
    q: typeof body.q === "string" && body.q.trim() === ""
      ? ""
      : parseOptionalString(body.q, "q", 500) ?? "",
    limit: parseOptionalInteger(body.limit, "limit", DEFAULT_SEARCH_LIMIT, 1, 50),
    userId: requestPrincipal ?? parseOptionalString(body.userId ?? body.user_id, "userId", 128),
    agentId: requestPrincipal ?? parseOptionalString(body.agentId ?? body.agent_id, "agentId", 128),
    personId: parseOptionalString(body.personId ?? body.person_id, "personId", 128),
    reviewerId: parseOptionalString(body.reviewerId ?? body.reviewer_id, "reviewerId", 128),
    confirmationState: parseOptionalEnum(body.confirmationState ?? body.confirmation_state, "confirmationState", CONFIRMATION_STATES),
    validAt: parseOptionalTimestamp(body.validAt ?? body.valid_at, "validAt"),
    hasConflicts: parseOptionalBoolean(body.hasConflicts ?? body.has_conflicts, "hasConflicts", false),
    taskContext: parseOptionalString(body.taskContext ?? body.task_context, "taskContext", 1000) ?? "",
    includeProvenance: parseOptionalBoolean(body.includeProvenance ?? body.include_provenance, "includeProvenance", false),
    authorityScoring: parseOptionalBoolean(body.authorityScoring ?? body.authority_scoring, "authorityScoring", false),
    verificationView: parseOptionalBoolean(body.verificationView ?? body.verification_view, "verificationView", false),
    businessCategoryId: parseOptionalString(body.business_category_id, "business_category_id", 128),
    workType: body.work_type ?? null,
    generationId: parseOptionalString(body.generation_id, "generation_id", 128),
    rankingProfileId: parseOptionalString(body.ranking_profile_id, "ranking_profile_id", 128),
    taskId: parseOptionalString(body.task_id, "task_id", 128),
    traceId: parseOptionalString(body.trace_id, "trace_id", 128),
    externalRunId: parseOptionalString(body.external_run_id, "external_run_id", 256)
  };
}

async function loadDecisionMemories(env: Env, args: {
  tenantId: string;
  projectId: string | null;
  q: string;
  limit: number;
  businessCategoryId?: string | null;
  workType?: MemoryWorkType | null;
}): Promise<DecisionMemory[]> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, domain, title, decision, rationale,
            rejected_alternatives_json, constraints_json, known_pitfalls_json, source_refs_json, owner_refs_json, reviewer_refs_json,
            valid_from, valid_until, status, superseded_by, confidence, visibility, allowed_principals_json,
            confirmation_state, confirmation_note, confirmed_at,
            created_at, updated_at, business_category_id, work_type
     FROM decision_memories
     WHERE tenant_id = ?
       AND (? IS NULL OR project_id = ? OR project_id IS NULL)
       AND (? IS NULL OR business_category_id = ?)
       AND (? IS NULL OR work_type = ?)
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(
      args.tenantId, args.projectId, args.projectId,
      args.businessCategoryId ?? null, args.businessCategoryId ?? null,
      args.workType ?? null, args.workType ?? null,
      Math.max(args.limit, 64)
    )
    .all<DecisionMemoryRow>();
  const memories = result.results.map(toDecisionMemory);
  const queryTokens = tokenize(args.q);
  if (queryTokens.length === 0) return memories.slice(0, args.limit);
  const matched = memories.filter((memory) => semanticRelevance(memory, args.q) > 0);
  return (matched.length > 0 ? matched : memories).slice(0, args.limit);
}

async function loadDecisionMemoryById(env: Env, tenantId: string, id: string): Promise<DecisionMemory> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, domain, title, decision, rationale,
            rejected_alternatives_json, constraints_json, known_pitfalls_json, source_refs_json, owner_refs_json, reviewer_refs_json,
            valid_from, valid_until, status, superseded_by, confidence, visibility, allowed_principals_json,
            confirmation_state, confirmation_note, confirmed_at,
            created_at, updated_at, business_category_id, work_type
     FROM decision_memories
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, id)
    .all<DecisionMemoryRow>();
  const row = result.results[0];
  if (!row) throw new HttpError(404, "decision_memory_not_found", `decision memory not found: ${id}`);
  return toDecisionMemory(row);
}

async function loadDecisionMemoryVersions(env: Env, tenantId: string, id: string): Promise<DecisionMemoryVersion[]> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, decision_memory_id, tenant_id, operation, snapshot_json, actor_refs_json, reviewer_refs_json, note, created_at
     FROM decision_memory_versions
     WHERE tenant_id = ? AND decision_memory_id = ?
     ORDER BY created_at DESC
     LIMIT 30`
  )
    .bind(tenantId, id)
    .all<DecisionMemoryVersionRow>();
  return result.results.map(toDecisionMemoryVersion);
}

function snapshotDecisionMemory(memory: DecisionMemory): Record<string, unknown> {
  return {
    id: memory.id,
    tenantId: memory.tenantId,
    projectId: memory.projectId,
    domain: memory.domain,
    title: memory.title,
    decision: memory.decision,
    rationale: memory.rationale,
    rejectedAlternatives: memory.rejectedAlternatives,
    constraints: memory.constraints,
    knownPitfalls: memory.knownPitfalls,
    sourceRefs: memory.sourceRefs,
    ownerRefs: memory.ownerRefs,
    reviewerRefs: memory.reviewerRefs,
    validFrom: memory.validFrom,
    validUntil: memory.validUntil,
    status: memory.status,
    supersededBy: memory.supersededBy,
    confidence: memory.confidence,
    visibility: memory.visibility,
    allowedPrincipals: memory.allowedPrincipals,
    confirmationState: memory.confirmationState,
    confirmationNote: memory.confirmationNote,
    confirmedAt: memory.confirmedAt,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    businessCategoryId: memory.businessCategoryId,
    workType: memory.workType
  };
}

async function insertDecisionMemoryVersion(env: Env, args: {
  memory: DecisionMemory;
  operation: string;
  note?: string | null;
  actorRefs?: OwnerRef[];
  reviewerRefs?: OwnerRef[];
  now?: number;
}) {
  const now = args.now ?? Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO decision_memory_versions(
       id, decision_memory_id, tenant_id, operation, snapshot_json, actor_refs_json,
       reviewer_refs_json, note, created_at, business_category_id, work_type
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      ulid(now),
      args.memory.id,
      args.memory.tenantId,
      args.operation,
      JSON.stringify(snapshotDecisionMemory(args.memory)),
      JSON.stringify(args.actorRefs ?? []),
      JSON.stringify(args.reviewerRefs ?? []),
      args.note ?? null,
      now,
      args.memory.businessCategoryId,
      args.memory.workType
    )
    .run();
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

function refsMatch(refs: OwnerRef[], needle: string | null): boolean {
  if (!needle) return true;
  const normalized = needle.toLowerCase();
  return refs.some((ref) =>
    [ref.id, ref.name, ref.id ? `user:${ref.id}` : null, ref.id ? `agent:${ref.id}` : null]
      .filter((item): item is string => Boolean(item))
      .some((item) => item.toLowerCase() === normalized)
  );
}

function validAt(memory: DecisionMemory, timestamp: number | null | undefined): boolean {
  if (timestamp === undefined || timestamp === null) return true;
  if (memory.validFrom && memory.validFrom > timestamp) return false;
  if (memory.validUntil && memory.validUntil < timestamp) return false;
  return true;
}

function freshnessState(memory: DecisionMemory, now = Date.now()): "not_yet_valid" | "expired" | "stale" | "current" {
  if (memory.validFrom && memory.validFrom > now) return "not_yet_valid";
  if (memory.validUntil && memory.validUntil < now) return "expired";
  return stalenessPenalty(memory, now) > 0 ? "stale" : "current";
}

function confirmationWeight(state: ConfirmationState): number {
  if (state === "user_confirmed" || state === "user_corrected" || state === "reviewed") return 1;
  if (state === "draft") return 0.25;
  return 0.45;
}

function buildTrustSignals(memory: DecisionMemory, conflicts: ReturnType<typeof detectConflicts>, userId: string | null, agentId: string | null) {
  const readableSourceRefs = filterSourceRefs(memory.sourceRefs, userId, agentId);
  const conflictCount = conflicts.filter((conflict) =>
    conflict.preferredMemoryId === memory.id || conflict.conflictingMemoryIds.includes(memory.id)
  ).length;
  return {
    confidence: memory.confidence,
    confirmationState: memory.confirmationState,
    humanConfirmed: confirmationWeight(memory.confirmationState) >= 1,
    sourceAuthority: Number(sourceAuthorityScore(readableSourceRefs).toFixed(3)),
    sourceCount: readableSourceRefs.length,
    ownerCount: memory.ownerRefs.length,
    reviewerCount: memory.reviewerRefs.length,
    freshness: freshnessState(memory),
    conflictCount,
    visibility: memory.visibility,
    permissionFilteredSourceCount: Math.max(0, memory.sourceRefs.length - readableSourceRefs.length)
  };
}

function buildProvenance(memory: DecisionMemory, userId: string | null, agentId: string | null) {
  return {
    decidedBy: memory.ownerRefs,
    reviewedBy: memory.reviewerRefs,
    confirmedAt: memory.confirmedAt,
    confirmationNote: memory.confirmationNote,
    sourceRefs: filterSourceRefs(memory.sourceRefs, userId, agentId),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    applicableContext: {
      tenantId: memory.tenantId,
      projectId: memory.projectId,
      domain: memory.domain,
      validFrom: memory.validFrom,
      validUntil: memory.validUntil,
      status: memory.status,
      constraints: memory.constraints,
      knownPitfalls: memory.knownPitfalls
    }
  };
}

function toPublicDecisionSearchResult(args: {
  item: ScoredDecisionMemory;
  includeProvenance: boolean;
  authorityScoring: boolean;
  verificationView: boolean;
  conflicts: ReturnType<typeof detectConflicts>;
  userId: string | null;
  agentId: string | null;
}) {
  const result: Record<string, unknown> = {
    ...args.item.memory,
    sourceRefs: filterSourceRefs(args.item.memory.sourceRefs, args.userId, args.agentId),
    score: args.item.score
  };
  if (args.includeProvenance || args.verificationView) {
    result.provenance = buildProvenance(args.item.memory, args.userId, args.agentId);
  }
  if (args.authorityScoring || args.verificationView) {
    result.trustSignals = buildTrustSignals(args.item.memory, args.conflicts, args.userId, args.agentId);
  }
  return result;
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
  const result: Record<string, unknown> = toPublicDecisionContext(args.item, args.includeSources, args.userId, args.agentId, args.debugScores);
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
  const overBudget = () => estimateTokens(trimmed) > maxTokens;
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
  return trimmed;
}

async function projectDecisionMemory(env: Env, memory: DecisionMemory) {
  const text = [
    memory.title,
    memory.decision,
    memory.rationale,
    ...memory.constraints,
    ...memory.knownPitfalls
  ].join("\n");
  const contentHash = await sha256(text);
  const assignedGenerations = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT DISTINCT g.id, g.extractor_name, g.extractor_version
     FROM retrieval_generation_assignments a
     JOIN retrieval_generations g
       ON g.id = a.active_generation_id OR g.id = a.shadow_generation_id
     WHERE a.tenant_id = ? AND a.project_scope_key IN ('*', ?)
       AND g.id NOT IN ('gen_baseline_units', 'gen_structured_context')
       AND g.status IN ('building', 'shadow', 'active', 'fallback')`
  ).bind(memory.tenantId, memory.projectId ?? "").all<{
    id: string;
    extractor_name: string;
    extractor_version: string;
  }>()).results;
  const generations = [
    {
      id: "gen_baseline_units",
      unitId: `stable_decision_v3_${memory.id}`,
      extractorName: "decision-memory-projector",
      extractorVersion: "1"
    },
    {
      id: "gen_structured_context",
      unitId: `stable_decision_${memory.id}`,
      extractorName: "decision-memory-projector",
      extractorVersion: "1"
    },
    ...assignedGenerations.map((generation) => ({
      id: generation.id,
      unitId: `stable_${generation.id}_decision_${memory.id}`,
      extractorName: generation.extractor_name,
      extractorVersion: generation.extractor_version
    }))
  ];
  const statements = generations.flatMap((generation) => [
      env.OPEN_BRAIN_DB.prepare(
        "DELETE FROM retrieval_units_fts WHERE tenant_id = ? AND unit_id = ?"
      ).bind(memory.tenantId, generation.unitId),
      env.OPEN_BRAIN_DB.prepare(
        "DELETE FROM retrieval_units WHERE tenant_id = ? AND id = ?"
      ).bind(memory.tenantId, generation.unitId),
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO retrieval_units(
           id, generation_id, tenant_id, project_id, source_type, source_id,
           business_category_id, work_type, unit_type, text, speaker, event_at,
           valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
           metadata_json, segment_id, content_hash, extractor_name, extractor_version,
           extraction_state, degraded_reason, created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        generation.unitId, generation.id, memory.tenantId, memory.projectId,
        "decision_memory", memory.id, memory.businessCategoryId, memory.workType,
        "decision", text, null, memory.updatedAt, memory.validFrom, memory.validUntil,
        JSON.stringify(memory.sourceRefs), null, null,
        JSON.stringify({
          domain: memory.domain,
          status: memory.status,
          confirmation_state: memory.confirmationState,
          confidence: memory.confidence
        }),
        null, contentHash, generation.extractorName, generation.extractorVersion, "ready", null,
        memory.updatedAt
      ),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text) VALUES(?,?,?,?)"
      ).bind(generation.unitId, generation.id, memory.tenantId, text)
    ]);
  if (typeof env.OPEN_BRAIN_DB.batch === "function") await env.OPEN_BRAIN_DB.batch(statements);
  else for (const statement of statements) await statement.run();
}

export async function backfillDecisionRetrievalUnits(
  env: Env,
  options: {
    tenantId: string;
    projectId?: string | null;
    cursor?: string | null;
    limit?: number;
  }
) {
  const limit = Math.max(1, Math.min(50, options.limit ?? 25));
  const projectKey = options.projectId ?? "";
  const checkpoint = options.cursor === undefined || options.cursor === null
    ? await env.OPEN_BRAIN_DB.prepare(
      `SELECT cursor, processed_decisions
       FROM decision_retrieval_projection_backfills
       WHERE tenant_id = ? AND project_id = ?`
    ).bind(options.tenantId, projectKey).first<{
      cursor: string;
      processed_decisions: number;
    }>()
    : null;
  const cursor = options.cursor ?? checkpoint?.cursor ?? "";
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id FROM decision_memories
     WHERE tenant_id = ? AND status = 'active' AND id > ?
       AND (? IS NULL OR project_id = ?)
     ORDER BY id
     LIMIT ?`
  ).bind(
    options.tenantId,
    cursor,
    options.projectId ?? null,
    options.projectId ?? null,
    limit
  ).all<{ id: string }>();
  for (const row of rows.results) {
    await projectDecisionMemory(env, await loadDecisionMemoryById(env, options.tenantId, row.id));
  }
  const nextCursor = rows.results.at(-1)?.id ?? cursor;
  const done = rows.results.length < limit;
  const totalProcessed = Number(checkpoint?.processed_decisions ?? 0) + rows.results.length;
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO decision_retrieval_projection_backfills(
       tenant_id, project_id, cursor, processed_decisions, state, updated_at
     ) VALUES(?,?,?,?,?,?)
     ON CONFLICT(tenant_id, project_id) DO UPDATE SET
       cursor=excluded.cursor,
       processed_decisions=excluded.processed_decisions,
       state=excluded.state,
       updated_at=excluded.updated_at`
  ).bind(
    options.tenantId,
    projectKey,
    nextCursor,
    totalProcessed,
    done ? "complete" : "running",
    Date.now()
  ).run();
  return {
    tenant_id: options.tenantId,
    project_id: options.projectId ?? null,
    processed_decisions: rows.results.length,
    total_processed_decisions: totalProcessed,
    next_cursor: nextCursor || null,
    done
  };
}

export async function createDecisionMemory(env: Env, rawBody: unknown, options: PrincipalIdentityOptions = {}) {
  const parsedMemory = parseCreateDecisionRequest(rawBody, options.principal);
  const classification = await validateBusinessClassification(
    env,
    parsedMemory.tenantId,
    parsedMemory.businessCategoryId,
    parsedMemory.workType,
    { required: env.MEMORY_CLASSIFICATION_MODE === "require" }
  );
  const memory: DecisionMemory = {
    ...parsedMemory,
    businessCategoryId: classification.business_category_id,
    workType: classification.work_type,
    title: screenMemoryWriteText(parsedMemory.title, "title"),
    decision: screenMemoryWriteText(parsedMemory.decision, "decision"),
    rationale: screenMemoryWriteText(parsedMemory.rationale, "rationale"),
    rejectedAlternatives: parsedMemory.rejectedAlternatives.map((alternative, index) => ({
      alternative: screenMemoryWriteText(alternative.alternative, `rejectedAlternatives[${index}].alternative`),
      reasonRejected: screenMemoryWriteText(alternative.reasonRejected, `rejectedAlternatives[${index}].reasonRejected`)
    })),
    constraints: parsedMemory.constraints.map((value, index) =>
      screenMemoryWriteText(value, `constraints[${index}]`)
    ),
    knownPitfalls: parsedMemory.knownPitfalls.map((value, index) =>
      screenMemoryWriteText(value, `knownPitfalls[${index}]`)
    ),
    confirmationNote: screenOptionalMemoryWriteText(parsedMemory.confirmationNote, "confirmationNote")
  };
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO decision_memories(
       id, tenant_id, project_id, domain, title, decision, rationale,
       rejected_alternatives_json, constraints_json, known_pitfalls_json, source_refs_json, owner_refs_json, reviewer_refs_json,
       valid_from, valid_until, status, superseded_by, confidence, visibility, allowed_principals_json,
       confirmation_state, confirmation_note, confirmed_at,
       created_at, updated_at, business_category_id, work_type,
       origin_memory_id, origin_source, origin_external_key, auto_generated
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      JSON.stringify(memory.reviewerRefs),
      memory.validFrom,
      memory.validUntil,
      memory.status,
      memory.supersededBy,
      memory.confidence,
      memory.visibility,
      JSON.stringify(memory.allowedPrincipals),
      memory.confirmationState,
      memory.confirmationNote,
      memory.confirmedAt,
      memory.createdAt,
      memory.updatedAt,
      memory.businessCategoryId,
      memory.workType,
      options.autoOrigin?.memoryId ?? null,
      options.autoOrigin?.source ?? null,
      options.autoOrigin?.externalKey ?? null,
      options.autoOrigin ? 1 : 0
    )
    .run();
  const ownerPrincipal = normalizePrincipal(options.principal)
    ?? normalizePrincipal(memory.ownerRefs.find((owner) => owner.id)?.id)
    ?? "system:decision";
  await ensureAccessPolicy(env, {
    tenantId: memory.tenantId,
    resourceType: "decision_memory",
    resourceId: memory.id,
    scope: memory.visibility === "tenant"
      ? "tenant"
      : memory.visibility === "project"
        ? "project"
        : memory.allowedPrincipals.length > 0
          ? "restricted"
          : "private",
    ownerPrincipal,
    projectId: memory.projectId,
    restrictedSubjects: memory.allowedPrincipals.map((principal) => ({
      subject_type: "principal" as const,
      subject_id: principal
    })),
    actorPrincipal: ownerPrincipal
  });
  await insertDecisionMemoryVersion(env, { memory, operation: "create", actorRefs: memory.ownerRefs, reviewerRefs: memory.reviewerRefs, note: memory.confirmationNote });
  await projectDecisionMemory(env, memory);
  return {
    decisionMemory: memory,
    ...(classification.classification_warning
      ? { classification_warning: classification.classification_warning }
      : {})
  };
}

type AutoDecisionEvidence = {
  evidence_type?: string;
  evidence_ref?: string;
  note?: string | null;
};

type AutoDecisionSourceReference = {
  type?: unknown;
  ref?: unknown;
  id?: unknown;
  title?: unknown;
  url?: unknown;
};

function relativeRepositoryPath(value: string): boolean {
  return Boolean(value) &&
    !value.startsWith("/") &&
    !value.startsWith("[external-path]") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.includes("../");
}

function durableAutoDecisionSource(source: SourceRef): boolean {
  const type = source.type?.toLowerCase() ?? "";
  const reference = `${source.id ?? ""} ${source.url ?? ""} ${source.title ?? ""}`;
  if (type === "current_code") {
    return relativeRepositoryPath(source.id ?? "") && /\b[a-f0-9]{7,64}\b|sha-?256/iu.test(reference);
  }
  if (type === "commit") return /^[a-f0-9]{7,64}$/iu.test(source.id ?? "");
  if (type === "merged_pr" || type === "adr") return Boolean(source.id || source.url);
  if (type === "official_doc") return /^https?:\/\//iu.test(source.url ?? source.id ?? "");
  if (type === "command") return /\bexit[_ -]?code\s*[:=]?\s*0\b|\b(?:passed|verified|succeeded)\b/iu.test(reference);
  return false;
}

function durableAutoDecisionSourceIdentity(source: SourceRef): string | null {
  if (!durableAutoDecisionSource(source)) return null;
  const reference = `${source.id ?? ""} ${source.url ?? ""} ${source.title ?? ""}`;
  const hash = reference.match(/\b[a-f0-9]{7,64}\b/iu)?.[0]?.toLowerCase();
  if (hash) return `hash:${hash}`;
  return `${source.type?.toLowerCase() ?? "unknown"}:${source.id ?? source.url ?? source.title ?? ""}`;
}

function normalizeAutoDecisionSources(
  evidence: AutoDecisionEvidence[],
  references: AutoDecisionSourceReference[]
): SourceRef[] {
  const commitHash = evidence
    .map((item) => item.evidence_ref ?? "")
    .find((value) => /^[a-f0-9]{7,64}$/iu.test(value));
  const sources: SourceRef[] = [];
  for (const entry of evidence) {
    const ref = entry.evidence_ref?.trim();
    if (!ref) continue;
    const type = entry.evidence_type === "file"
      ? "current_code"
      : entry.evidence_type === "doc"
        ? /(?:^|[/_-])adr(?:[/_.-]|\d)/iu.test(ref) ? "adr" : "official_doc"
        : entry.evidence_type === "command"
          ? "command"
        : entry.evidence_type === "external" && /^[a-f0-9]{7,64}$/iu.test(ref)
          ? "commit"
          : entry.evidence_type === "external" && /^ADR[-_ ]?\d+$/iu.test(ref)
            ? "adr"
          : entry.evidence_type === "external" && /(?:pull\/\d+|PR\s*#?\d+)/iu.test(ref) && /merged/iu.test(entry.note ?? "")
            ? "merged_pr"
            : entry.evidence_type;
    sources.push({
      type,
      id: ref.slice(0, 160),
      ...(ref.startsWith("http://") || ref.startsWith("https://") ? { url: ref.slice(0, 500) } : {}),
      ...((entry.note || (type === "current_code" && commitHash))
        ? { title: `${entry.note ?? ""}${entry.note && commitHash ? "; " : ""}${commitHash ? `hash=${commitHash}` : ""}`.slice(0, 240) }
        : {})
    });
  }
  for (const entry of references) {
    const ref = typeof entry.ref === "string" ? entry.ref : typeof entry.id === "string" ? entry.id : "";
    const url = typeof entry.url === "string" ? entry.url : /^https?:\/\//iu.test(ref) ? ref : undefined;
    sources.push({
      type: typeof entry.type === "string" ? entry.type.slice(0, 80) : "unknown",
      ...(ref ? { id: ref.slice(0, 160) } : {}),
      ...(typeof entry.title === "string" ? { title: entry.title.slice(0, 240) } : {}),
      ...(url ? { url: url.slice(0, 500) } : {})
    });
  }
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.type ?? ""}\0${source.id ?? ""}\0${source.url ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}

export function capAutoDecisionConfidence(args: {
  requested: number;
  decision: string;
  rationale: string;
  projectId: string | null;
  sources: SourceRef[];
  certified?: boolean;
}): number {
  const explicitDecision = /\b(?:decided|decision|must|must not|required|prohibited|forbidden|never|always|will use)\b|(?:決定|採用|方針|必須|禁止|不可|制約|必ず)/iu.test(args.decision);
  const durableEvidenceCount = new Set(
    args.sources
      .map(durableAutoDecisionSourceIdentity)
      .filter((identity): identity is string => Boolean(identity))
  ).size;
  const eligible = args.certified === true || (explicitDecision && args.rationale.trim().length > 0 && Boolean(args.projectId));
  const cap = !eligible || durableEvidenceCount === 0 ? 0.89 : durableEvidenceCount >= 2 ? 0.95 : 0.9;
  return Number(Math.min(Math.max(args.requested, 0), cap).toFixed(2));
}

export async function upsertAutoDecisionMemory(env: Env, args: {
  tenantId: string;
  memoryId: string | null;
  source: string;
  externalKey: string | null;
  projectId: string | null;
  businessCategoryId: string | null;
  workType: MemoryWorkType | null;
  kind: "decision" | "constraint";
  title: string;
  decision: string;
  rationale: string;
  evidence: AutoDecisionEvidence[];
  sourceReferences: AutoDecisionSourceReference[];
  validFrom: number;
  validUntil: number | null;
  confidence: number;
  visibility: DecisionVisibility;
  allowedPrincipals: string[];
  principal: string | null;
  certified?: boolean;
}) {
  if (!args.externalKey) {
    throw new HttpError(400, "external_key_required", "external_key is required for automatic decision promotion");
  }
  const sourceRefs = normalizeAutoDecisionSources(args.evidence, args.sourceReferences);
  const confidence = capAutoDecisionConfidence({
    requested: args.confidence,
    decision: args.decision,
    rationale: args.rationale,
    projectId: args.projectId,
    sources: sourceRefs,
    certified: args.certified === true
  });
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id FROM decision_memories
     WHERE tenant_id = ? AND origin_source = ? AND origin_external_key = ? AND auto_generated = 1
     LIMIT 1`
  ).bind(args.tenantId, args.source, args.externalKey).first<{ id: string }>();
  const body: DecisionMemoryCreateRequest = {
    tenant_id: args.tenantId,
    project_id: args.projectId,
    domain: "engineering",
    title: collapseWhitespace(args.title).slice(0, 240),
    decision: args.decision,
    rationale: args.rationale,
    constraints: args.kind === "constraint" ? [args.decision] : [],
    source_refs: sourceRefs,
    valid_from: args.validFrom,
    valid_until: args.validUntil ?? args.validFrom + INFERRED_DECISION_TTL_MS,
    status: "active",
    confidence,
    visibility: args.visibility,
    allowed_principals: args.allowedPrincipals,
    confirmation_state: "inferred_unconfirmed",
    confirmation_note: "Auto-generated from memory capture v2; review required unless strict blocking evidence rules pass.",
    business_category_id: args.businessCategoryId,
    work_type: args.workType
  };
  if (existing?.id) {
    return reviseDecisionMemory(env, args.tenantId, existing.id, {
      ...body,
      note: "Idempotent refresh from the originating memory capture."
    }, { principal: args.principal });
  }
  try {
    return await createDecisionMemory(env, body, {
      principal: args.principal,
      autoOrigin: {
        memoryId: args.memoryId,
        source: args.source,
        externalKey: args.externalKey
      }
    });
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
    const raced = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM decision_memories
       WHERE tenant_id = ? AND origin_source = ? AND origin_external_key = ? AND auto_generated = 1
       LIMIT 1`
    ).bind(args.tenantId, args.source, args.externalKey).first<{ id: string }>();
    if (!raced?.id) throw error;
    return reviseDecisionMemory(env, args.tenantId, raced.id, {
      ...body,
      note: "Idempotent refresh after concurrent automatic decision creation."
    }, { principal: args.principal });
  }
}

export async function searchDecisionMemories(env: Env, rawBody: unknown, options: PrincipalIdentityOptions = {}) {
  const request = parseSearchDecisionRequest(rawBody, options.principal);
  await validateBusinessClassification(
    env,
    request.tenantId,
    request.businessCategoryId,
    request.workType,
    { required: false }
  );
  const q = request.q || request.taskContext;
  const primaryStartedAt = performance.now();
  const generation = await resolveDecisionRetrievalGeneration(env, request);
  const candidateIds = generation
    ? await stableDecisionCandidateIds(env, request, generation.id, q)
    : null;
  const loaded = await loadDecisionMemories(env, {
    ...request,
    q: candidateIds ? "" : q,
    limit: candidateIds ? Math.max(candidateIds.length, request.limit) : request.limit
  });
  const candidateOrder = new Map((candidateIds ?? []).map((id, index) => [id, index]));
  const memories = candidateIds
    ? loaded
      .filter((memory) => candidateOrder.has(memory.id))
      .sort((left, right) => candidateOrder.get(left.id)! - candidateOrder.get(right.id)!)
    : loaded;
  const visibleMemories = await filterReadableDecisionMemories(
    env,
    request.tenantId,
    memories,
    request.userId,
    request.agentId,
    options.principal
  );
  const visible = visibleMemories
    .filter((memory) => refsMatch(memory.ownerRefs, request.personId))
    .filter((memory) => refsMatch(memory.reviewerRefs, request.reviewerId))
    .filter((memory) => !request.confirmationState || memory.confirmationState === request.confirmationState)
    .filter((memory) => validAt(memory, request.validAt));
  const scored = visible
    .map((memory) => ({
      memory,
      score: scoreDecisionMemory({
        memory,
        taskText: q,
        taskType: "implementation",
        targetFiles: [],
        projectId: request.projectId,
        userId: request.userId,
        agentId: request.agentId
      })
    }));
  if (generation) {
    if (generation.ranking_algorithm !== "reciprocal_rank_fusion") {
      throw new HttpError(500, "unsupported_ranking_algorithm", "assigned ranking algorithm is unsupported");
    }
    const structuredOrder = new Map(
      [...scored].sort(compareScored).map((item, index) => [item.memory.id, index])
    );
    const rrfConstant = generation.ranking_config.rrf_constant ?? 60;
    const decisionWeight = generation.ranking_config.decision_weight ?? 1;
    scored.sort((left, right) => {
      const leftLexical = candidateOrder.get(left.memory.id) ?? Number.MAX_SAFE_INTEGER;
      const rightLexical = candidateOrder.get(right.memory.id) ?? Number.MAX_SAFE_INTEGER;
      const leftStructured = structuredOrder.get(left.memory.id) ?? Number.MAX_SAFE_INTEGER;
      const rightStructured = structuredOrder.get(right.memory.id) ?? Number.MAX_SAFE_INTEGER;
      const leftRrf = 1 / (rrfConstant + leftLexical + 1) + decisionWeight / (rrfConstant + leftStructured + 1);
      const rightRrf = 1 / (rrfConstant + rightLexical + 1) + decisionWeight / (rrfConstant + rightStructured + 1);
      return rightRrf - leftRrf || compareScored(left, right);
    });
  } else {
    scored.sort(compareScored);
  }
  const conflicts = detectConflicts(scored, Date.now());
  const conflictMemoryIds = new Set(conflicts.flatMap((conflict) => [conflict.preferredMemoryId, ...conflict.conflictingMemoryIds]));
  const filtered = request.hasConflicts ? scored.filter((item) => conflictMemoryIds.has(item.memory.id)) : scored;
  const selected = filtered.slice(0, request.limit);
  const usage = options.recordUsage === false ? null : await recordMemoryUsage(env, {
    tenant_id: request.tenantId,
    project_id: request.projectId ?? undefined,
    task_id: request.taskId ?? undefined,
    trace_id: request.traceId ?? undefined,
    external_run_id: request.externalRunId ?? undefined,
    capability: "decision_memory_search",
    access_path: "search",
    request_source: "api",
    requested_business_category_id: request.businessCategoryId,
    requested_work_type: request.workType,
    retrieval_generation_id: generation?.id ?? null,
    ranking_profile_id: generation?.ranking_profile_id ?? null,
    actor_principal: options.principal ?? null,
    items: selected.map((item, index) => ({
      source_type: "decision_memory" as const,
      source_id: item.memory.id,
      rank: index + 1,
      score: item.score.finalScore,
      reference_type: "returned" as const,
      used_state: "unknown" as const
    }))
  });
  const response = {
    tenant_id: request.tenantId,
    project_id: request.projectId,
    q,
    feature_flags: {
      include_provenance: request.includeProvenance,
      authority_scoring: request.authorityScoring,
      verification_view: request.verificationView
    },
    conflicts: request.verificationView ? conflicts : undefined,
    meta: {
      usage_id: usage?.usage_id,
      verification_sampled: usage?.verification_sampled,
      retrieval: {
        generation_id: generation?.id ?? null,
        unit_schema_version: generation ? String(generation.unit_schema_version) : null,
        extractor_name: generation?.extractor_name ?? null,
        extractor_version: generation?.extractor_version ?? null,
        ranking_profile_id: generation?.ranking_profile_id ?? null,
        embedding_profile_id: generation?.embedding_profile_id ?? null
      }
    },
    results: selected.map((item) =>
      toPublicDecisionSearchResult({
        item,
        includeProvenance: request.includeProvenance,
        authorityScoring: request.authorityScoring,
        verificationView: request.verificationView,
        conflicts,
        userId: request.userId,
        agentId: request.agentId
      })
    )
  };
  if (
    generation?.shadow_generation_id &&
    generation.shadow_generation_id !== generation.id &&
    shouldRunDecisionShadow(
      generation.shadow_sample_rate,
      `${request.tenantId}\0${request.projectId ?? ""}\0governance\0${q}`
    )
  ) {
    const shadowStartedAt = performance.now();
    let shadow: Awaited<ReturnType<typeof searchDecisionMemories>> | null = null;
    let shadowError: string | null = null;
    try {
      shadow = await searchDecisionMemories(env, {
        ...(rawBody as Record<string, unknown>),
        generation_id: generation.shadow_generation_id,
        ranking_profile_id: undefined
      }, { ...options, recordUsage: false });
    } catch (error) {
      shadowError = error instanceof Error ? error.message.slice(0, 200) : "shadow governance retrieval failed";
    }
    const queryHash = await sha256(`governance:${q}`);
    const primaryIds = new Set(response.results.map((item) => item.id));
    const shadowIds = shadow?.results.map((item) => item.id) ?? [];
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO retrieval_evaluation_events(
         id, tenant_id, project_id, query_hash, baseline_generation_id,
         candidate_generation_id, baseline_result_count, candidate_result_count,
         overlap_count, baseline_empty, candidate_empty, candidate_degraded,
         baseline_latency_ms, candidate_latency_ms, evidence_tokens,
         projection_lag_ms, error_code, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      crypto.randomUUID(), request.tenantId, request.projectId, queryHash,
      generation.id, generation.shadow_generation_id,
      response.results.length, shadowIds.length,
      shadowIds.filter((id) => primaryIds.has(id)).length,
      response.results.length === 0 ? 1 : 0,
      shadowIds.length === 0 ? 1 : 0,
      shadowError ? 1 : 0,
      Number((shadowStartedAt - primaryStartedAt).toFixed(3)),
      Number((performance.now() - shadowStartedAt).toFixed(3)),
      null, null, shadowError, Date.now()
    ).run().catch(() => {
      // Shadow evaluation is best-effort and must not affect governance results.
    });
  }
  return response;
}

function mergeDecisionMemory(current: DecisionMemory, rawBody: unknown): { memory: DecisionMemory; actorRefs: OwnerRef[]; note: string | null } {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as DecisionMemoryReviseRequest;
  const now = Date.now();
  const memory: DecisionMemory = {
    ...current,
    projectId: body.projectId !== undefined || body.project_id !== undefined ? parseOptionalString(body.projectId ?? body.project_id, "projectId", 128) : current.projectId,
    domain: body.domain !== undefined ? parseEnum(body.domain, "domain", DECISION_DOMAINS, current.domain) : current.domain,
    title: body.title !== undefined ? parseRequiredString(body.title, "title", 240) : current.title,
    decision: body.decision !== undefined ? parseRequiredString(body.decision, "decision", 1000) : current.decision,
    rationale: body.rationale !== undefined ? parseRequiredString(body.rationale, "rationale", 2000) : current.rationale,
    rejectedAlternatives: body.rejectedAlternatives !== undefined || body.rejected_alternatives !== undefined
      ? ((body.rejectedAlternatives ?? body.rejected_alternatives ?? []) as RejectedAlternative[]).slice(0, 16)
      : current.rejectedAlternatives,
    constraints: body.constraints !== undefined ? parseStringArray(body.constraints, "constraints", 32, 500) : current.constraints,
    knownPitfalls: body.knownPitfalls !== undefined || body.known_pitfalls !== undefined
      ? parseStringArray(body.knownPitfalls ?? body.known_pitfalls, "knownPitfalls", 32, 500)
      : current.knownPitfalls,
    sourceRefs: body.sourceRefs !== undefined || body.source_refs !== undefined ? parseSourceRefs(body.sourceRefs ?? body.source_refs, "sourceRefs", 16) : current.sourceRefs,
    ownerRefs: body.ownerRefs !== undefined || body.owner_refs !== undefined ? parseOwnerRefs(body.ownerRefs ?? body.owner_refs, "ownerRefs", 16) : current.ownerRefs,
    reviewerRefs: body.reviewerRefs !== undefined || body.reviewer_refs !== undefined ? parseOwnerRefs(body.reviewerRefs ?? body.reviewer_refs, "reviewerRefs", 16) : current.reviewerRefs,
    validFrom: body.validFrom !== undefined || body.valid_from !== undefined ? parseTimestamp(body.validFrom ?? body.valid_from, "validFrom") : current.validFrom,
    validUntil: body.validUntil !== undefined || body.valid_until !== undefined ? parseTimestamp(body.validUntil ?? body.valid_until, "validUntil") : current.validUntil,
    status: body.status !== undefined ? parseEnum(body.status, "status", DECISION_STATUSES, current.status) : current.status,
    supersededBy: body.supersededBy !== undefined || body.superseded_by !== undefined ? parseOptionalString(body.supersededBy ?? body.superseded_by, "supersededBy", 128) : current.supersededBy,
    confidence: body.confidence !== undefined ? parseOptionalNumber(body.confidence, "confidence", current.confidence, 0, 1) : current.confidence,
    visibility: body.visibility !== undefined ? parseEnum(body.visibility, "visibility", VISIBILITIES, current.visibility) : current.visibility,
    allowedPrincipals: body.allowedPrincipals !== undefined || body.allowed_principals !== undefined
      ? parseStringArray(body.allowedPrincipals ?? body.allowed_principals, "allowedPrincipals", 64, 128)
      : current.allowedPrincipals,
    confirmationState: body.confirmationState !== undefined || body.confirmation_state !== undefined
      ? parseEnum(body.confirmationState ?? body.confirmation_state, "confirmationState", CONFIRMATION_STATES, current.confirmationState)
      : current.confirmationState,
    confirmationNote: body.confirmationNote !== undefined || body.confirmation_note !== undefined
      ? parseOptionalString(body.confirmationNote ?? body.confirmation_note, "confirmationNote", 1000)
      : current.confirmationNote,
    updatedAt: now
  };
  if (memory.confirmationState === "inferred_unconfirmed" && memory.validUntil === null) {
    memory.validUntil = now + INFERRED_DECISION_TTL_MS;
  }
  return {
    memory,
    actorRefs: parseOwnerRefs(body.actorRefs ?? body.actor_refs, "actorRefs", 16),
    note: parseOptionalString(body.note, "note", 1000)
  };
}

async function persistDecisionMemory(env: Env, memory: DecisionMemory) {
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE decision_memories
     SET project_id = ?, domain = ?, title = ?, decision = ?, rationale = ?,
         rejected_alternatives_json = ?, constraints_json = ?, known_pitfalls_json = ?,
         source_refs_json = ?, owner_refs_json = ?, reviewer_refs_json = ?,
         valid_from = ?, valid_until = ?, status = ?, superseded_by = ?, confidence = ?,
         visibility = ?, allowed_principals_json = ?,
         confirmation_state = ?, confirmation_note = ?, confirmed_at = ?, updated_at = ?,
         business_category_id = ?, work_type = ?
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(
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
      JSON.stringify(memory.reviewerRefs),
      memory.validFrom,
      memory.validUntil,
      memory.status,
      memory.supersededBy,
      memory.confidence,
      memory.visibility,
      JSON.stringify(memory.allowedPrincipals),
      memory.confirmationState,
      memory.confirmationNote,
      memory.confirmedAt,
      memory.updatedAt,
      memory.businessCategoryId,
      memory.workType,
      memory.tenantId,
      memory.id
    )
    .run();
  await projectDecisionMemory(env, memory);
}

export async function getDecisionMemoryContext(env: Env, args: { tenantId: string; id: string; userId?: string | null; agentId?: string | null }) {
  const memory = await loadDecisionMemoryById(env, args.tenantId, args.id);
  const userId = args.userId ?? null;
  const agentId = args.agentId ?? null;
  const visibleMemory = await filterReadableDecisionMemories(env, args.tenantId, [memory], userId, agentId, userId ?? agentId);
  if (visibleMemory.length === 0) throw new HttpError(403, "forbidden", "decision memory is restricted");
  const related = await loadDecisionMemories(env, {
    tenantId: memory.tenantId,
    projectId: memory.projectId,
    q: memory.title,
    limit: 64
  });
  const visibleRelated = await filterReadableDecisionMemories(env, memory.tenantId, related, userId, agentId, userId ?? agentId);
  const scored = visibleRelated
    .map((item) => ({
      memory: item,
      score: scoreDecisionMemory({
        memory: item,
        taskText: `${memory.title} ${memory.decision}`,
        taskType: "implementation",
        targetFiles: [],
        projectId: memory.projectId,
        userId,
        agentId
      })
    }))
    .sort(compareScored);
  const conflicts = detectConflicts(scored, Date.now()).filter((conflict) =>
    conflict.preferredMemoryId === memory.id || conflict.conflictingMemoryIds.includes(memory.id)
  );
  const versions = await loadDecisionMemoryVersions(env, memory.tenantId, memory.id);
  const usage = await recordMemoryUsage(env, {
    tenant_id: memory.tenantId,
    project_id: memory.projectId,
    capability: "decision_memory_context",
    access_path: "direct",
    request_source: "api",
    retrieval_generation_id: "gen_structured_context",
    ranking_profile_id: "rank_default",
    actor_principal: userId ?? agentId,
    items: [{
      source_type: "decision_memory",
      source_id: memory.id,
      source_version: versions.length,
      rank: 1,
      reference_type: "direct",
      used_state: "unknown"
    }]
  });
  return {
    decisionMemory: {
      ...memory,
      sourceRefs: filterSourceRefs(memory.sourceRefs, userId, agentId)
    },
    whyTrustThis: {
      trustSignals: buildTrustSignals(memory, conflicts, userId, agentId),
      provenance: buildProvenance(memory, userId, agentId),
      conflicts,
      versions
    },
    meta: {
      usage_id: usage.usage_id,
      verification_sampled: usage.verification_sampled
    },
    related: scored
      .filter((item) => item.memory.id !== memory.id)
      .slice(0, 8)
      .map((item) => ({
        id: item.memory.id,
        title: item.memory.title,
        decision: item.memory.decision,
        status: item.memory.status,
        confirmationState: item.memory.confirmationState,
        score: item.score
      }))
  };
}

export async function reviseDecisionMemory(
  env: Env,
  tenantId: string,
  id: string,
  rawBody: unknown,
  options: PrincipalIdentityOptions = {}
) {
  const current = await loadDecisionMemoryById(env, tenantId, id);
  const { memory: mergedMemory, actorRefs, note } = mergeDecisionMemory(current, rawBody);
  const body = rawBody as DecisionMemoryReviseRequest;
  const classification = await validateBusinessClassification(
    env,
    tenantId,
    body.business_category_id === undefined ? current.businessCategoryId : body.business_category_id,
    body.work_type === undefined ? current.workType : body.work_type,
    { required: env.MEMORY_CLASSIFICATION_MODE === "require" }
  );
  const memory = {
    ...mergedMemory,
    businessCategoryId: classification.business_category_id,
    workType: classification.work_type
  };
  const principal = normalizePrincipal(options.principal);
  const versionActorRefs = actorRefs.length > 0 ? actorRefs : principal ? [principalOwnerRef(principal)] : actorRefs;
  await persistDecisionMemory(env, memory);
  await insertDecisionMemoryVersion(env, { memory, operation: "revise", actorRefs: versionActorRefs, reviewerRefs: memory.reviewerRefs, note });
  return {
    decisionMemory: memory,
    ...(classification.classification_warning
      ? { classification_warning: classification.classification_warning }
      : {})
  };
}

export async function confirmDecisionMemory(
  env: Env,
  tenantId: string,
  id: string,
  rawBody: unknown,
  options: PrincipalIdentityOptions = {}
) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as DecisionMemoryConfirmRequest;
  const current = await loadDecisionMemoryById(env, tenantId, id);
  const principal = normalizePrincipal(options.principal);
  const reviewerRefs = ensurePrincipalOwner(parseOwnerRefs(body.reviewerRefs ?? body.reviewer_refs, "reviewerRefs", 16), principal);
  const confidence =
    body.confidence !== undefined
      ? parseOptionalNumber(body.confidence, "confidence", current.confidence, 0, 1)
      : clamp(current.confidence + parseOptionalNumber(body.confidenceDelta ?? body.confidence_delta, "confidenceDelta", 0, -1, 1), 0, 1);
  const now = Date.now();
  const memory: DecisionMemory = {
    ...current,
    reviewerRefs: reviewerRefs.length > 0 ? reviewerRefs : current.reviewerRefs,
    confirmationState: parseEnum(body.confirmationState ?? body.confirmation_state, "confirmationState", CONFIRMATION_STATES, "reviewed"),
    confirmationNote: parseOptionalString(body.confirmationNote ?? body.confirmation_note, "confirmationNote", 1000),
    confidence,
    validFrom: body.validFrom !== undefined || body.valid_from !== undefined ? parseTimestamp(body.validFrom ?? body.valid_from, "validFrom") : current.validFrom,
    validUntil: body.validUntil !== undefined || body.valid_until !== undefined ? parseTimestamp(body.validUntil ?? body.valid_until, "validUntil") : current.validUntil,
    confirmedAt: now,
    updatedAt: now
  };
  await persistDecisionMemory(env, memory);
  await insertDecisionMemoryVersion(env, { memory, operation: "confirm", reviewerRefs: memory.reviewerRefs, note: memory.confirmationNote });
  return { decisionMemory: memory };
}

export async function enrichContext(env: Env, rawBody: unknown, options: PrincipalIdentityOptions = {}) {
  const request = parseEnrichRequest(rawBody, options.principal);
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
  const agentContext = request.agentKey
    ? await resolveAgentLoadoutContext(env, {
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

  const response = trimToMaxTokens(
    {
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
        conflictCount: conflicts.length,
        featureFlags: {
          includeProvenance: request.includeProvenance,
          authorityScoring: request.authorityScoring,
          verificationView: request.verificationView
        },
        estimatedTokens: 0
      }
    },
    request.maxTokens
  );
  const meta = response.meta as { estimatedTokens?: number } | undefined;
  if (meta) meta.estimatedTokens = estimateTokens(response);
  let usage: Awaited<ReturnType<typeof recordMemoryUsage>> | null = null;
  if (options.recordUsage !== false) {
    try {
      usage = await recordMemoryUsage(env, {
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
        items: selected.map((item, index) => ({
          source_type: "decision_memory" as const,
          source_id: item.memory.id,
          rank: index + 1,
          score: item.score.finalScore,
          reference_type: "injected" as const,
          used_state: "unknown" as const,
          injected_token_estimate: estimateTokens(toPublicDecisionContext(item, request.includeSources, request.userId, request.agentId, false))
        }))
      });
    } catch (error) {
      if (!options.bestEffortUsage) throw error;
      console.warn({
        event: "orgbrain.context.usage_recording_skipped",
        tenant_id: request.tenantId,
        project_id: request.projectId,
        error_code: error instanceof HttpError ? error.code : "unknown"
      });
    }
  }
  if (meta) {
    Object.assign(meta, {
      usage_recorded: Boolean(usage),
      ...(usage
        ? {
            usage_id: usage.usage_id,
            verification_sampled: usage.verification_sampled
          }
        : {}),
      retrieval: {
        generation_id: "gen_structured_context",
        unit_schema_version: "2",
        extractor_name: "decision-memory-projector",
        extractor_version: "1",
        ranking_profile_id: "rank_default",
        embedding_profile_id: null
      }
    });
  }
  return response;
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
  const context = await enrichContext(
    env,
    {
      ...body,
      includeConflicts: true,
      includeProvenance: true,
      authorityScoring: true,
      verificationView: true
    },
    options
  ) as {
    confidence?: number;
    requiresHumanReview?: boolean;
    conflicts?: Array<{
      severity?: string;
      requiresHumanReview?: boolean;
      preferredMemoryId?: string;
      conflictingMemoryIds?: string[];
    }>;
    decisionContext?: Array<{
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
    [key: string]: unknown;
  };
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
        ...context,
      blocking_decision_memory_ids: [...blockingDecisionIds],
      review_decision_memory_ids: reviewOnlyDecisionIds
      }
  };
}

export async function getDecisionReviewQueue(
  env: Env,
  rawBody: unknown,
  options: PrincipalIdentityOptions = {}
) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as {
    tenant_id?: string;
    orgId?: string;
    project_id?: string | null;
    projectId?: string | null;
    within_days?: number;
    limit?: number;
  };
  const tenantId = parseOptionalString(body.tenant_id ?? body.orgId, "tenant_id", 128) ?? "default";
  const projectId = parseOptionalString(body.project_id ?? body.projectId, "project_id", 128);
  const withinDays = parseOptionalInteger(body.within_days, "within_days", 30, 1, 365);
  const limit = parseOptionalInteger(body.limit, "limit", 50, 1, 100);
  const principal = normalizePrincipal(options.principal);
  const memories = await loadDecisionMemories(env, { tenantId, projectId, q: "", limit: 100 });
  const visible = await filterReadableDecisionMemories(
    env,
    tenantId,
    memories,
    principal,
    principal,
    principal
  );
  const now = Date.now();
  const scored = visible.map((memory) => ({
    memory,
    score: scoreDecisionMemory({
      memory,
      taskText: `${memory.title} ${memory.decision}`,
      taskType: "review",
      targetFiles: [],
      projectId,
      userId: principal,
      agentId: principal
    })
  }));
  const conflicts = detectConflicts(scored, now);
  const conflictIds = new Set(
    conflicts.flatMap((conflict) => [conflict.preferredMemoryId, ...conflict.conflictingMemoryIds])
  );
  const counters = {
    unconfirmed: 0,
    uncertain: 0,
    stale: 0,
    expiring: 0,
    conflicting: 0
  };
  const items = visible.flatMap((memory) => {
    const reasons: string[] = [];
    if (memory.confirmationState === "draft" || memory.confirmationState === "inferred_unconfirmed") {
      reasons.push("unconfirmed");
      counters.unconfirmed += 1;
    }
    if (memory.status === "uncertain") {
      reasons.push("uncertain");
      counters.uncertain += 1;
    }
    if (freshnessState(memory, now) === "stale") {
      reasons.push("stale");
      counters.stale += 1;
    }
    if (memory.validUntil && memory.validUntil >= now && memory.validUntil <= now + withinDays * DAY_MS) {
      reasons.push("expiring");
      counters.expiring += 1;
    }
    if (conflictIds.has(memory.id)) {
      reasons.push("conflicting");
      counters.conflicting += 1;
    }
    if (reasons.length === 0) return [];
    const debtScore =
      (reasons.includes("conflicting") ? 0.35 : 0) +
      (reasons.includes("uncertain") ? 0.25 : 0) +
      (reasons.includes("unconfirmed") ? 0.2 : 0) +
      (reasons.includes("stale") ? 0.15 : 0) +
      (reasons.includes("expiring") ? 0.05 : 0);
    return [{
      id: memory.id,
      project_id: memory.projectId,
      title: memory.title,
      decision: memory.decision,
      status: memory.status,
      confirmation_state: memory.confirmationState,
      valid_until: memory.validUntil,
      updated_at: memory.updatedAt,
      reasons,
      debt_score: Number(debtScore.toFixed(2))
    }];
  })
    .sort((left, right) => right.debt_score - left.debt_score || left.id.localeCompare(right.id))
    .slice(0, limit);

  return {
    tenant_id: tenantId,
    project_id: projectId,
    items,
    debt: {
      total_items: items.length,
      ...counters
    },
    conflicts,
    policy: {
      expiring_within_days: withinDays,
      stale_rule: "authority-aware decision freshness policy"
    }
  };
}
