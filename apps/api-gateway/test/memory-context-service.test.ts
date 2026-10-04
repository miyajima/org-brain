import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory-search-service", () => ({
  searchMemories: vi.fn(),
  bestEffortMarkMemoryResultsAccessed: vi.fn()
}));

vi.mock("../src/memory-effect-service", () => ({
  recordMemoryUsage: vi.fn(async () => ({
    usage_id: "usage-1",
    usage_item_ids: ["item-1"],
    usage_items: [],
    verification_sampled: false
  }))
}));

import { retrieveMemoryContext } from "../src/memory-context-service";
import { searchMemories } from "../src/memory-search-service";

const search = vi.mocked(searchMemories);

function database(units: Array<Record<string, unknown>> = []) {
  const statement = {
    bind() {
      return this;
    },
    async all() {
      return { results: [] };
    }
  };
  return {
    prepare(query: string) {
      return { ...statement, async all() { return { results: query.includes("FROM memory_retrieval_units_v4") ? units : [] }; } };
    }
  };
}

function hit(id: string, breakdown: Record<string, number | null>, extra: Record<string, unknown> = {}) {
  return {
    kind: "memory",
    id,
    score: 0.4,
    content_preview: `BODY-${id}`,
    summary: `summary-${id}`,
    memory_kind: "fact",
    lifecycle_state: "active",
    current_version: 1,
    created_at: 1,
    source_references: [{ ref: `file:${id}` }],
    conflicts: [],
    score_breakdown: {
      total: 0.4,
      time: 0,
      authority: 0,
      utility: 0,
      active_components: [],
      ...breakdown
    },
    ...extra
  };
}

function searchPayload(results: ReturnType<typeof hit>[], semanticAvailable: boolean) {
  return {
    tenant_id: "default",
    project_id: null,
    q: "oauth policy",
    rewrite_query: null,
    search_mode: "hybrid_v4" as const,
    include_history: false,
    results,
    meta: {
      search_strategy: "hybrid_v4",
      matched_count: results.length,
      returned_count: results.length,
      fallback_used: !semanticAvailable,
      variant_count: 1,
      lexical_result_count: results.length,
      doc_result_count: 0,
      history_result_count: 0,
      top_result_ids: results.map((item) => item.id),
      top_result_ranks: results.map(() => 0.4),
      retrieval: {
        generation_id: null,
        semantic: { available: semanticAvailable, provider: semanticAvailable ? "test" : null },
        degraded_reasons: semanticAvailable ? [] : ["semantic_provider_unavailable"]
      }
    }
  };
}

