export const MEMORY_WORK_TYPES = [
  "implementation",
  "review",
  "debug",
  "proposal",
  "support",
  "research",
  "operations",
  "other"
] as const;

export const MEMORY_SOURCE_TYPES = ["memory", "decision_memory"] as const;
export const MEMORY_REFERENCE_TYPES = ["returned", "injected", "direct"] as const;
export const MEMORY_USED_STATES = ["used", "not_used", "unknown"] as const;
export const MEMORY_EFFECT_OUTCOMES = ["positive", "neutral", "negative", "unknown"] as const;
export const MEMORY_EFFECT_EVIDENCE_LEVELS = ["reported", "estimated", "verified", "unverifiable"] as const;
export const AVOIDED_LOOKUP_CATEGORIES = ["source_search", "web_search", "past_context", "none"] as const;
export const FAILURE_OPPORTUNITY_STATES = ["applicable", "not_applicable", "unknown"] as const;
export const RETRIEVAL_PROFILES = ["default", "lexical", "hybrid", "structured"] as const;
export const MEMORY_SEARCH_SCOPES = ["evidence", "governance", "both"] as const;

export type MemoryWorkType = (typeof MEMORY_WORK_TYPES)[number];
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];
export type MemoryReferenceType = (typeof MEMORY_REFERENCE_TYPES)[number];
export type MemoryUsedState = (typeof MEMORY_USED_STATES)[number];
export type MemoryEffectOutcome = (typeof MEMORY_EFFECT_OUTCOMES)[number];
export type MemoryEffectEvidenceLevel = (typeof MEMORY_EFFECT_EVIDENCE_LEVELS)[number];
export type AvoidedLookupCategory = (typeof AVOIDED_LOOKUP_CATEGORIES)[number];
export type FailureOpportunityState = (typeof FAILURE_OPPORTUNITY_STATES)[number];
export type RetrievalProfile = (typeof RETRIEVAL_PROFILES)[number];
export type MemorySearchScope = (typeof MEMORY_SEARCH_SCOPES)[number];

export type BusinessClassification = {
  business_category_id: string | null;
  work_type: MemoryWorkType | null;
};

export type MemoryEffectAttributionInput = {
  usage_item_id: string;
  attribution_weight: number;
};

export const MEMORY_TOKEN_ESTIMATION_PRIORITY = [
  ["paired_control", "paired_control_tokens"],
  ["safe_replay", "safe_replay_tokens"],
  ["avoided_source_or_context_size", "avoided_source_tokens"],
  ["failure_pattern_historical_median", "failure_pattern_median_tokens"],
  ["business_category_calibrated_median", "category_median_tokens"],
  ["text_size_heuristic", "text_size_heuristic_tokens"]
] as const;

export function resolveMemoryTokenEstimate(input: Record<string, unknown>): {
  gross_saved_tokens_estimate: number;
  estimation_method: string;
} {
  if (input.gross_saved_tokens_estimate !== undefined) {
    const value = Number(input.gross_saved_tokens_estimate);
    if (!Number.isFinite(value)) throw new Error("invalid_token_estimate");
    return {
      gross_saved_tokens_estimate: Math.round(value),
      estimation_method: typeof input.estimation_method === "string" && input.estimation_method.trim()
        ? input.estimation_method.trim().slice(0, 128)
        : "reported"
    };
  }
  const candidates = input.token_estimation_candidates;
  if (candidates && typeof candidates === "object" && !Array.isArray(candidates)) {
    for (const [method, field] of MEMORY_TOKEN_ESTIMATION_PRIORITY) {
      const value = Number((candidates as Record<string, unknown>)[field]);
      if (Number.isFinite(value)) {
        return { gross_saved_tokens_estimate: Math.round(value), estimation_method: method };
      }
    }
  }
  throw new Error("gross_saved_tokens_estimate_required");
}

export function validateAvoidedLookupCategories(values: readonly string[]): AvoidedLookupCategory[] {
  const normalized = [...new Set(values)];
  if (normalized.some((value) => !AVOIDED_LOOKUP_CATEGORIES.includes(value as AvoidedLookupCategory))) {
    throw new Error("avoided_lookup_categories contains an unsupported value");
  }
  if (normalized.includes("none") && normalized.length > 1) {
    throw new Error("avoided_lookup category 'none' is exclusive");
  }
  return normalized as AvoidedLookupCategory[];
}

export function shouldSampleMemoryEffectVerification(tenantId: string, usageId: string): boolean {
  let hash = 2166136261;
  const input = `${tenantId}\0${usageId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < 10;
}
