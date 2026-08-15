export const MEMORY_QUALITY_AXES: string[];
export const MEMORY_CONTRACT_KPIS: string[];
export const MEMORY_CONTRACT_HARD_GUARDRAILS: string[];
export const MEMORY_CONTRACT_CORPUS_MINIMUMS: Record<string, number>;
export const MEMORY_CONTRACT_OPERATION_GATES: Record<string, number>;
export const MEMORY_INGESTION_ORACLE_MINIMUMS: Record<string, number>;
export const MEMORY_INGESTION_CALIBRATION_MINIMUMS: Record<string, number>;
export const MEMORY_INGESTION_CALIBRATION_JUDGE_CLASS_MINIMUM: number;
export const MEMORY_INGESTION_AUTONOMOUS_MINIMUMS: Record<string, number>;
export const MEMORY_INGESTION_AUTONOMOUS_HARD_GUARDRAILS: readonly string[];
export const MEMORY_INGESTION_AUTONOMOUS_JUDGE_PROFILES: readonly string[];
export function evaluateMemoryIngestionOracleQualification(input?: Record<string, unknown>): {
  certification: "oracle_qualified" | "not_qualified";
  status: "qualified" | "not_qualified" | "insufficient_evidence";
  pass: boolean;
  checks: Record<string, boolean>;
  values: Record<string, number>;
  minimums: Record<string, number>;
  dataset_id: string | null;
  dataset_sha256: string | null;
};
export function evaluateMemoryIngestionCalibrationQualification(input?: Record<string, unknown>): {
  certification: "calibration_qualified" | "not_qualified";
  status: "qualified" | "not_qualified" | "insufficient_evidence";
  pass: boolean;
  checks: Record<string, boolean>;
  values: Record<string, number>;
  minimums: Record<string, number>;
  dataset_id: string | null;
  dataset_sha256: string | null;
};
export function evaluateMemoryIngestionAutonomousQualification(input?: Record<string, unknown>): {
  certification: "autonomous_qualified" | "not_qualified";
  status: "qualified" | "not_qualified" | "insufficient_evidence";
  pass: boolean;
  checks: Record<string, boolean>;
  values: Record<string, number>;
  minimums: Record<string, number>;
  dataset_id: string | null;
  dataset_sha256: string | null;
};
export function validateMemoryContractCorpus(corpus?: Record<string, unknown>): {
  passed: boolean;
  actual: Record<string, number>;
  minimums: Record<string, number>;
  missing: Array<{ name: string; actual: number; minimum: number }>;
  split_violations: Array<{ session_hash: string; splits: string[] }>;
  privacy_passed: boolean;
};
export function wilsonLowerBound(successes: number, total: number, z?: number): number | null;
export function wilsonInterval(successes: number, total: number, z?: number): { lower: number | null; upper: number | null };
export function evaluateMemoryContractMeasurement(input?: {
  axis?: string;
  cohort?: string;
  successes?: number;
  total?: number;
  reask_count?: number;
  hard_violation_count?: number;
}, options?: { threshold?: number; reaskUpperThreshold?: number; requiredAxes?: string[]; requireCorpus?: boolean }): {
  axis: string;
  cohort: string;
  successes: number | null;
  total: number | null;
  point_estimate: number | null;
  wilson_lower: number | null;
  wilson_upper: number | null;
  reask_count: number | null;
  reask_wilson_upper: number | null;
  hard_violation_count: number | null;
  passed: boolean;
};
export function evaluateMemoryContractPerformance(input?: Record<string, number>): {
  passed: boolean;
  gates: Record<string, number>;
  values: Record<string, number>;
  checks: Record<string, boolean>;
};
export function certifyMemoryContractQuality(manifest?: {
  measurements?: unknown[];
  hard_violations?: unknown[];
  oracle_qualification?: Record<string, unknown> | null;
  calibration_qualification?: Record<string, unknown> | null;
  autonomous_qualification?: Record<string, unknown> | null;
  judgments?: unknown[];
  judge_consensus?: { pass?: boolean; judgments?: unknown[] } | null;
}, options?: { threshold?: number; reaskUpperThreshold?: number; requiredAxes?: string[]; requireCorpus?: boolean; requireJudgeConsensus?: boolean; requireOracleQualification?: boolean; requireCalibrationQualification?: boolean; requireAutonomousQualification?: boolean }): {
  schema_version: 2;
  certification: "oracle_certified" | "autonomous_qualified" | "not_certified";
  status: "certified" | "not_certified" | "insufficient_evidence";
  aggregate_score: null;
  measurements: ReturnType<typeof evaluateMemoryContractMeasurement>[];
  required_axes: string[];
  missing_axes: string[];
  corpus: ReturnType<typeof validateMemoryContractCorpus>;
  oracle_qualification: ReturnType<typeof evaluateMemoryIngestionOracleQualification>;
  calibration_qualification: ReturnType<typeof evaluateMemoryIngestionCalibrationQualification>;
  autonomous_qualification: ReturnType<typeof evaluateMemoryIngestionAutonomousQualification>;
  judge_consensus: unknown;
  hard_guardrails: Array<{ name: string; count: number; passed: boolean }>;
  threshold: number;
  reask_upper_threshold: number;
};
export function evaluateAiJudgeConsensus(judgments?: unknown[], options?: { requiredJudges?: number }): {
  certification: "ai_consensus_certified" | "not_certified";
  status: "certified" | "rejected" | "ai_review_pending/disagreed" | "insufficient_evidence";
  pass: boolean;
  required_judges: number;
  judgments: Array<{
    judge_name: string;
    model_family: string;
    verdict: string;
    reason_codes: string[];
    support: string[];
  }>;
};
export function certifyMemoryQuality(manifest: unknown, options?: { threshold?: number }): {
  schema_version: number;
  generated_at: string;
  aggregate_score: null;
  axes: Record<string, {
    status: "certified" | "not_certified" | "insufficient_evidence";
    score: number | null;
    threshold: number;
    metrics: Array<{
      name: string;
      successes: number;
      total: number;
      point_estimate: number | null;
      wilson_95_lower: number | null;
      passed: boolean;
    }>;
  }>;
};
