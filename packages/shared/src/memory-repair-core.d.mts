export type RuntimeRepairAction = {
  type: "update" | "derive" | "suppress";
  memory_id: string;
  tenant_id: string;
  reason_code: string;
  project_id?: string | null;
  business_category_id?: string;
  work_type?: string;
  kind?: string;
  content?: string;
  summary?: string | null;
  external_key?: string;
  canonical_key?: string;
  candidate_hash?: string;
  root_memory_id?: string;
  derived_from?: string;
  winner_memory_id?: string;
  created_at?: number;
  [key: string]: unknown;
};

export type RuntimeMemoryRepairPlan = {
  tenant_id: string;
  scanned_count: number;
  categories: Array<{
    id: string;
    slug: string;
    label: string;
    description: string;
    source_key: string;
  }>;
  actions: RuntimeRepairAction[];
  credential_rotation_required: Array<{ memory_id: string; reason_code: "rotation_required" }>;
  stats: {
    derive_count: number;
    update_count: number;
    suppress_count: number;
    credential_count: number;
    duplicate_group_count: number;
  };
};

export type RuntimeDecisionClassificationRepairPlan = {
  tenant_id: string;
  scanned_count: number;
  categories: RuntimeMemoryRepairPlan["categories"];
  actions: Array<{
    type: "decision_update";
    decision_memory_id: string;
    tenant_id: string;
    project_id: string | null;
    business_category_id: string;
    work_type: string;
    reason_code: "classified";
  }>;
  stats: {
    update_count: number;
    unclassified_after_plan: 0;
  };
};

export function hashMemoryCandidateJson(candidate: Record<string, unknown>): Promise<string>;
export function planMemoryRepairRows<T extends object>(
  rows: T[],
  options?: {
    tenant_id?: string;
    now?: number;
    workspace_root?: string | null;
    sensitive_policy?: {
      mode: "deny" | "restricted_7d";
      allowed_principals: string[];
    };
  }
): Promise<RuntimeMemoryRepairPlan>;
export function planDecisionClassificationRepairRows<T extends object>(
  rows: T[],
  options?: { tenant_id?: string }
): Promise<RuntimeDecisionClassificationRepairPlan>;
