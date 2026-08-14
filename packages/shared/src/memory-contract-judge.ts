import {
  buildMemoryContractJudgeRequest as buildRuntimeRequest,
  isAiConsensusCertified as isRuntimeAiConsensusCertified,
  normalizeMemoryContractJudgeResult as normalizeRuntimeResult,
  runMemoryContractJudgeConsensus as runRuntimeConsensus,
  MEMORY_CONTRACT_JUDGE_PROFILES,
  MEMORY_CONTRACT_JUDGE_PROMPT_HASH,
  MEMORY_CONTRACT_JUDGE_RESPONSE_SCHEMA
} from "./memory-contract-judge.mjs";

export type MemoryContractJudgeVerdict = "pass" | "fail";
export type MemoryContractJudgeProfile = {
  id: string;
  model_family: string;
  instruction: string;
};
export type MemoryContractJudgeJudgment = {
  judge_name: string;
  model_family: string;
  verdict: MemoryContractJudgeVerdict;
  reason_codes: string[];
  support: string[];
  prompt_hash: string;
};

export const memoryContractJudgeProfiles = MEMORY_CONTRACT_JUDGE_PROFILES as MemoryContractJudgeProfile[];
export const memoryContractJudgePromptHash = MEMORY_CONTRACT_JUDGE_PROMPT_HASH;
export const memoryContractJudgeResponseSchema = MEMORY_CONTRACT_JUDGE_RESPONSE_SCHEMA;

export function buildMemoryContractJudgeRequest(candidate: unknown, profileId: string) {
  return buildRuntimeRequest(candidate, profileId);
}

export function normalizeMemoryContractJudgeResult(profileId: string, result: unknown, modelFamily?: string | null) {
  return normalizeRuntimeResult(profileId, result, modelFamily) as MemoryContractJudgeJudgment;
}

export function runMemoryContractJudgeConsensus(
  candidate: unknown,
  runners: Record<string, (request: unknown) => Promise<Record<string, unknown>>>,
  options: { model_families?: Record<string, string> } = {}
) {
  return runRuntimeConsensus(candidate, runners, options);
}

export function isAiConsensusCertified(value: unknown) {
  return isRuntimeAiConsensusCertified(value);
}
