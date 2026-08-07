import { describe, expect, it } from "vitest";
import {
  getMemoryImpactExecution,
  getMemoryImpactSummary,
  reportMemoryImpact,
  startMemoryImpact
} from "../src/memory-impact-service";

class FakeStatement {
  args: unknown[] = [];

  constructor(private db: FakeD1, private sql: string) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    if (this.sql.includes("FROM tasks")) {
      const found = this.db.tasks.find((row) => row.tenant_id === this.args[0] && row.id === this.args[1]);
      return (found ?? null) as T | null;
    }
    if (this.sql.includes("reporter_principal = ?") && this.sql.includes("idempotency_key = ?")) {
      const found = this.db.events.find((row) =>
        row.tenant_id === this.args[0] && row.reporter_principal === this.args[1] && row.idempotency_key === this.args[2]
      );
      return (found ?? null) as T | null;
    }
    if (this.sql.includes("external_run_id = ?") && this.sql.includes("event_type = ?")) {
      const found = this.db.events.find((row) =>
        row.tenant_id === this.args[0] && row.external_run_id === this.args[1] && row.event_type === this.args[2]
      );
      return (found ?? null) as T | null;
    }
    if (this.sql.includes("event_type = 'eligible'")) {
      const found = this.db.events.find((row) =>
        row.tenant_id === this.args[0] && row.external_run_id === this.args[1] && row.event_type === "eligible"
      );
      return (found ?? null) as T | null;
    }
    if (this.sql.includes("event_type IN ('assessed', 'failed')")) {
      const found = this.db.events.find((row) =>
        row.tenant_id === this.args[0] && row.external_run_id === this.args[1] &&
        (row.event_type === "assessed" || row.event_type === "failed")
      );
      return (found ?? null) as T | null;
    }
    if (this.sql.includes("WHERE tenant_id = ? AND id = ?")) {
      const found = this.db.events.find((row) => row.tenant_id === this.args[0] && row.id === this.args[1]);
      return (found ?? null) as T | null;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes("SELECT id FROM memories")) {
      const tenantId = String(this.args[0]);
      const ids = new Set(this.args.slice(1).map(String));
      return { results: this.db.memories.filter((row) => row.tenant_id === tenantId && ids.has(row.id)) as T[] };
    }
    if (this.sql.includes("external_run_id = ?") && this.sql.includes("ORDER BY created_at")) {
      return {
        results: this.db.events.filter((row) => row.tenant_id === this.args[0] && row.external_run_id === this.args[1]) as T[]
      };
    }
    if (this.sql.includes("SELECT event_type, external_run_id")) {
      const [tenantId, from, to, projectId] = this.args;
      return {
        results: this.db.events.filter((row) =>
          row.tenant_id === tenantId && row.occurred_at >= Number(from) && row.occurred_at <= Number(to) &&
          (projectId === undefined || row.project_id === projectId)
        ) as T[]
      };
    }
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.includes("INSERT INTO memory_impact_events")) {
      const [
        id, tenant_id, project_id, task_id, trace_id, external_run_id, event_type,
        memory_used, avoided_lookup, memory_basis_ids_json, confidence, failure_category,
        reporter_principal, agent_name, model, idempotency_key, payload_hash, occurred_at, created_at
      ] = this.args;
      this.db.events.push({
        id, tenant_id, project_id, task_id, trace_id, external_run_id, event_type,
        memory_used, avoided_lookup, memory_basis_ids_json, confidence, failure_category,
        reporter_principal, agent_name, model, idempotency_key, payload_hash, occurred_at, created_at
      } as Record<string, any>);
    }
    return { success: true };
  }
}

class FakeD1 {
  events: Array<Record<string, any>> = [];
  tasks: Array<{ id: string; tenant_id: string }> = [];
  memories: Array<{ id: string; tenant_id: string }> = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

describe("memory impact service", () => {
  it("records, dedupes, retrieves, and summarizes a measured run", async () => {
    const db = new FakeD1();
    db.memories.push({ id: "mem-1", tenant_id: "tenant-a" });
    const env = { OPEN_BRAIN_DB: db } as any;

    const input = {
      tenant_id: "tenant-a",
      project_id: "project-a",
      external_run_id: "run-1",
      idempotency_key: "run-1:start",
      agent_name: "codex"
    };
    const started = await startMemoryImpact(env, "tenant-a", input, "agent:codex");
    const retry = await startMemoryImpact(env, "tenant-a", input, "agent:codex");
    expect(started.deduped).toBe(false);
    expect(retry.deduped).toBe(true);

    await reportMemoryImpact(env, "tenant-a", "run-1", {
      tenant_id: "tenant-a",
      idempotency_key: "run-1:report",
      memory_used: true,
      avoided_lookup: "source_search",
      memory_basis_ids: ["mem-1"],
      confidence: "high"
    }, "agent:codex");

    const execution = await getMemoryImpactExecution(env, "tenant-a", "run-1");
    expect(execution.events).toHaveLength(2);
    const summary = await getMemoryImpactSummary(env, "tenant-a", { from: 0, to: Date.now() + 1_000 });
    expect(summary).toMatchObject({
      eligible_runs: 1,
      assessed_runs: 1,
      memory_used_runs: 1,
      avoided_runs: 1,
      avoided_lookup_rate: 1
    });
  });

  it("auto-starts a failed run", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as any;
    await reportMemoryImpact(env, "tenant-a", "run-failed", {
      tenant_id: "tenant-a",
      idempotency_key: "run-failed:report",
      outcome: "failed",
      failure_category: "agent_error"
    }, "agent:codex");
    expect(db.events.map((event) => event.event_type)).toEqual(["eligible", "failed"]);
    await expect(reportMemoryImpact(env, "tenant-a", "run-failed", {
      tenant_id: "tenant-a",
      idempotency_key: "run-failed:second-report",
      memory_used: false,
      avoided_lookup: "none",
      memory_basis_ids: []
    }, "agent:codex")).rejects.toMatchObject({ status: 409 });
  });
});
