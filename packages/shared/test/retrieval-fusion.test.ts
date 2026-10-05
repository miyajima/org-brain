import { describe, expect, it } from "vitest";
import { boundedRetrievalFusion } from "../src/retrieval-fusion";

describe("bounded parent channel fusion", () => {
  it("gives a verbose source the same channel contribution as one matching unit", () => {
    const verbose = Array.from({ length: 200 }, (_, i) => ({ id: `v${i}`, sourceId: "verbose" }));
    const quiet = { id: "q", sourceId: "quiet" };
    const many = boundedRetrievalFusion([{ name: "lexical", hits: [...verbose, quiet] }]);
    const one = boundedRetrievalFusion([{ name: "lexical", hits: [verbose[0], quiet] }]);
    expect(many.scores).toEqual(one.scores);
    expect(many.candidateIds).toEqual(["verbose", "quiet"]);
  });

  it("interleaves independent channels and protects one strong semantic parent within the bounded pool", () => {
    const lexical = Array.from({ length: 200 }, (_, i) => ({ id: `l${i}`, sourceId: `lexical${i}` }));
    const result = boundedRetrievalFusion([
      { name: "lexical", hits: lexical },
      { name: "semantic", hits: [{ id: "semantic-unit", sourceId: "semantic-answer", score: .92 }] },
      { name: "timeline", hits: [{ id: "time-unit", sourceId: "time-answer" }] }
    ], { candidateLimit: 3 });
    expect(result.candidateIds).toHaveLength(3);
    expect(result.candidateIds).toEqual(expect.arrayContaining(["semantic-answer", "time-answer", "lexical0"]));
    expect(result.protectedIds).toEqual(["semantic-answer"]);
    expect(result.scores.size).toBe(52);
  });

  it("does not invent semantic confidence, expand limits or multiply duplicate hits", () => {
    const result = boundedRetrievalFusion([
      { name: "semantic", hits: [{ id: "weak", sourceId: "weak", score: .1 }, { id: "unknown", sourceId: "unknown" }] },
      { name: "lexical", hits: Array.from({ length: 1000 }, (_, i) => ({ id: `l${i}`, sourceId: `p${i}` })) }
    ], { candidateLimit: 1000, perChannel: 1000 });
    expect(result.candidateIds).toHaveLength(50);
    expect(result.protectedIds).toEqual([]);
    expect(result.scores.size).toBe(52);
  });
});
