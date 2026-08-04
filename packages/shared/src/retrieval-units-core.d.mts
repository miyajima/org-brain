export const RETRIEVAL_UNIT_EXTRACTOR: string;
export const RETRIEVAL_UNIT_EXTRACTOR_V4: string;
export const RETRIEVAL_SEGMENT_MAX_RECORDS: number;
export const RETRIEVAL_SEGMENT_MAX_CHARS: number;
export const RETRIEVAL_SEGMENT_OVERLAP_RATIO: number;

export function retrievalQueryTokens(value: unknown): string[];
export function retrievalSubjectQueryTokens(value: unknown): string[];
export function retrievalUnitLexicalSpecificity(
  units: Array<{ id: string; text: string }>,
  query: string
): Map<string, number>;
export function splitRetrievalTurns(
  content: unknown
): Array<{ speaker: "user" | "assistant" | "system" | "tool" | "unknown"; text: string }>;
export function buildRetrievalUnits(record: unknown): unknown[];
export function buildRetrievalUnitsV4(record: unknown): unknown[];
export function analyzeRetrievalIntent(query: string): unknown;
export function retrievalUnitIntentBoost(
  unit: { speaker?: string | null; unit_type: string },
  intent: { speaker?: string | null; unit_types: string[] }
): number;
