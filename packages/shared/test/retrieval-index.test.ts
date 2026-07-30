import { describe, expect, it } from "vitest";
import { fuseRetrievalSignals } from "../src/retrieval-index";

describe("fuseRetrievalSignals", () => {
  it("filters invalid and unauthorized records before ranking", () => {
    const hits = fuseRetrievalSignals(
      [
        { id: "allowed", lexical: 0.7, created_at: 1_000, allowed: true },
        { id: "denied", lexical: 1, created_at: 1_000, allowed: false },
        { id: "expired", lexical: 1, created_at: 1_000, valid_until: 1_500 }
      ],
      { at: 2_000 }
    );

    expect(hits.map((hit) => hit.id)).toEqual(["allowed"]);
  });

  it("reports unavailable semantic scoring instead of fabricating a score", () => {
    const [hit] = fuseRetrievalSignals(
      [{ id: "memory", lexical: 0.8, semantic: 0.99, created_at: 1_000 }],
      { at: 1_000, availability: { semantic: false } }
    );

    expect(hit.score.semantic).toBeNull();
    expect(hit.score.active_components).not.toContain("semantic");
  });

  it("combines lexical, semantic, graph, time, authority, and utility signals", () => {
    const hits = fuseRetrievalSignals(
      [
        {
          id: "hybrid",
          lexical: 0.6,
          semantic: 0.9,
          graph: 0.8,
          created_at: 2_000,
          authority: 1,
          confidence: 0.9,
          utility: 0.8
        },
        {
          id: "lexical-only",
          lexical: 0.7,
          semantic: 0.1,
          graph: 0.1,
          created_at: 2_000,
          authority: 0.5,
          confidence: 0.5,
          utility: 0.5
        }
      ],
      { at: 2_000, availability: { semantic: true, graph: true } }
    );

    expect(hits[0]?.id).toBe("hybrid");
    expect(hits[0]?.score.active_components).toEqual([
      "lexical",
      "semantic",
      "graph",
      "time",
      "authority",
      "utility"
    ]);
  });
});
