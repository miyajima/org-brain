export const MEMORY_KINDS = ["episodic", "semantic", "org_knowledge"] as const;
export const MEMORY_LIFECYCLE_STATES = ["active", "suppressed", "consolidated", "promoted"] as const;
export const MEMORY_SCOPE_TYPES = ["tenant", "project", "org"] as const;
export const MEMORY_OPERATIONS = ["capture", "revise", "refresh", "suppress"] as const;
export const MEMORY_EDGE_RELATIONS = ["revises", "refreshes", "suppresses", "derived_from"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryLifecycleState = (typeof MEMORY_LIFECYCLE_STATES)[number];
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];
export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];
export type MemoryEdgeRelation = (typeof MEMORY_EDGE_RELATIONS)[number];

export type MemoryActor = {
  actor_type: string | null;
  actor_id: string | null;
};

export type MemoryLifecycleSnapshot = {
  kind: MemoryKind;
  lifecycle_state: MemoryLifecycleState;
  scope_type: MemoryScopeType;
  scope_key: string | null;
  actor_type: string | null;
  actor_id: string | null;
  confidence_score: number | null;
  utility_score: number | null;
  canonical_key: string | null;
  root_memory_id: string | null;
  current_version: number;
  last_accessed_at: number | null;
  suppressed_at: number | null;
  consolidated_at: number | null;
  promoted_at: number | null;
  expires_at: number | null;
  revised_at: number | null;
};

export function normalizeMemoryKind(raw: unknown): MemoryKind {
  return raw === "semantic" || raw === "org_knowledge" ? raw : "episodic";
}

export function normalizeLifecycleState(raw: unknown): MemoryLifecycleState {
  return raw === "suppressed" || raw === "consolidated" || raw === "promoted" ? raw : "active";
}

export function normalizeScopeType(raw: unknown): MemoryScopeType {
  return raw === "tenant" || raw === "org" ? raw : "project";
}
