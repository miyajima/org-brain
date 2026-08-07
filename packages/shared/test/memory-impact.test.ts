import { describe, expect, it } from "vitest";
import {
  resolveMemoryTokenEstimate,
  shouldSampleMemoryEffectVerification,
  validateAvoidedLookupCategories
} from "../src/memory-impact";

describe("memory impact contracts", () => {
  it("accepts supported lookup combinations and keeps none exclusive", () => {
    expect(validateAvoidedLookupCategories(["web_search", "source_search", "web_search"]))
      .toEqual(["web_search", "source_search"]);
    expect(() => validateAvoidedLookupCategories(["none", "past_context"]))
      .toThrow(/exclusive/);
    expect(() => validateAvoidedLookupCategories(["unsupported"]))
      .toThrow(/unsupported/);
  });

  it("rejects negative gross savings while preserving negative net savings", () => {
    expect(() => resolveMemoryTokenEstimate({ gross_saved_tokens_estimate: -1 }))
      .toThrow(/invalid_token_estimate/);
    expect(() => resolveMemoryTokenEstimate({
      token_estimation_candidates: { paired_control_tokens: -1 }
    })).toThrow(/gross_saved_tokens_estimate_required/);
    expect(resolveMemoryTokenEstimate({ gross_saved_tokens_estimate: 0 }))
      .toMatchObject({ gross_saved_tokens_estimate: 0 });
  });

  it("selects the same deterministic ten percent cohort for the same tenant and usage", () => {
    expect(shouldSampleMemoryEffectVerification("tenant-a", "usage-0")).toBe(false);
    expect(shouldSampleMemoryEffectVerification("tenant-a", "usage-1")).toBe(true);
    expect(shouldSampleMemoryEffectVerification("tenant-a", "usage-4")).toBe(true);
    expect(shouldSampleMemoryEffectVerification("tenant-a", "usage-42")).toBe(false);
    const first = Array.from({ length: 10_000 }, (_, index) =>
      shouldSampleMemoryEffectVerification("tenant-a", `usage-${index}`)
    );
    const second = Array.from({ length: 10_000 }, (_, index) =>
      shouldSampleMemoryEffectVerification("tenant-a", `usage-${index}`)
    );
    expect(second).toEqual(first);
    const sampled = first.filter(Boolean).length;
    expect(sampled).toBeGreaterThanOrEqual(900);
    expect(sampled).toBeLessThanOrEqual(1_100);
  });
});
