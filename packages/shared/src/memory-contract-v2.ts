import {
  MEMORY_CONTRACT_V2_DECISION_TYPES,
  MEMORY_CONTRACT_V2_EVIDENCE_TYPES,
  MEMORY_CONTRACT_V2_INTENTS,
  MEMORY_CONTRACT_V2_LESSON_TYPES,
  MEMORY_CONTRACT_V2_MAX_EVENTS,
  MEMORY_CONTRACT_V2_PROMPT,
  MEMORY_CONTRACT_V2_PROMPT_ID,
  MEMORY_CONTRACT_V2_SCHEMA_VERSION,
  MEMORY_CONTRACT_V2_VERIFIER_VERSION,
  normalizeMemoryContractV2Event as normalizeRuntime,
  observeMemoryContractV2Event as observeRuntime
} from "./memory-contract-v2-runtime.mjs";

export type MemoryContractV2LessonType = "success" | "decision" | "failure";
export type MemoryContractV2CaptureIntent = "verify" | "review";
export type MemoryContractV2EvidenceType = "command" | "file" | "doc" | "user_statement" | "tool_result";
export type MemoryContractV2DecisionType = "user_choice" | "preference" | "implementation" | "governance";
export type MemoryContractV2EvidenceSelector = {
  type: MemoryContractV2EvidenceType;
  ref?: string;
  digest?: string;
  supports: string[];
};
export type MemoryContractV2Common = {
  record_type: "learning_observation";
  schema_version: 2;
  lesson_type: MemoryContractV2LessonType;
  capture_intent: MemoryContractV2CaptureIntent;
  trigger: string | null;
  applicability: { target_files: string[]; components: string[] };
  evidence_selectors: MemoryContractV2EvidenceSelector[];
  gaps: string[];
  kind: "fact" | "decision" | "preference" | "pitfall";
  conclusion: string | null;
  rationale: string | null;
  reuse_rule: string | null;
  outcome: string | null;
};
export type MemoryContractV2Success = MemoryContractV2Common & {
  lesson_type: "success";
  procedure: string | null;
  why_it_worked: string | null;
  observed_outcome: string | null;
  reuse_when: string | null;
};
export type MemoryContractV2Decision = MemoryContractV2Common & {
  lesson_type: "decision";
  decision_type: MemoryContractV2DecisionType | null;
  decision_key: string | null;
  question: string | null;
  selected_value: string | null;
  decision: string | null;
  constraints: string[];
  rationale: string | null;
  alternatives: Array<{ alternative: string; reason_rejected: string | null }>;
  reuse_when: string | null;
};
export type MemoryContractV2Failure = MemoryContractV2Common & {
  lesson_type: "failure";
  symptom: string | null;
  failed_approach: string | null;
  root_cause: string | null;
  correction: string | null;
  verified_outcome: string | null;
  avoidance_rule: string | null;
};
export type MemoryContractV2Event = MemoryContractV2Success | MemoryContractV2Decision | MemoryContractV2Failure;
export type MemoryContractV2Validation = {
  accepted: boolean;
  event_hash: string | null;
  reason_codes: string[];
  event: MemoryContractV2Event | null;
};

export function normalizeMemoryContractV2Event(
  input: unknown,
  options: { workspaceRoot?: string | null; sensitivePolicy?: { mode: "deny" | "restricted_7d"; allowed_principals: string[] } } = {}
): Promise<MemoryContractV2Validation> {
  return normalizeRuntime(input, options) as Promise<MemoryContractV2Validation>;
}

export function observeMemoryContractV2Event(
  input: unknown,
  options: { workspaceRoot?: string | null; sensitivePolicy?: { mode: "deny" | "restricted_7d"; allowed_principals: string[] } } = {}
): Promise<Omit<MemoryContractV2Validation, "event">> {
  return observeRuntime(input, options) as Promise<Omit<MemoryContractV2Validation, "event">>;
}

export {
  MEMORY_CONTRACT_V2_DECISION_TYPES,
  MEMORY_CONTRACT_V2_EVIDENCE_TYPES,
  MEMORY_CONTRACT_V2_INTENTS,
  MEMORY_CONTRACT_V2_LESSON_TYPES,
  MEMORY_CONTRACT_V2_MAX_EVENTS,
  MEMORY_CONTRACT_V2_PROMPT,
  MEMORY_CONTRACT_V2_PROMPT_ID,
  MEMORY_CONTRACT_V2_SCHEMA_VERSION,
  MEMORY_CONTRACT_V2_VERIFIER_VERSION
};

export {
  MEMORY_CONTRACT_V2_REASON_CODE_DESCRIPTIONS,
  MEMORY_CONTRACT_V2_REASON_CODES
} from "./memory-contract-v2-reason-codes.mjs";
