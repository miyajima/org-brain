export const MEMORY_CONTRACT_JUDGE_PROFILES: Array<{ id: string; model_family: string; instruction: string }>;
export const MEMORY_CONTRACT_JUDGE_PROMPT_HASH: string;
export const MEMORY_CONTRACT_JUDGE_RESPONSE_SCHEMA: Record<string, unknown>;
export function buildMemoryContractJudgeRequest(candidate: unknown, profileId: string): Record<string, unknown>;
export function normalizeMemoryContractJudgeResult(profileId: string, result: unknown, modelFamily?: string | null): Record<string, unknown>;
export function runMemoryContractJudgeConsensus(candidate: unknown, runners: Record<string, Function>, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function isAiConsensusCertified(value: unknown): boolean;
