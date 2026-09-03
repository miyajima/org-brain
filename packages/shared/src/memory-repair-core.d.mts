export type RuntimeRepairAction = {
  type: "certification_pending" | "quarantine" | "excluded";
  disposition: "certification_pending" | "quarantine" | "excluded";
  memory_id: string;
  tenant_id: string;
  reason_code: string;
  reason_codes: string[];
  project_id?: string | null;
  proposed_business_category_id: string;
  proposed_work_type: string;
  proposed_owner_principal: string | null;
  canonical_key: string | null;
  learning_event_hash: string | null;
  candidate_hash: string;
  dedupe_winner?: true;
  winner_memory_id?: string;
  created_at: number;
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
    certification_pending_count: number;
    quarantine_count: number;
    excluded_count: number;
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
