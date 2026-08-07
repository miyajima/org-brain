import { describe, expect, it } from "vitest";
import { recordTaskMemoryEffect } from "../src/memory-effect-service";

class Statement {
  private args: unknown[] = [];
  constructor(private readonly db: EffectDb, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    if (this.sql.includes("idempotency_key")) return null;
    if (this.sql.includes("FROM memory_usage_events")) return { id: "usage-1" } as T;
    if (this.sql.includes("FROM memory_effect_events")) return null;
    if (this.sql.includes("FROM memory_failure_patterns")) return null;
    return null;
  }
  async all<T>() {
    if (this.sql.includes("FROM memory_usage_items")) return { results: [{ id: "item-1" }] as T[] };
    return { results: [] as T[] };
  }
  async run() {
    if (this.sql.includes("INSERT INTO memory_effect_events")) this.db.effectBindings = this.args;
    if (this.sql.includes("INSERT INTO memory_effect_attributions")) this.db.attributionBindings.push(this.args);
    return { success: true };
  }
}

class EffectDb {
  effectBindings: unknown[] | null = null;
  attributionBindings: unknown[][] = [];
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) { return Promise.all(statements.map((statement) => statement.run())); }
}

describe("task-result memory effect", () => {
  it("persists verified references and rejects a verified claim without them", async () => {
    const db = new EffectDb();
    const env = { OPEN_BRAIN_DB: db } as any;
    await expect(recordTaskMemoryEffect(env, "tenant-a", {
      usage_event_id: "usage-1",
      idempotency_key: "verified-missing-ref",
      evidence_level: "verified",
      effect_outcome: "positive"
    })).rejects.toThrow("verification_reference_required");
    const result = await recordTaskMemoryEffect(env, "tenant-a", {
      usage_event_id: "usage-1",
      idempotency_key: "verified-with-ref",
      evidence_level: "verified",
      effect_outcome: "positive",
      avoided_lookup_categories: ["web_search"],
      gross_saved_tokens_estimate: 80,
      injected_tokens: 20,
      verification_ref_type: "offline_replay",
      verification_ref_id: "artifact:task-1"
    });
    expect(result.net_saved_tokens_estimate).toBe(60);
    expect(db.effectBindings?.[22]).toBe("offline_replay");
    expect(db.effectBindings?.[23]).toBe("artifact:task-1");
    expect(db.attributionBindings).toHaveLength(1);
  });

  it("rejects negative failure token savings", async () => {
    await expect(recordTaskMemoryEffect({ OPEN_BRAIN_DB: new EffectDb() } as any, "tenant-a", {
      usage_event_id: "usage-1",
      idempotency_key: "negative-failure-savings",
      effect_outcome: "positive",
      failure_saved_tokens_estimate: -1
    })).rejects.toThrow("invalid_failure_saved_tokens_estimate");
  });
});
