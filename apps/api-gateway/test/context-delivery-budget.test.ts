import { describe, expect, it, vi } from "vitest";
import { countContextTokens } from "@org-brain/shared";
import { memoryD1Fixture } from "./fixtures/memory-d1";
import { createDecisionMemory, confirmDecisionMemory, enrichContext } from "../src/context-engine-service";
import { recordMemoryUsageFromRequest } from "../src/memory-effect-service";
vi.mock("../src/memory-search-service", () => ({ searchMemories: vi.fn(), bestEffortMarkMemoryResultsAccessed: vi.fn() }));
import { searchMemories } from "../src/memory-search-service";
import { retrieveMemoryContext } from "../src/memory-context-service";

describe("complete context delivery and D1 usage", () => {
  it("packs whole Japanese capsules and persists only final item/version/task/purpose receipts, including empty tasks", async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      const contents = ["本番では実行しない。合成fixtureのみ。".repeat(120), "合成fixtureのみ。異常時は中止して確認する。"];
      for (const [index, content] of contents.entries()) sql.prepare(`INSERT INTO memories(
        id,tenant_id,project_id,content,summary,source,created_at,current_version)
        VALUES(?,?,?,?,?,'fixture',1,3)`).run(`memory-${index}`, "fixture", "project-a", content, "fixture policy");
      const hits = contents.map((content, index) => ({ kind: "memory", id: `memory-${index}`, score: 0.7,
        content_preview: content, summary: "fixture", memory_kind: "fact", lifecycle_state: "active", current_version: 3,
        created_at: 1, source_references: [{ ref: `fixture:${index}` }], conflicts: [], score_breakdown: { lexical: 1 } }));
      const payload = { tenant_id: "fixture", project_id: "project-a", q: "fixture policy", search_mode: "hybrid_v4", results: hits,
        meta: { returned_count: 2, top_result_ids: hits.map(hit => hit.id), top_result_ranks: [0.7, 0.7],
          retrieval: { generation_id: null, ranking_profile_id: "rank_default", degraded_reasons: [] } } };
      vi.mocked(searchMemories).mockResolvedValue(payload as never);
      const response = await retrieveMemoryContext(env, { tenant_id: "fixture", project_id: "project-a",
        task_id: "task-budget", usage_purpose: "task", q: "fixture policy", top_k: 2, token_budget: 1100 }, { actorPrincipal: "user:fixture" });
      expect(response.evidence_bundle.estimated_tokens).toBe(countContextTokens(response));
      expect(countContextTokens(response)).toBeLessThanOrEqual(1100);
      expect(response.results.map(item => item.id)).toEqual(["memory-1"]);
      expect(response.evidence_bundle.evidence[0]?.text).toBe(contents[1]);
      expect(response.meta.usage_items).toEqual([{ usage_item_id: response.meta.usage_item_ids[0],
        source_type: "memory", source_id: "memory-1", source_version: 3 }]);
      const items = sql.prepare("SELECT * FROM memory_usage_items WHERE usage_event_id=?").all(response.meta.usage_id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id: response.meta.usage_item_ids[0], source_id: "memory-1", source_version: 3,
        used_state: "unknown", used_state_source: "reported", reference_type: "injected" });
      expect(sql.prepare("SELECT * FROM memory_usage_events WHERE id=?").get(response.meta.usage_id)).toMatchObject({
        task_id: "task-budget", usage_purpose: "task", project_id: "project-a", actor_principal: "user:fixture" });
      vi.mocked(searchMemories).mockResolvedValue({ ...payload, results: [] } as never);
      const empty = await retrieveMemoryContext(env, { tenant_id: "fixture", project_id: "project-a",
        task_id: "task-miss", usage_purpose: "task", q: "fixture policy", token_budget: 1100 });
      expect(empty.meta.usage_items).toEqual([]);
      expect(sql.prepare("SELECT * FROM memory_usage_events WHERE id=?").get(empty.meta.usage_id)).toMatchObject({ task_id: "task-miss", usage_purpose: "task" });
      expect(sql.prepare("SELECT COUNT(*) AS n FROM memory_effect_events").get()?.n).toBe(0);
    } finally { sql.close(); }
  });

  it("does not persist injections if MCP additions alone exceed the envelope", async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      await expect(enrichContext(env, { tenant_id: "fixture", task: { title: "fixture" }, max_tokens: 500 }, {
        responseExtras: { prior_attempts: [{ reason: "条件を確認し異常時に中止する。".repeat(200) }] }
      })).rejects.toMatchObject({ code: "context_budget_below_envelope" });
      expect(sql.prepare("SELECT COUNT(*) AS n FROM memory_usage_events").get()?.n).toBe(0);
    } finally { sql.close(); }
  });

  it("keeps decision constraints and rationale atomic with exact source version receipts", async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      for (const [index, constraints] of [[0, Array.from({length: 24}, (_, i) => `${i}: Only synthetic fixtures. Stop on mismatch. `.repeat(8))],
        [1, ["Only synthetic fixtures; stop on mismatch."]]] as const) { const created = await createDecisionMemory(env, {
        tenant_id: "fixture", project_id: "project-a", title: `fixture policy ${index}`,
        decision: "Review synthetic fixture policy.", rationale: "Preserve the conditions with the decision.",
        constraints, known_pitfalls: ["Never execute on production."], source_refs: [{ type: "official_doc", id: `source-${index}` }],
        confirmation_state: "user_confirmed", confidence: 0.8
      });
        await confirmDecisionMemory(env, "fixture", created.decisionMemory.id, {});
      }
      const response = await enrichContext(env, { tenant_id: "fixture", project_id: "project-a", task_id: "task-decisions",
        usage_purpose: "audit", task: { title: "fixture policy" }, max_tokens: 1300 });
      expect(countContextTokens(response)).toBeLessThanOrEqual(1300);
      expect(response.meta.estimatedTokens).toBe(countContextTokens(response));
      expect(response.meta.selectedMemoryCount).toBe(response.decisionContext.length);
      expect(response.decisionContext).toHaveLength(1);
      expect(response.decisionContext[0]).toMatchObject({ title: "fixture policy 1",
        constraints: ["Only synthetic fixtures; stop on mismatch."], knownPitfalls: ["Never execute on production."] });
      expect(response.meta.usage_items).toEqual([expect.objectContaining({ source_id: response.decisionContext[0].id, source_version: 2 })]);
      expect(sql.prepare("SELECT COUNT(*) AS n FROM memory_usage_items WHERE usage_event_id=?").get(response.meta.usage_id)?.n).toBe(1);
      expect(sql.prepare("SELECT * FROM memory_usage_events WHERE id=?").get(response.meta.usage_id)).toMatchObject({ task_id: "task-decisions", usage_purpose: "audit" });
    } finally { sql.close(); }
  });

  it("rejects unrecognized purpose before writing, preserving unclassified compatibility", async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      await expect(recordMemoryUsageFromRequest(env, "fixture", { access_path: "context", request_source: "api",
        usage_purpose: "success", items: [] })).rejects.toMatchObject({ code: "invalid_usage_purpose" });
      expect(sql.prepare("SELECT COUNT(*) AS n FROM memory_usage_events").get()?.n).toBe(0);
      const usage = await recordMemoryUsageFromRequest(env, "fixture", { access_path: "context", request_source: "api", items: [] });
      expect(sql.prepare("SELECT usage_purpose FROM memory_usage_events WHERE id=?").get(usage.usage_id)?.usage_purpose).toBe("unclassified");
    } finally { sql.close(); }
  });
});
