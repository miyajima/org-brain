import {
  hashMemoryCandidateJson as hashCandidateJsonRuntime,
  planDecisionClassificationRepairRows as planDecisionClassificationRepairRowsRuntime,
  planMemoryRepairRows as planMemoryRepairRowsRuntime,
  type RuntimeDecisionClassificationRepairPlan,
  type RuntimeMemoryRepairPlan
} from "./memory-repair-core.mjs";

export type MemoryRepairRow = {
  id: string;
  tenant_id?: string;
  project_id?: string | null;
  business_category_id?: string | null;
  work_type?: string | null;
  source?: string | null;
  external_key?: string | null;
  content: string;
  summary?: string | null;
  tags_json?: string | null;
  kind?: string | null;
  lifecycle_state?: string | null;
  created_at?: number | null;
  valid_until?: number | null;
  expires_at?: number | null;
  confidence_score?: number | null;
  utility_score?: number | null;
  evidence_json?: string | null;
  source_refs_json?: string | null;
};

export type MemoryRepairOptions = {
  tenant_id?: string;
  now?: number;
  workspace_root?: string | null;
  sensitive_policy?: {
    mode: "deny" | "restricted_7d";
    allowed_principals: string[];
  };
};

export type MemoryRepairPlan = RuntimeMemoryRepairPlan;
export type DecisionClassificationRepairPlan = RuntimeDecisionClassificationRepairPlan;

export async function planMemoryRepairRows(
  rows: MemoryRepairRow[],
  options: MemoryRepairOptions = {}
): Promise<MemoryRepairPlan> {
  return planMemoryRepairRowsRuntime(rows, options);
}

export async function hashMemoryCandidateJson(candidate: Record<string, unknown>): Promise<string> {
  return hashCandidateJsonRuntime(candidate);
}

export async function planDecisionClassificationRepairRows(
  rows: Array<{
    id: string;
    project_id?: string | null;
    business_category_id?: string | null;
    work_type?: string | null;
    status?: string | null;
  }>,
  options: { tenant_id?: string } = {}
): Promise<DecisionClassificationRepairPlan> {
  return planDecisionClassificationRepairRowsRuntime(rows, options);
}
