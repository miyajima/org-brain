import { describe, expect, it } from "vitest";
import { getMemoryMap } from "../src/memory-dashboard-service";

class MapStatement {
  constructor(private sql: string) {}
  bind(..._args: unknown[]) { return this; }

  async first<T>() {
    if (this.sql.includes("COUNT(*) AS total_count FROM memories")) return { total_count: 1 } as T;
    if (this.sql.includes("FROM decision_rationales") && this.sql.includes("confirmed_count")) {
      return { total_count: 2, confirmed_count: 1 } as T;
    }
    return null as T;
  }

  async all<T>() {
    if (this.sql.includes("WITH usage_stats AS")) {
      return { results: [{
        id: "memory-1",
        project_id: "org-brain",
        content: "A structured failure lesson",
        summary: "Failure lesson",
        kind: "pitfall",
        learning_json: JSON.stringify({ lesson_type: "failure" }),
        owner_principal: "user:owner",
        created_by_principal: "user:owner",
        updated_at: 100,
        reference_count: 0,
        used_count: 0,
        consumer_count: 0,
        net_saved_tokens: 0,
        injected_tokens: 0
      }] as T[] };
    }
    if (this.sql.includes("FROM memory_edges")) return { results: [] as T[] };
    if (this.sql.includes("FROM decision_rationales")) {
      const decisions = [{
        id: "decision-confirmed",
        memory_id: "memory-1",
        project_id: "org-brain",
        decision_type: "implementation",
        conclusion: "Use the verified path",
        reason_summary: "It was reviewed",
        status: "accepted",
        confirmation_state: "reviewed",
        confirmed_at: 190,
        confidence_score: 0.95,
        created_at: 200
      }, {
        id: "decision-inferred",
        memory_id: "memory-1",
        project_id: "org-brain",
        decision_type: "implementation",
        conclusion: "Unconfirmed alternative",
        reason_summary: "Needs review",
        status: "uncertain",
        confirmation_state: "inferred_unconfirmed",
        confirmed_at: null,
        confidence_score: 0.7,
        created_at: 150
      }];
      return {
        results: (this.sql.includes("confirmed_at IS NOT NULL") ? decisions.slice(0, 1) : decisions) as T[]
      };
    }
    if (this.sql.includes("FROM memory_entities")) return { results: [] as T[] };
    return { results: [] as T[] };
  }
}

const env = {
  OPEN_BRAIN_DB: {
    prepare(sql: string) { return new MapStatement(sql); }
  }
} as any;

describe("memory dashboard map", () => {
  it("shows only confirmed decisions by default and reports untruncated totals", async () => {
    const result = await getMemoryMap(env, {
      tenantId: "tenant-a",
      principal: "user:owner",
      scope: "org"
    });

    expect(result).toMatchObject({
      decision_count: 1,
      decision_count_total: 2,
      decision_count_confirmed: 1,
      decision_count_inferred: 1,
      decision_count_truncated: false
    });
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "memory-1", semantic_kind: "pitfall", lesson_type: "failure" }),
      expect.objectContaining({ id: "decision:decision-confirmed", semantic_kind: "decision", lesson_type: "decision" })
    ]));
    expect(result.nodes.some((node) => node.id === "decision:decision-inferred")).toBe(false);
  });

  it("includes inferred decisions only with explicit opt-in", async () => {
    const result = await getMemoryMap(env, {
      tenantId: "tenant-a",
      principal: "user:owner",
      scope: "org",
      includeInferred: true
    });

    expect(result.decision_count).toBe(2);
    expect(result.nodes.some((node) => node.id === "decision:decision-inferred")).toBe(true);
    expect(result.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "decision_rationale:decision-confirmed", inferred: false }),
      expect.objectContaining({ id: "decision_rationale:decision-inferred", inferred: true })
    ]));
  });
});
