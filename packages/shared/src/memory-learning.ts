import {
  MEMORY_EVIDENCE_SELECTOR_TYPES,
  MEMORY_LEARNING_KINDS,
  MEMORY_LEARNING_MAX_EVENTS,
  MEMORY_LEARNING_SCHEMA_VERSION,
  MEMORY_LESSON_TYPES,
  normalizeMemoryLearningEvent as normalizeRuntime,
  observeMemoryLearningEvent as observeRuntime
} from "./memory-learning-runtime.mjs";

export type MemoryLessonType = "success" | "decision" | "failure";
export type MemoryLearningKind = "decision" | "constraint" | "pitfall" | "preference" | "fact";
export type MemoryEvidenceSelectorType = "command" | "file" | "doc" | "user_statement";
export type MemoryLearningEvent = {
  schema_version: 1;
  lesson_type: MemoryLessonType;
  kind: MemoryLearningKind;
  trigger: string;
  conclusion: string;
  rationale: string;
  reuse_rule: string;
  outcome: string | null;
  applicability: { target_files: string[]; components: string[] };
  evidence_selectors: Array<{ type: MemoryEvidenceSelectorType; ref: string }>;
  gaps: string[];
};
export type MemoryLearningValidation = {
  accepted: boolean;
  event_hash: string | null;
  reason_codes: string[];
  event: MemoryLearningEvent | null;
};

export function normalizeMemoryLearningEvent(
  input: unknown,
  options: { workspaceRoot?: string | null; sensitivePolicy?: { mode: "deny" | "restricted_7d"; allowed_principals: string[] } } = {}
): Promise<MemoryLearningValidation> {
  return normalizeRuntime(input, options) as Promise<MemoryLearningValidation>;
}

export function observeMemoryLearningEvent(
  input: unknown,
  options: { workspaceRoot?: string | null; sensitivePolicy?: { mode: "deny" | "restricted_7d"; allowed_principals: string[] } } = {}
): Promise<Omit<MemoryLearningValidation, "event">> {
  return observeRuntime(input, options) as Promise<Omit<MemoryLearningValidation, "event">>;
}

export {
  MEMORY_EVIDENCE_SELECTOR_TYPES,
  MEMORY_LEARNING_KINDS,
  MEMORY_LEARNING_MAX_EVENTS,
  MEMORY_LEARNING_SCHEMA_VERSION,
  MEMORY_LESSON_TYPES
};

