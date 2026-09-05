export const MEMORY_EXTRACTION_REVIEW_TEXT_CONTRACT: "orgbrain-memory-extraction-review-text/v1";

export function stripMemoryCitationBlocks(content: unknown): string;
export function looksLikeMemoryExtractionFileReference(value: unknown): boolean;
export function sanitizeMemoryExtractionReviewText(content: unknown): string;
export function isSanitizedMemoryExtractionReviewText(content: unknown): boolean;
export function sanitizeMemoryExtractionReviewCase<T extends { turns?: Array<{ content: string }> }>(evaluationCase: T): T;
