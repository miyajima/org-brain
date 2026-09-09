import { describe, expect, it } from "vitest";
import {
  assertMemoryExtractionInputWithinCeiling,
  buildMemoryExtractionPrompt,
  MEMORY_EXTRACTION_MAX_INPUT_TOKENS,
  MEMORY_EXTRACTION_RETRIEVAL_RESERVE_BYTES,
  memoryExtractionProviderInputUpperBound,
  packMemoryExtractionSnippets
} from "../src/memory-extraction-provider-contract";

describe("memory extraction provider input budget", () => {
  it("defines content fields and decision subtypes for legacy and default packets", () => {
    for (const schema of ["learning-extraction-proposal/v1", "learning-extraction-proposal/v2"]) {
      const prompt = buildMemoryExtractionPrompt({ schema, snippets: [] });
      for (const name of ["procedure", "observed_outcome", "why_it_worked", "decision", "selected_value", "rationale", "symptom", "root_cause", "correction", "verified_outcome", "avoidance_rule", "reuse_when", "decision_type=user_choice|preference|implementation|governance"]) {
        expect(prompt).toContain(name);
      }
    }
  });

  it("states the strict evidence contract for a-plus packets", () => {
    const prompt = buildMemoryExtractionPrompt({ schema: "learning-extraction-proposal/v2", refinement_profile: "a-plus/v1", snippets: [],
      rule_proposals: [{ lesson_type: "failure", support_span_ids: ["t1", "s1", "t2"], gaps: [] }] });
    expect(prompt).toContain("Exact cited text only. Human:user; outcomes:completed tool. Keep qualifiers and supplied IDs.");
    expect(prompt).toContain("If rule_hints has failure");
    expect(prompt).toContain('"rule_hints":["failure"]');
  });
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

  it("accepts the router's bounded exact-evidence budget", () => {
    const prompt = buildMemoryExtractionPrompt({
      snippets: [{ span_id: "s1.1", role: "user", text: "a".repeat(320) }],
      events: [],
      routing: {
        disposition: "llm_candidate",
        llm_recommended: true,
        operational_history_recommended: true,
        decisions: { durable_candidate: true, operational_history: true }
      },
      rule_proposals: [],
      existing_memories: []
    });
    expect(assertMemoryExtractionInputWithinCeiling(prompt)).toBeLessThanOrEqual(MEMORY_EXTRACTION_MAX_INPUT_TOKENS);
    expect(prompt).toContain('"durable":true');
    expect(prompt).toContain('"operational":true');
  });

  it("packs ranked v3 evidence dynamically while preserving the retrieval reserve", () => {
    const packet = {
      schema: "learning-extraction-proposal/v3",
      snippets: [],
      events: [],
      routing: {
        primary_route: "llm_candidate",
        decisions: { durable_candidate: true, operational_history: false }
      },
      rule_proposals: [],
      existing_memories: []
    };
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      span_id: `s1.${index + 1}`,
      role: "user",
      text: `判断理由${index}。${"x".repeat(40)}`
    }));
    const packed = packMemoryExtractionSnippets(packet, candidates);
    expect(packed.packed_span_ids.length).toBeGreaterThan(0);
    expect(packed.packed_span_ids.length).toBeLessThanOrEqual(8);
    expect(packed.packed_span_ids).toEqual(candidates.slice(0, packed.packed_span_ids.length).map((item) => item.span_id));
    expect(packed.upper_bound + MEMORY_EXTRACTION_RETRIEVAL_RESERVE_BYTES).toBeLessThanOrEqual(MEMORY_EXTRACTION_MAX_INPUT_TOKENS);
  });
});
