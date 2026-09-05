export const MEMORY_EXTRACTION_MAX_INPUT_TOKENS: number;
export const MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS: number;
export const MEMORY_EXTRACTION_MAX_CANDIDATES: number;
export const MEMORY_EXTRACTION_TOKEN_PROFILE: string;
export const MEMORY_EXTRACTION_RETRIEVAL_RESERVE_BYTES: number;
export const MEMORY_EXTRACTION_OUTPUT_SCHEMA: Record<string, unknown>;
export function buildMemoryExtractionPrompt(packet: Record<string, unknown>): string;
export function memoryExtractionProviderInputUpperBound(prompt: string): number;
export function assertMemoryExtractionInputWithinCeiling(prompt: string): number;
export function packMemoryExtractionSnippets<T extends { span_id: string; text: string }>(
  packet: Record<string, unknown>,
  candidates: T[],
  options?: { reserve_bytes?: number; max_snippets?: number }
): {
  packet: Record<string, unknown> & { snippets: T[] };
  upper_bound: number;
  reserve_bytes: number;
  packed_span_ids: string[];
  omitted_span_ids: string[];
};
