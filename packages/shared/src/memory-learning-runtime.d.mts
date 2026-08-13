export const MEMORY_LEARNING_SCHEMA_VERSION: 1;
export const MEMORY_LEARNING_MAX_EVENTS: 3;
export const MEMORY_LESSON_TYPES: string[];
export const MEMORY_LEARNING_KINDS: string[];
export const MEMORY_EVIDENCE_SELECTOR_TYPES: string[];
export function normalizeMemoryLearningEvent(input: unknown, options?: Record<string, unknown>): Promise<unknown>;
export function observeMemoryLearningEvent(input: unknown, options?: Record<string, unknown>): Promise<unknown>;

