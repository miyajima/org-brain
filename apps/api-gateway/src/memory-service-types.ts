import type { MemorySearchMode, MemoryWorkType } from "@org-brain/shared";

export type MemoryRow = {
  id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: string;
  external_key: string | null;
  created_at: number;
  actor_type?: string | null;
  actor_id?: string | null;
  kind?: string | null;
  lifecycle_state?: string | null;
  current_version?: number | null;
  last_accessed_at?: number | null;
  confidence_score?: number | null;
  utility_score?: number | null;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
  permissions_json?: string | null;
  source_refs_json?: string | null;
  conflicts_json?: string | null;
  owner_principal?: string | null;
  created_by_principal?: string | null;
  deleted_at?: number | null;
  deleted_by_principal?: string | null;
  delete_reason?: string | null;
  updated_at?: number | null;
  reference_count?: number | null;
  used_count?: number | null;
  consumer_count?: number | null;
  net_saved_tokens?: number | null;
  injected_tokens?: number | null;
  reuse_rule?: string | null;
  capture_origin?: string | null;
  capture_route?: string | null;
  capture_batch_id?: string | null;
  verification_state?: string | null;
  verified_at?: number | null;
  learning_json?: string | null;
  quality_dimensions_json?: string | null;
};

export type MemorySearchRequest = {
  tenant_id?: string;
  project_id?: string | null;
  q?: string;
  limit?: number;
  rewrite_query?: boolean;
  search_mode?: MemorySearchMode;
  include_history?: boolean;
  include_suppressed?: boolean;
  at?: number;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
  retrieval_profile?: "default" | "lexical" | "hybrid" | "structured";
  generation_id?: string;
  ranking_profile_id?: string;
  task_id?: string | null;
  trace_id?: string | null;
  external_run_id?: string | null;
};

export type MemoryProfileRequest = {
  tenant_id?: string;
  project_id?: string | null;
  q?: string;
  limit_durable?: number;
  limit_recent?: number;
  rewrite_query?: boolean;
  search_mode?: MemorySearchMode;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
};

export type PrincipalActorOptions = {
  actorPrincipal?: string | null;
  recordUsage?: boolean;
  canManageAll?: boolean;
};
