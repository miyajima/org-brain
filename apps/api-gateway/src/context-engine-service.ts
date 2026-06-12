import { HttpError, collapseWhitespace, ulid } from "@org-brain/shared";
import { buildAuthzContext, loadReadableResourceIds } from "./authz-service";
import type { Env } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
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
    updatedAt: row.updated_at
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
    verificationView: parseOptionalBoolean(body.verificationView ?? body.verification_view, "verificationView", false)
  };
}

function parseCreateDecisionRequest(rawBody: unknown, principal?: string | null): DecisionMemory {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as DecisionMemoryCreateRequest;
  const now = Date.now();
  const requestPrincipal = normalizePrincipal(principal);
  const visibility = parseEnum(body.visibility, "visibility", VISIBILITIES, "tenant");
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
    validUntil: parseTimestamp(body.validUntil ?? body.valid_until, "validUntil"),
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
    confirmationState: parseEnum(body.confirmationState ?? body.confirmation_state, "confirmationState", CONFIRMATION_STATES, "inferred_unconfirmed"),
    confirmationNote: parseOptionalString(body.confirmationNote ?? body.confirmation_note, "confirmationNote", 1000),
    confirmedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function parseSearchDecisionRequest(rawBody: unknown, principal?: string | null) {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as DecisionMemorySearchRequest;
  const requestPrincipal = normalizePrincipal(principal);
  return {
    tenantId: parseOptionalString(body.orgId ?? body.tenant_id, "orgId", 128) ?? "default",
    projectId: parseOptionalString(body.projectId ?? body.project_id, "projectId", 128),
    q: parseOptionalString(body.q, "q", 500) ?? "",
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
    verificationView: parseOptionalBoolean(body.verificationView ?? body.verification_view, "verificationView", false)
  };
}

async function loadDecisionMemories(env: Env, args: { tenantId: string; projectId: string | null; q: string; limit: number }): Promise<DecisionMemory[]> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, domain, title, decision, rationale,
            rejected_alternatives_json, constraints_json, known_pitfalls_json, source_refs_json, owner_refs_json, reviewer_refs_json,
            valid_from, valid_until, status, superseded_by, confidence, visibility, allowed_principals_json,
            confirmation_state, confirmation_note, confirmed_at,
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

async function loadDecisionMemoryById(env: Env, tenantId: string, id: string): Promise<DecisionMemory> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, domain, title, decision, rationale,
            rejected_alternatives_json, constraints_json, known_pitfalls_json, source_refs_json, owner_refs_json, reviewer_refs_json,
            valid_from, valid_until, status, superseded_by, confidence, visibility, allowed_principals_json,
            confirmation_state, confirmation_note, confirmed_at,
            created_at, updated_at
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
    updatedAt: memory.updatedAt
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
       id, decision_memory_id, tenant_id, operation, snapshot_json, actor_refs_json, reviewer_refs_json, note, created_at
     ) VALUES(?,?,?,?,?,?,?,?,?)`
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
      now
    )
    .run();
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

  while (estimateTokens(trimmed) > maxTokens && knownPitfalls.length > 1) knownPitfalls.pop();
  while (estimateTokens(trimmed) > maxTokens && nextActions.length > 1) nextActions.pop();
  while (estimateTokens(trimmed) > maxTokens && constraints.length > 1) constraints.pop();
  while (estimateTokens(trimmed) > maxTokens && decisionContext.length > 1) decisionContext.pop();
  if (estimateTokens(trimmed) > maxTokens) {
    trimmed.summary = String(trimmed.summary ?? "").slice(0, Math.max(80, maxTokens * 2));
  }
  return trimmed;
}

export async function createDecisionMemory(env: Env, rawBody: unknown, options: PrincipalIdentityOptions = {}) {
  const memory = parseCreateDecisionRequest(rawBody, options.principal);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO decision_memories(
       id, tenant_id, project_id, domain, title, decision, rationale,
       rejected_alternatives_json, constraints_json, known_pitfalls_json, source_refs_json, owner_refs_json, reviewer_refs_json,
       valid_from, valid_until, status, superseded_by, confidence, visibility, allowed_principals_json,
       confirmation_state, confirmation_note, confirmed_at,
       created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      memory.updatedAt
    )
    .run();
  await insertDecisionMemoryVersion(env, { memory, operation: "create", actorRefs: memory.ownerRefs, reviewerRefs: memory.reviewerRefs, note: memory.confirmationNote });
  return { decisionMemory: memory };
}

export async function searchDecisionMemories(env: Env, rawBody: unknown, options: PrincipalIdentityOptions = {}) {
  const request = parseSearchDecisionRequest(rawBody, options.principal);
  const q = request.q || request.taskContext;
  const memories = await loadDecisionMemories(env, { ...request, q });
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
    }))
    .sort(compareScored);
  const conflicts = detectConflicts(scored, Date.now());
  const conflictMemoryIds = new Set(conflicts.flatMap((conflict) => [conflict.preferredMemoryId, ...conflict.conflictingMemoryIds]));
  const filtered = request.hasConflicts ? scored.filter((item) => conflictMemoryIds.has(item.memory.id)) : scored;
  const selected = filtered.slice(0, request.limit);
  return {
    tenant_id: request.tenantId,
    project_id: request.projectId,
    q,
    feature_flags: {
      include_provenance: request.includeProvenance,
      authority_scoring: request.authorityScoring,
      verification_view: request.verificationView
    },
    conflicts: request.verificationView ? conflicts : undefined,
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
         confirmation_state = ?, confirmation_note = ?, confirmed_at = ?, updated_at = ?
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
      memory.tenantId,
      memory.id
    )
    .run();
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
  const { memory, actorRefs, note } = mergeDecisionMemory(current, rawBody);
  const principal = normalizePrincipal(options.principal);
  const versionActorRefs = actorRefs.length > 0 ? actorRefs : principal ? [principalOwnerRef(principal)] : actorRefs;
  await persistDecisionMemory(env, memory);
  await insertDecisionMemoryVersion(env, { memory, operation: "revise", actorRefs: versionActorRefs, reviewerRefs: memory.reviewerRefs, note });
  return { decisionMemory: memory };
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
  const memories = await loadDecisionMemories(env, {
    tenantId: request.tenantId,
    projectId: request.projectId,
    q: request.taskText,
    limit: 24
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
  return response;
}