describe("retrieveMemoryContext", () => {
  beforeEach(() => {
    search.mockReset();
  });

  it("rechecks natural task coverage after top_k and token budgeting before recording delivery", async () => {
    const q = "What rollback checks should we use and what cache rules should we use?";
    const payload = searchPayload([
      hit("rollback", { lexical: 0, semantic: 0, graph: 0 }, { content_preview: "Rollback checks require a fixture." }),
      hit("cache", { lexical: 1 }, { content_preview: "Cache rules require a checksum." })
    ], true);
    payload.q = q;
    const meta = { ...payload.meta, task_query: { applied: true, coverage: "covered", basis: "lexical_relevance", requires_parent_review: true } };
    search.mockResolvedValue({ ...payload, meta } as never);
    const missing = await retrieveMemoryContext({ OPEN_BRAIN_DB: database() } as never, { q, top_k: 1, token_budget: 512 });
    expect(missing.evidence_bundle.evidence).toEqual([]);
    expect(missing.meta.task_query?.coverage).toBe("missing");
    expect(missing.meta.usage_items).toEqual([]);
    expect(missing.meta.top_result_ids).toEqual([]);
    const covered = await retrieveMemoryContext({ OPEN_BRAIN_DB: database() } as never, { q, top_k: 2, token_budget: 512 });
    expect(covered.evidence_bundle.evidence).toHaveLength(2);
    expect(covered.meta.task_query?.coverage).toBe("covered");
  });

  it("uses a subject-matching segment instead of an unrelated first atomic projection", async () => {
    const q = "What rollback checks should we use?";
    const payload = searchPayload([hit("rollback", { lexical: 1 }, { content_preview: "Rollback checks require a fixture." })], true);
    search.mockResolvedValue({ ...payload, q, meta: { ...payload.meta, task_query: { applied: true, coverage: "covered" } } } as never);
    const env = { OPEN_BRAIN_DB: database([
      { memory_id: "rollback", unit_type: "atomic", text: "Reason: preserve synthetic scope.", extraction_state: "degraded" },
      { memory_id: "rollback", unit_type: "segment", text: "Rollback checks require a fixture. Stop on mismatch.", extraction_state: "degraded" }
    ]) };
    const response = await retrieveMemoryContext(env as never, { q, top_k: 1, token_budget: 512 });
    expect(response.meta.task_query?.coverage).toBe("covered");
    expect(response.evidence_bundle.evidence[0]?.text).toContain("Stop on mismatch");
    expect(JSON.stringify(response.evidence_bundle.evidence)).not.toContain("Reason:");
  });

  it("bounds the response to top_k references and does not return unselected bodies", async () => {
    search.mockResolvedValue(searchPayload([
      hit("kept", { lexical: 1, semantic: 0, graph: 0 }),
      hit("dropped-rank", { lexical: 1, semantic: 0, graph: 0 }),
      hit("dropped-zero", { lexical: 0, semantic: 0, graph: 0 })
    ], true) as never);
    const response = await retrieveMemoryContext({ OPEN_BRAIN_DB: database() } as never, {
      q: "oauth policy",
      top_k: 1,
      limit: 50,
      token_budget: 1200
    });
    expect(search.mock.calls[0]?.[1]).toMatchObject({ limit: 2 });
    expect(response.results).toEqual([
      expect.objectContaining({ id: "kept", source_references: [{ ref: "file:kept" }] })
    ]);
    expect(response.results[0]).not.toHaveProperty("content_preview");
    expect(response.results[0]).not.toHaveProperty("summary");
    const encoded = JSON.stringify(response);
    expect(encoded).toContain("BODY-kept");
    expect(encoded).not.toContain("BODY-dropped-rank");
    expect(encoded).not.toContain("BODY-dropped-zero");
    expect(response.evidence_bundle.evidence).toHaveLength(1);
  });

  it("does not inject an all-zero hit when semantic search did not run", async () => {
    search.mockResolvedValue(searchPayload([
      hit("no-signal", { lexical: 0, semantic: null, graph: null })
    ], false) as never);
    const response = await retrieveMemoryContext({ OPEN_BRAIN_DB: database() } as never, {
      q: "oauth policy",
      top_k: 3
    });
    expect(response.results).toEqual([]);
    expect(response.evidence_bundle.evidence).toEqual([]);
    expect(response.evidence_bundle.abstention_recommended).toBe(true);
  });

  it("keeps a graph hit and drops a confirmed lexical and semantic miss", async () => {
    search.mockResolvedValue(searchPayload([
      hit("graph", { lexical: 0, semantic: 0, graph: 0.8 }),
      hit("miss", { lexical: 0, semantic: 0, graph: 0 }),
      hit("unscored", { lexical: 0, semantic: null, graph: 0 }),
      hit("invalid", { lexical: -0.1, semantic: 0, graph: 0 })
    ], true) as never);
    const response = await retrieveMemoryContext({ OPEN_BRAIN_DB: database() } as never, {
      q: "oauth policy",
      top_k: 5
    });
    expect(response.results.map((item) => item.id)).toEqual(["graph"]);
  });

  it("keeps the legacy abstention behavior in shadow mode", async () => {
    search.mockResolvedValue(searchPayload([
      hit("ready-enough", { lexical: 1, semantic: null, graph: 0 })
    ], true) as never);
    const response = await retrieveMemoryContext({
      OPEN_BRAIN_DB: database(),
      EVIDENCE_DISPOSITION_MODE: "shadow"
    } as never, {
      q: "oauth policy",
      top_k: 3
    });
    expect(response.evidence_bundle.evidence).toEqual([]);
    expect(response.evidence_bundle.abstention_recommended).toBe(true);
    expect(response.evidence_bundle.answer_template).toBe("abstention");
    expect(response.results).toEqual([]);
  });
});
