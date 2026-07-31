import type {
  MemoryKind,
  MemoryLifecycleState,
  MemoryOperation,
  MemoryScopeType
} from "./memory-lifecycle-types";

export const MEMORY_SCHEMA_VERSION = 17;

export type MemorySourceReference = {
  type: string;
  ref: string;
  title?: string;
  captured_at?: number;
};

export type MemoryEvidence = {
  type: string;
  ref: string;
  note?: string;
  weight?: number;
};

export type MemoryPermission = {
  principal_type: "principal" | "group" | "role";
  principal_id: string;
  permissions: Array<"read" | "write" | "share" | "admin" | "delete" | "export">;
};

export type MemoryRecordV2 = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  kind: MemoryKind;
  lifecycle_state: MemoryLifecycleState;
  scope_type: MemoryScopeType;
  scope_key: string | null;
  content: string;
  summary: string | null;
  tags: string[];
  entities: string[];
  source: string;
  source_references: MemorySourceReference[];
  external_key: string | null;
  actor_type: string | null;
  actor_id: string | null;
  created_at: number;
  updated_at: number;
  valid_from: number | null;
  valid_until: number | null;
  confidence_score: number | null;
  utility_score: number | null;
  content_hash: string;
  current_version: number;
  rationale: string | null;
  evidence: MemoryEvidence[];
  conflicts: string[];
  permissions: MemoryPermission[];
};

export type MemoryCaptureInput = Omit<
  MemoryRecordV2,
  "id" | "content_hash" | "current_version" | "created_at" | "updated_at"
> & {
  id?: string;
  created_at?: number;
  updated_at?: number;
};

export type MemoryRevisionInput = {
  content?: string;
  summary?: string | null;
  tags?: string[];
  entities?: string[];
  source_references?: MemorySourceReference[];
  actor_type?: string | null;
  actor_id?: string | null;
  valid_from?: number | null;
  valid_until?: number | null;
  confidence_score?: number | null;
  utility_score?: number | null;
  rationale?: string | null;
  evidence?: MemoryEvidence[];
  conflicts?: string[];
  permissions?: MemoryPermission[];
};

export type MemoryMutationResult = {
  memory_id: string;
  version: number;
  operation: MemoryOperation | "delete";
  created: boolean;
};

export type MemorySearchScore = {
  total: number;
  lexical: number;
  semantic: number | null;
  graph: number | null;
  time: number;
  authority: number;
  utility: number;
};

export type MemorySearchResultV2 = {
  memory: MemoryRecordV2;
  score: MemorySearchScore;
};

export type MemorySearchInput = {
  tenant_id: string;
  project_id?: string | null;
  query: string;
  limit?: number;
  minimum_total_score?: number | null;
  include_suppressed?: boolean;
  principal_id?: string | null;
  search_mode?: "memories" | "hybrid" | "hybrid_v2" | "hybrid_v3" | "hybrid_v4";
  at?: number;
};

export type MemoryVerification = {
  ok: boolean;
  schema_version: number;
  record_count: number;
  version_count: number;
  fts_count: number;
  content_digest: string;
  retrieval_unit_count?: number;
  retrieval_unit_fts_count?: number;
  retrieval_unit_embedding_count?: number;
  retrieval_unit_digest?: string;
  retrieval_unit_v4_count?: number;
  retrieval_unit_v4_fts_count?: number;
  retrieval_unit_v4_embedding_count?: number;
  retrieval_unit_v4_digest?: string;
  errors: string[];
};

/**
 * Canonical persistence contract. Authoritative records live here; retrieval
 * indexes and embeddings are rebuildable projections.
 */
export interface MemoryStore {
  capture(input: MemoryCaptureInput): Promise<MemoryMutationResult>;
  revise(
    tenantId: string,
    memoryId: string,
    input: MemoryRevisionInput
  ): Promise<MemoryMutationResult>;
  suppress(
    tenantId: string,
    memoryId: string,
    reason: string,
    actor?: { actor_type?: string | null; actor_id?: string | null }
  ): Promise<MemoryMutationResult>;
  delete(
    tenantId: string,
    memoryId: string,
    actor?: { actor_type?: string | null; actor_id?: string | null }
  ): Promise<MemoryMutationResult>;
  get(tenantId: string, memoryId: string): Promise<MemoryRecordV2 | null>;
  search(input: MemorySearchInput): Promise<MemorySearchResultV2[]>;
  retrieveContext(input: MemoryRetrieveContextInput): Promise<MemoryRetrieveContextResult>;
  versions(tenantId: string, memoryId: string): Promise<MemoryRecordV2[]>;
  export(tenantId: string, projectId?: string | null): AsyncIterable<MemoryRecordV2>;
  rebuildIndex(): Promise<void>;
  verify(): Promise<MemoryVerification>;
}

export type MemoryRetrieveContextInput = MemorySearchInput & {
  top_k?: number;
  token_budget?: number;
};

export type MemoryEvidenceBundleItem = {
  memory_id: string;
  text: string;
  speaker: string | null;
  session_date: number | null;
  source_reference: MemorySourceReference | null;
  source_span: { start: number | null; end: number | null };
  score: number;
  extraction_state: string;
};

export type MemoryEvidenceBundle = {
  query_at: number;
  token_budget: number;
  estimated_tokens: number;
  answer_template: "profile" | "timeline" | "multi_session" | "abstention" | "evidence";
  evidence: MemoryEvidenceBundleItem[];
  current_state: Array<Record<string, unknown>>;
  timeline: Array<Record<string, unknown>>;
  conflicts: Array<{ memory_id: string; conflict: string }>;
  missing_evidence: string[];
  abstention_recommended: boolean;
  degraded_reasons: string[];
};

export type MemoryRetrieveContextResult = {
  results: MemorySearchResultV2[];
  evidence_bundle: MemoryEvidenceBundle;
};
