export type MemoryReviewContext = {
  candidate_id: string;
  candidate_hash: string;
  source_references: Array<Record<string, unknown>>;
  conclusion?: string;
  reason_summary?: string;
  reuse_rule?: string;
};
export function screenInteractiveMemory(value: unknown, field: string, options?: {
  referenceDates?: false | { pathStart: number }; proseDates?: boolean;
}): string;
export function screenInteractiveProse(value: unknown, field: string): string;
export function screenReviewReference(value: string): string;
export function normalizeMemoryReviewContext(value: unknown): MemoryReviewContext | undefined;
