import { describe, expect, it } from "vitest";
import {
  recordMemoryEffect,
  recordMemoryUsage,
  recordMemoryUsageFromRequest,
  updateMemoryUsageStates
} from "../src/memory-effect-service";
import type { Env } from "../src/types";

type Row = Record<string, unknown>;

class ImpactStatement {
  private args: unknown[] = [];

  constructor(private readonly db: ImpactD1, private readonly sql: string) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  private checkBindings() {
    expect(this.args).toHaveLength((this.sql.match(/\?/g) ?? []).length);
  }

  async all<T>() {
    this.checkBindings();
    if (this.sql.includes("FROM memories WHERE tenant_id = ? AND id = ?")) {
      const row = this.db.memories.find((item) => item.tenant_id === this.args[0] && item.id === this.args[1]);
      return { results: (row ? [row] : []) as T[] };
    }
    if (this.sql.includes("FROM decision_memories WHERE tenant_id = ? AND id = ?")) {
      const row = this.db.decisions.find((item) => item.tenant_id === this.args[0] && item.id === this.args[1]);
      return { results: (row ? [row] : []) as T[] };
    }
    if (this.sql.includes("FROM decision_memory_versions")) return { results: [] as T[] };
    if (this.sql.includes("FROM memory_impact_events")) {
      const row = this.db.impactEvents.find((item) =>
        item.tenant_id === this.args[0] &&
        item.external_run_id === this.args[1] &&
        item.event_type === "eligible"
      );
      return { results: (row ? [row] : []) as T[] };
    }
    if (this.sql.includes("FROM memory_effect_events") && this.sql.includes("idempotency_key")) {
      const row = this.db.effects.find((item) => item.tenant_id === this.args[0] && item.idempotency_key === this.args[1]);
      const usage = row
        ? this.db.usageEvents.find((item) => item.tenant_id === row.tenant_id && item.id === row.usage_event_id)
        : null;
      return { results: (row ? [{ ...row, usage_created_at: usage?.created_at }] : []) as T[] };
    }
    if (this.sql.includes("FROM memory_usage_events")) {
      const row = this.db.usageEvents.find((item) => item.tenant_id === this.args[0] && item.id === this.args[1]);
      return { results: (row ? [row] : []) as T[] };
    }
    if (this.sql.includes("FROM memory_usage_items")) {
      return {
        results: this.db.usageItems
          .filter((item) => item.tenant_id === this.args[0] && item.usage_event_id === this.args[1])
          .filter((item) => this.args.length < 3 || item.id === this.args[2])
          .map((item) => ({ id: item.id })) as T[]
      };
    }
    if (this.sql.includes("FROM memory_failure_patterns")) {
      const row = this.db.patterns.find((item) => item.tenant_id === this.args[0] && item.id === this.args[1]);
      return { results: (row ? [row] : []) as T[] };
    }
    return { results: [] as T[] };
  }

  async first<T>() {
    return (await this.all<T>()).results[0] ?? null;
  }

  async run() {
    this.checkBindings();
    if (this.sql.includes("INSERT INTO memory_usage_events")) {
      this.db.usageEvents.push({
        id: this.args[0],
        tenant_id: this.args[1],
        project_id: this.args[2],
        task_id: this.args[3],
        trace_id: this.args[4],
        external_run_id: this.args[5],
        created_at: this.args[15]
      });
    } else if (this.sql.includes("INSERT INTO memory_usage_items")) {
      this.db.usageItems.push({
        id: this.args[0],
        usage_event_id: this.args[1],
        tenant_id: this.args[2],
        source_type: this.args[3],
        source_id: this.args[4],
        used_state: this.args[9]
      });
    } else if (this.sql.includes("UPDATE memory_usage_items SET used_state")) {
      const item = this.db.usageItems.find((row) =>
        row.tenant_id === this.args[1] && row.usage_event_id === this.args[2] && row.id === this.args[3]
      );
      if (item) item.used_state = this.args[0];
    } else if (this.sql.includes("INSERT INTO memory_effect_events")) {
      this.db.effects.push({
        id: this.args[0],
        tenant_id: this.args[1],
        usage_event_id: this.args[2],
        idempotency_key: this.args[3],
        net_saved_tokens_estimate: this.args[10]
      });
    } else if (this.sql.includes("INSERT INTO memory_effect_attributions")) {
      this.db.attributions.push({
        id: this.args[0],
        tenant_id: this.args[1],
        effect_event_id: this.args[2],
        usage_item_id: this.args[3],
        attribution_weight: this.args[4],
        gross_saved_tokens: this.args[5],
        net_saved_tokens: this.args[6],
        failure_saved_tokens: this.args[7]
      });
    } else if (this.sql.includes("DELETE FROM memory_effect_daily_metrics")) {
      this.db.dailyRebuilds += 1;
    }
    return { success: true };
  }
}

class ImpactD1 {
  memories: Row[] = [{
    id: "memory-1",
    tenant_id: "tenant-a",
    current_version: 3,
    business_category_id: "category-1",
    work_type: "debug"
  }];
  decisions: Row[] = [];
  impactEvents: Row[] = [{
    tenant_id: "tenant-a",
    project_id: "org-brain",
    task_id: "task-1",
    trace_id: "trace-1",
    external_run_id: "run-1",
    event_type: "eligible"
  }];
  usageEvents: Row[] = [];
  usageItems: Row[] = [];
  effects: Row[] = [];
  attributions: Row[] = [];
  patterns: Row[] = [{ id: "failure-1", tenant_id: "tenant-a", is_active: 1 }];
  dailyRebuilds = 0;

  prepare(sql: string) {
    return new ImpactStatement(this, sql);
  }

