export {
  MEMORY_CONTRACT_HARD_GUARDRAILS,
  MEMORY_CONTRACT_CORPUS_MINIMUMS,
  MEMORY_CONTRACT_KPIS,
  MEMORY_CONTRACT_OPERATION_GATES,
  MEMORY_INGESTION_AUTONOMOUS_MINIMUMS,
  MEMORY_INGESTION_AUTONOMOUS_HARD_GUARDRAILS,
  MEMORY_INGESTION_AUTONOMOUS_JUDGE_PROFILES,
  MEMORY_QUALITY_AXES,
  certifyMemoryContractQuality,
  certifyMemoryQuality,
  evaluateAiJudgeConsensus,
  evaluateMemoryIngestionAutonomousQualification,
  evaluateMemoryContractMeasurement,
  evaluateMemoryContractPerformance,
  validateMemoryContractCorpus,
  wilsonInterval,
  wilsonLowerBound
} from "./memory-quality-certifier.mjs";

export type MemoryContractMeasurementInput = {
  axis: string;
  cohort?: string;
  successes: number;
  total: number;
  reask_count?: number;
  hard_violation_count?: number;
};

export type AiJudgeJudgment = {
  judge_name: string;
  model_family: string;
  verdict: "pass" | "fail";
  reason_codes?: string[];
  support?: string[];
};
