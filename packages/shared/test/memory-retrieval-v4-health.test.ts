import { describe, expect, it } from "vitest";
import { searchTenantRetrievalUnitsV4 } from "../src/memory-retrieval";

class EmptyStatement {
  bind() {
    return this;
  }

  async all<T>() {
    return { results: [] as T[] };
  }
}

class EmptyD1 {
  prepare() {
    return new EmptyStatement();
  }
}

describe("hybrid v4 health metadata", () => {
  it("does not report provider outages when semantic and reranker channels are configured", async () => {
    const result = await searchTenantRetrievalUnitsV4(new EmptyD1() as unknown as D1Database, {
      tenantId: "default",
      projectId: "org-brain",
      q: "canonical API variable",
      semanticHits: [],
      semanticProvider: "cloudflare-workers-ai:qwen3+vectorize",
      rerankerScores: new Map(),
      rerankerProvider: "cloudflare-workers-ai:bge-reranker"
    });

    expect(result.meta.fallback_used).toBe(false);
    expect(result.meta.retrieval?.degraded_reasons ?? []).not.toEqual(expect.arrayContaining([
      "semantic_provider_unavailable",
      "atomic_extractor_not_configured",
      "segment_candidates_unavailable",
      "reranker_unavailable"
    ]));
    expect(result.meta.retrieval?.channel_candidate_counts).toEqual({
      atomic: 0,
      profile: 0,
      ledger: 0,
      timeline: 0,
      segment: 0
    });
  });
});
