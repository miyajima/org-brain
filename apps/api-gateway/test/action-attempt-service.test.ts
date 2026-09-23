import { describe, expect, it } from "vitest";
import { actionAttemptMetricsReport, actionAttemptUseReport, preflightAction, recordActionAttempt, recordActionAttemptMetricEvent, recordActionAttemptUse, searchActionAttempts } from "../src/action-attempt-service";
import type { Env } from "../src/types";

const runtime = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec: (sql: string) => void; prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[]; run: (...args: unknown[]) => unknown
  } };
};
const { readFileSync, readdirSync } = runtime.getBuiltinModule("node:fs") as {
  readFileSync: (path: URL, encoding: "utf8") => string; readdirSync: (path: URL) => string[];
};

function fixture() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../../../migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(new URL(file, directory), "utf8"));
  }
  const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => {
    const statement = database.prepare(sql);
    return {
      first: async <T>() => statement.get(...args) as T | null,
      all: async <T>() => ({ results: statement.all(...args) as T[] }),
      run: async () => statement.run(...args)
    };
  } }) };
  return { database, env: { OPEN_BRAIN_DB: db } as unknown as Env };
}

function attempt(id: string, changes: Record<string, unknown> = {}) {
  return {
    id, project_id: "consentside", action_key: "sip:retry", action_label: "SIP gateway を再設定",
    target: "staging", conditions: { version: "v1" }, outcome: "failure",
    result_summary: "設定値が拒否された", failure_kind: "deterministic", performed_at: Date.parse("2026-08-25T00:00:00Z"),
    executed_by_type: "principal", executed_by: "user:alice",
    evidence: [{ ref_type: "task_event", ref_id: `event:${id}`, content_hash: "a".repeat(64) }],
    source: "fixture", source_key: `source:${id}`, ...changes
  };
}

describe("action attempt Cloud contract", () => {
  it("keeps public reports unverified and scopes searches to tenant and project", async () => {
    const { env } = fixture();
    const raw = attempt("report");
    const first = await recordActionAttempt(env, "tenant-a", "user:requester", raw);
    expect(first.verification_state).toBe("reported");
    expect(first.executed_by_type).toBe("unknown");
    expect((await recordActionAttempt(env, "tenant-a", "user:requester", raw)).deduplicated).toBe(true);
    expect(await searchActionAttempts(env, "tenant-b", { project_id: "consentside" })).toEqual([]);
    expect(await searchActionAttempts(env, "tenant-a", { project_id: "other" })).toEqual([]);
    expect((await preflightAction(env, "tenant-a", { project_id: "consentside", action_key: "sip:retry", conditions: { version: "v1" } })).decision).toBe("warn");
  });

  it("uses verified identity, blocks identical failed conditions and permits a correction", async () => {
    const { database, env } = fixture();
    database.prepare(`INSERT INTO user_profiles(tenant_id,principal,display_name,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).run("tenant-a", "user:alice", "A", "active", 1, 1);
    await recordActionAttempt(env, "tenant-a", "user:requester", attempt("failed"), { trusted: true });
    const rows = await searchActionAttempts(env, "tenant-a", { project_id: "consentside" });
    expect(rows[0].summary_ja).toContain("2026年8月25日にAさんが");
    expect(rows[0].requested_by).toBe("user:requester");
    const blocked = await preflightAction(env, "tenant-a", { project_id: "consentside", action_key: "sip:retry", conditions: { version: "v1" } });
    expect(blocked.decision).toBe("block");
    const feedback = await recordActionAttemptMetricEvent(env, "tenant-a", {
      project_id: "consentside", kind: "feedback", source: "mcp",
      related_event_id: blocked.preflight_event_id, feedback_verdict: "false_block",
      evidence: [{ ref_type: "task_event", ref_id: "event:feedback", content_hash: "c".repeat(64) }]
    });
    expect(feedback.verification_state).toBe("reported");
    expect((await preflightAction(env, "tenant-a", { project_id: "consentside", action_key: "sip:retry", conditions: { version: "v2" } })).decision).toBe("warn");
    expect((await preflightAction(env, "tenant-a", { project_id: "consentside", action_key: "sip:retry", conditions: { version: "v2" }, change_hypothesis: "版を変える" })).decision).toBe("allow");
    await recordActionAttempt(env, "tenant-a", "user:requester", attempt("fixed", {
      supersedes_id: "failed", outcome: "success", failure_kind: undefined,
      result_summary: "実際には成功", performed_at: Date.parse("2026-08-26T00:00:00Z")
    }), { trusted: true });
    expect((await preflightAction(env, "tenant-a", { project_id: "consentside", action_key: "sip:retry", conditions: { version: "v1" } })).decision).toBe("allow");
    const patterns = database.prepare("SELECT is_active FROM memory_failure_patterns WHERE tenant_id=?").all("tenant-a") as Array<{ is_active: number }>;
    expect(patterns).toEqual([{ is_active: 0 }]);
    const metrics = await actionAttemptMetricsReport(env, "tenant-a", "consentside");
    expect(metrics.preflight_blocks).toBe(1);
    expect(metrics.false_blocks_reported).toBe(1);
    expect(metrics.false_blocks_verified).toBe(0);
  });

  it("counts return and adoption separately without granting verified use for a public report", async () => {
    const { env } = fixture();
    await recordActionAttempt(env, "tenant-a", "user:requester", attempt("usage"));
    await recordActionAttemptUse(env, "tenant-a", { project_id: "consentside", attempt_id: "usage", stage: "returned" });
    const adoption = await recordActionAttemptUse(env, "tenant-a", { project_id: "consentside", attempt_id: "usage", stage: "adopted",
      evidence: [{ ref_type: "task_event", ref_id: "event:adoption", content_hash: "b".repeat(64) }] });
    expect(adoption.verification_state).toBe("reported");
    const report = await actionAttemptUseReport(env, "tenant-a", "consentside");
    expect(report).toEqual([
      { stage: "adopted", verification_state: "reported", count: 1 },
      { stage: "returned", verification_state: "observed", count: 1 }
    ]);
    expect((await actionAttemptMetricsReport(env, "tenant-a", "consentside")).verified_adoption_rate).toBe(0);
  });
});
