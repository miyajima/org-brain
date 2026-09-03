export const MEMORY_QUALITY_AUDIT_CONTRACT: "memory-quality-audit/v1";

export type MemoryQualityAuditItemV1 = {
  memory_id: string;
  project_id: string | null;
  active: boolean;
  semantic_kind: string | null;
  lesson_type: string | null;
  route: string;
  reason_codes: string[];
  hard_violations: string[];
  quality_dimensions: Record<string, number>;
  coverage: Record<string, boolean>;
  row_sha256: string;
};

export function evaluateMemoryQualityAuditItemV1(row: Record<string, unknown>, options?: Record<string, unknown>): Promise<MemoryQualityAuditItemV1>;
export function evaluateMemoryQualityAuditV1(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
