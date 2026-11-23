import { expect, it, vi } from "vitest";
import { memoryD1Fixture } from "./fixtures/memory-d1";
import { retrieveMemoryContext } from "../src/memory-context-service";
import { captureMemoryItems, reviseMemory } from "../src/memory-lifecycle-service";
import { searchMemories } from "../src/memory-search-service";
import { backfillV4RetrievalUnits } from "../src/retrieval-index-service";

vi.mock("../src/memory-search-service", () => ({
  searchMemories: vi.fn(),
  bestEffortMarkMemoryResultsAccessed: vi.fn()
}));

async function setup(version: number, generationId: string | null = null) {
  const { env, sql } = memoryD1Fixture();
  try {
    const capture = await captureMemoryItems(env, {
      tenantId: "fixture",
      source: "synthetic",
      items: [{
        external_key: "version-anchor",
        project_id: "project-a",
        kind: "fact",
        content: "Fixture cache OLD policy.",
        confidence_score: 0.9,
        source_references: [{ type: "file", ref: "synthetic:policy", captured_at: 1 }]
      }]
    });
    const id = capture.items[0].memory_id;
    const revise = () => reviseMemory(env, {
      tenantId: "fixture", memoryId: id, content: "Fixture cache NEW policy."
    });
    vi.mocked(searchMemories).mockResolvedValue({
      tenant_id: "fixture", project_id: "project-a", q: "cache policy",
      results: [{
        kind: "memory", id, score: 0.9, current_version: version,
        content_preview: "Old search preview must not be trusted.", created_at: 1,
        source_references: [{ ref: "synthetic:policy" }], conflicts: [], score_breakdown: { lexical: 1 }
      }],
      meta: {
        returned_count: 1, top_result_ids: [id], top_result_ranks: [0.9],
        retrieval: { generation_id: generationId, ranking_profile_id: "rank_default", degraded_reasons: [] }
      }
    } as never);
    const read = () => retrieveMemoryContext(env, {
      tenant_id: "fixture", project_id: "project-a", q: "cache policy", token_budget: 3000
    });
    return { env, sql, id, revise, read };
  } catch (error) {
    sql.close();
    throw error;
  }
}

it("omits a candidate revised after search without recording it as delivered", async () => {
  const { env, sql, id, revise, read } = await setup(1);
  try {
    const prepare = env.OPEN_BRAIN_DB.prepare.bind(env.OPEN_BRAIN_DB);
    env.OPEN_BRAIN_DB.prepare = (query) => {
      const statement = prepare(query);
      if (query.includes("FROM memory_retrieval_units_v4")) {
        const all = statement.all.bind(statement);
        statement.all = async () => {
          await revise();
          return all();
        };
      }
      return statement;
    };
    const result = await read();
    expect(result.evidence_bundle.evidence).toEqual([]);
    expect(result.meta.usage_items).toEqual([]);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM memory_usage_items WHERE usage_event_id=?")
      .get(result.meta.usage_id)?.n).toBe(0);
    expect(sql.prepare("SELECT current_version FROM memories WHERE id=?").get(id)?.current_version).toBe(2);
  } finally {
    sql.close();
  }
});

it.each(["legacy", "stale"])("uses current original content when the projection version is %s", async (state) => {
  const { sql, id, revise, read } = await setup(2);
  try {
    await revise();
    const metadata = state === "legacy" ? "{}" : JSON.stringify({ source_memory_id: id, source_version: 1 });
    sql.prepare("UPDATE memory_retrieval_units_v4 SET text=?, metadata_json=? WHERE memory_id=?")
      .run("Unusable OLD projection.", metadata, id);

    const result = await read();
    expect(result.evidence_bundle.evidence[0]).toMatchObject({
      text: "Fixture cache NEW policy.", extraction_state: "degraded"
    });
    expect(result.meta.usage_items?.[0]?.source_version).toBe(2);
  } finally {
    sql.close();
  }
});

it.each(["v4", "gen_structured_context", "v4-backfill"])("delivers a projection written for the current version (%s)", async (lane) => {
  const generationId = lane === "gen_structured_context" ? lane : null;
  const { env, sql, id, revise, read } = await setup(2, generationId);
  try {
    await revise();
    if (lane === "v4-backfill") {
      await backfillV4RetrievalUnits(env, { tenantId: "fixture", projectId: "project-a" });
    }
    // Distinguish the projected excerpt from the original without touching its version metadata.
    if (generationId) {
      sql.prepare("UPDATE retrieval_units SET text=? WHERE source_id=? AND generation_id=?")
        .run("Current projection excerpt.", id, generationId);
    } else {
      sql.prepare("UPDATE memory_retrieval_units_v4 SET text=? WHERE memory_id=?")
        .run("Current projection excerpt.", id);
    }

    const result = await read();
    expect(result.evidence_bundle.evidence[0]?.text).toBe("Current projection excerpt.");
    expect(result.meta.usage_items?.[0]?.source_version).toBe(2);
  } finally {
    sql.close();
  }
});
