export function countContextTokens(value: unknown): number;
export function measureContextPayload<T>(response: T, estimate: Record<string, unknown>, key?: string): T;
export const USAGE_PURPOSES: readonly string[];
export type UsagePurpose = "task" | "audit" | "diagnostic" | "test" | "unclassified";
export function normalizeUsagePurpose(value: unknown): UsagePurpose;
