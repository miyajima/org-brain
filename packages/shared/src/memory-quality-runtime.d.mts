import type {
  MemoryQualityAssessment,
  MemoryQualityDecision,
  MemoryQualityInput,
  MemoryQualityOptions,
  MemoryUsefulnessAssessmentV1,
  MemoryUsefulnessInputV1
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
export function assessMemoryUsefulnessV1(input: MemoryUsefulnessInputV1): MemoryUsefulnessAssessmentV1;