  async batch(statements: ImpactStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

describe("memory impact service", () => {
  it("deduplicates memory references and attributes net and failure token savings", async () => {
    const db = new ImpactD1();
    const env = { OPEN_BRAIN_DB: db } as unknown as Env;
    await expect(recordMemoryUsageFromRequest(env, "tenant-a", {
      access_path: "search", request_source: "api", query_hash: "raw query text",
      items: [{ source_type: "memory", source_id: "memory-1" }]
    })).rejects.toMatchObject({ code: "invalid_query_hash" });
    const usage = await recordMemoryUsage(env, {
      id: "usage-local-1",
      tenant_id: "tenant-a",
      project_id: "org-brain",
      external_run_id: "run-1",
      access_path: "search",
      request_source: "api",
      items: [
        { id: "usage-item-local-1", source_type: "memory", source_id: "memory-1", rank: 1, score: 0.9 },
        { source_type: "memory", source_id: "memory-1", rank: 2, score: 0.8 }
      ]
    });
    expect(usage.usage_item_ids).toHaveLength(1);
    expect(usage).toMatchObject({ created: true, usage_item_ids: ["usage-item-local-1"] });
    expect(db.usageEvents[0]?.external_run_id).toBe("run-1");
    expect(db.usageEvents[0]).toMatchObject({
      project_id: "org-brain",
      task_id: "task-1",
      trace_id: "trace-1"
    });
    await expect(recordMemoryUsage(env, {
      id: "usage-wrong-project",
      tenant_id: "tenant-a",
      project_id: "other-project",
      external_run_id: "run-1",
      access_path: "search",
      request_source: "api",
      items: [{ source_type: "memory", source_id: "memory-1" }]
    })).rejects.toMatchObject({ code: "memory_impact_context_mismatch" });
    await expect(recordMemoryUsage(env, {
      id: "usage-missing-run",
      tenant_id: "tenant-a",
      external_run_id: "missing-run",
      access_path: "search",
      request_source: "api",
      items: [{ source_type: "memory", source_id: "memory-1" }]
    })).rejects.toMatchObject({ code: "memory_impact_execution_not_found" });
    const retry = await recordMemoryUsage(env, {
      id: "usage-local-1",
      tenant_id: "tenant-a",
      access_path: "search",
      request_source: "local",
      items: [{ id: "usage-item-local-1", source_type: "memory", source_id: "memory-1" }]
    });
    expect(retry).toMatchObject({ created: false, usage_item_ids: ["usage-item-local-1"] });
    await expect(updateMemoryUsageStates(env, "tenant-a", {
      usage_event_id: usage.usage_id,
      items: [{ usage_item_id: "missing", used_state: "not_used" }]
    })).rejects.toMatchObject({ code: "memory_usage_item_not_found" });
    await expect(updateMemoryUsageStates(env, "tenant-a", {
      usage_event_id: usage.usage_id,
      items: [{ usage_item_id: "usage-item-local-1", used_state: "not_used" }]
    })).resolves.toMatchObject({ updated_count: 1 });
    expect(db.usageItems[0]?.used_state).toBe("not_used");
    await expect(recordMemoryEffect(env, "tenant-a", {
      usage_event_id: usage.usage_id,
      idempotency_key: "negative-gross",
      effect_outcome: "neutral",
      gross_saved_tokens_estimate: -1
    })).rejects.toMatchObject({ code: "invalid_token_estimate" });
    await expect(recordMemoryEffect(env, "tenant-a", {
      usage_event_id: usage.usage_id,
      idempotency_key: "negative-failure",
      effect_outcome: "neutral",
      gross_saved_tokens_estimate: 0,
      failure_saved_tokens_estimate: -1
    })).rejects.toMatchObject({ code: "invalid_failure_saved_tokens_estimate" });
    await expect(recordMemoryEffect(env, "tenant-a", {
      usage_event_id: usage.usage_id,
      idempotency_key: "missing-pattern",
      effect_outcome: "neutral",
      failure_opportunity_state: "applicable"
    })).rejects.toMatchObject({ code: "failure_pattern_id_required" });
    const effect = await recordMemoryEffect(env, "tenant-a", {
      usage_event_id: usage.usage_id,
      idempotency_key: "effect-1",
      evidence_level: "verified",
      verification_ref_type: "offline_replay",
      verification_ref_id: "artifact:test-1",
      effect_outcome: "positive",
      avoided_lookup_categories: ["web_search"],
      gross_saved_tokens_estimate: 120,
      injected_tokens: 20,
      failure_opportunity_state: "applicable",
      failure_pattern_id: "failure-1",
      action_changed: true,
      alternative_executed: true,
      failure_avoided: true,
      failure_saved_tokens_estimate: 70
    });
    expect(effect).toMatchObject({ created: true, net_saved_tokens_estimate: 100 });
    expect(db.effects).toHaveLength(1);
    expect(db.attributions).toEqual([
      expect.objectContaining({
        attribution_weight: 1,
        gross_saved_tokens: 120,
        net_saved_tokens: 100,
        failure_saved_tokens: 70
      })
    ]);
    const rebuildsBeforeRetry = db.dailyRebuilds;
    await expect(recordMemoryEffect(env, "tenant-a", {
      usage_event_id: usage.usage_id,
      idempotency_key: "effect-1"
    })).resolves.toMatchObject({ effect_id: effect.effect_id, created: false });
    expect(db.dailyRebuilds).toBe(rebuildsBeforeRetry + 1);
    await expect(recordMemoryEffect(env, "tenant-a", {
      usage_event_id: usage.usage_id,
      idempotency_key: "invalid-none",
      effect_outcome: "positive",
      avoided_lookup_categories: ["none", "source_search"]
    })).rejects.toMatchObject({ code: "invalid_avoided_lookup_categories" });
  });
});
