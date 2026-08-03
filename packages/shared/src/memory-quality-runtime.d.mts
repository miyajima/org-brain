import type {
  MemoryQualityAssessment,
  MemoryQualityDecision,
  MemoryQualityInput,
  MemoryQualityOptions
} from "./memory-quality";

export function collapseWhitespace(value: unknown): string;
export function parseTagsJson(raw: string | null | undefined): string[];
export function addTags(existing: string[], extra: string[]): string[];
export function normalizeQualityText(value: unknown): string;
export function assessMemoryUsefulness(
  input: MemoryQualityInput,
  options?: MemoryQualityOptions
): MemoryQualityAssessment;
export function classifyMemoryQuality(
  input: MemoryQualityInput,
  options?: MemoryQualityOptions
): MemoryQualityDecision;
export function isLowSignalMemory(input: MemoryQualityInput, options?: MemoryQualityOptions): boolean;
