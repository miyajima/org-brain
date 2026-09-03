import { describe, expect, it } from "vitest";
import {
  assertMemoryExtractionInputWithinCeiling,
  buildMemoryExtractionPrompt,
  MEMORY_EXTRACTION_MAX_INPUT_TOKENS,
  memoryExtractionProviderInputUpperBound
} from "../src/memory-extraction-provider-contract";

describe("memory extraction provider input budget", () => {
  it("uses a conservative UTF-8 upper bound for the full prompt and strict schema", () => {
    const prompt = buildMemoryExtractionPrompt({
      snippets: [{ span_id: "s1", role: "user", text: "実装ではREST APIを採用する。" }],
      events: [],
      rule_proposals: [{ lesson_type: "decision", support_span_ids: ["s1.1"], gaps: ["rationale_missing"] }]
    });
    expect(assertMemoryExtractionInputWithinCeiling(prompt)).toBeLessThanOrEqual(MEMORY_EXTRACTION_MAX_INPUT_TOKENS);
  });

  it("rejects multibyte Japanese input before a provider call", () => {
    const prompt = buildMemoryExtractionPrompt({
      snippets: [{ span_id: "s1", role: "user", text: "失敗と修正。".repeat(200) }],
      events: [],
      rule_proposals: [{ lesson_type: "failure", support_span_ids: ["s1.1"], gaps: [] }]
    });
    expect(memoryExtractionProviderInputUpperBound(prompt)).toBeGreaterThan(MEMORY_EXTRACTION_MAX_INPUT_TOKENS);
    expect(() => assertMemoryExtractionInputWithinCeiling(prompt)).toThrow("input token ceiling");
  });
});
