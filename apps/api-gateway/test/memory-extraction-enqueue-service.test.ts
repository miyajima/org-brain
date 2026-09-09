import { describe, expect, it } from "vitest";
import {
  __memoryExtractionEnqueueInternals,
  dispatchMemoryExtractionOutbox,
  enqueueMemoryExtraction,
  reconcileMemoryExtractionReservations,
  sweepMemoryExtractionArtifacts
} from "../src/memory-extraction-enqueue-service";
import type { Env } from "../src/types";

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  run: (...args: unknown[]) => { changes?: number | bigint };
};
type SqliteDatabase = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStatement };
const runtime = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
const { readFileSync } = runtime.getBuiltinModule("node:fs") as { readFileSync: (path: URL, encoding: string) => string };

class Statement {
  private args: unknown[] = [];
  constructor(private readonly database: SqliteDatabase, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.args) as T[] }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

class Bucket {
  objects = new Map<string, string>();
  failDeletes = new Set<string>();
  failAllDeletes = false;
  async put(key: string, value: string) { this.objects.set(key, value); return {}; }
  async list(options: { prefix?: string }) {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(options.prefix ?? ""))
        .map((key) => ({ key, uploaded: new Date(0) })),
      truncated: false
    };
  }
  async delete(key: string) {
    if (this.failAllDeletes || this.failDeletes.has(key)) throw new Error("delete failed");
    this.objects.delete(key);
  }
}

function createFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE tasks(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, capability TEXT NOT NULL,
      status TEXT NOT NULL, priority INTEGER, input_ref TEXT, output_ref TEXT, idempotency_key TEXT,
      trace_id TEXT, wait_event_type TEXT, created_by_principal TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, locked_by TEXT, locked_until INTEGER
    );
    CREATE UNIQUE INDEX idx_tasks_idem ON tasks(tenant_id, idempotency_key);
    CREATE TABLE task_events(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE capabilities(
      tenant_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      input_schema TEXT NOT NULL, output_schema TEXT NOT NULL, max_concurrency INTEGER,
      cost_limit_ms INTEGER, allowed_tools TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, name)
    );
  `);
  database.exec(readFileSync(new URL("../../../migrations/0038_memory_extraction_pipeline.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../../../migrations/0039_memory_extraction_coverage.sql", import.meta.url), "utf8"));
  const db = {
    prepare: (sql: string) => new Statement(database, sql),
    batch: async (statements: Statement[]) => {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
  const bucket = new Bucket();
  const sent: unknown[] = [];
  const env = {
    OPEN_BRAIN_DB: db,
    OPEN_BRAIN_BUCKET: bucket,
    ORG_BUS_OUT: { send: async (value: unknown) => { sent.push(value); } },
    ORGBRAIN_MEMORY_EXTRACTION_MODE: "canary",
    MEMORY_EXTRACTION_HMAC_KEYS_JSON: JSON.stringify({
      active: { version: "key-v2", key: "a".repeat(32) },
      previous: { version: "key-v1", key: "b".repeat(32) }
    }),
    MEMORY_EXTRACTION_PROVIDER_MODELS_JSON: JSON.stringify([{
      provider: "openai", model: "gpt-test", zero_retention: true, strict_json_schema: true,
      input_token_profile: "utf8_byte_upper_bound_v1"
    }])
  } as unknown as Env;
  return { database, bucket, sent, env };
}

function input(overrides: Record<string, unknown> = {}) {
  const projectId = String(overrides.project_id ?? "project-a");
  const provider = String(overrides.provider ?? "openai");
  const model = String(overrides.model ?? "gpt-test");
  const sessionHash = String(overrides.session_hash ?? "sessionhash");
  const turnHash = String(overrides.turn_hash ?? "turnhash");
  return {
    project_id: projectId,
    provider,
    model,
    session_hash: sessionHash,
    turn_hash: turnHash,
    tier: "tier2",
    packet: {
      schema: "learning-extraction-proposal/v1",
      project_id: projectId,
      session_hash: sessionHash,
      turn_hash: turnHash,
      provider,
      model,
      snippets: [{ span_id: "s1.1", role: "user", text: "実装ではREST APIを採用する。" }],
      events: [],
      rule_proposals: [{ lesson_type: "decision", support_span_ids: ["s1.1"], gaps: ["rationale_missing"] }],
      limits: { input_tokens: 2_000, output_tokens: 800, candidates: 3, calls: 1 }
    },
    ...overrides
  };
}

function coverageInput() {
  const raw = input();
  (raw as any).packet = {
    ...(raw.packet as Record<string, unknown>),
    schema: "learning-extraction-proposal/v2",
    extraction_profile: "coverage/v1",
    snippets: [{ span_id: "s1@0:18", parent_span_id: "s1", role: "user", source: "user", start: 0, end: 18, order: 0, text: "実装ではREST APIを必ず使う。", text_hash: "sha256:120b663900f60276f12c303a1cf39c8325b968af746ce30cf5706c1cc221c724" }],
    coverage: {
      groups: [{ group_id: "group:s1@0:18", span_ids: ["s1@0:18"], priority: 2, important: true, latest_order: 0 }],
      pass1_group_ids: ["group:s1@0:18"], omitted: [], pool_span_count: 1, pool_text_bytes: 40
    },
    limits: { input_tokens: 2_000, output_tokens: 800, candidates: 3, calls: 2 }
  };
  return raw;
}

const options = { tenantId: "tenant-a", principal: "client:installation-a", installationId: "installation-a" };

describe("memory extraction enqueue", () => {
  it("migrates populated extraction rows without changing IDs, foreign keys, indexes, or balances", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE capabilities(tenant_id TEXT NOT NULL,name TEXT NOT NULL,version INTEGER NOT NULL,input_schema TEXT NOT NULL,output_schema TEXT NOT NULL,max_concurrency INTEGER,cost_limit_ms INTEGER,allowed_tools TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,name));
    `);
    database.exec(readFileSync(new URL("../../../migrations/0038_memory_extraction_pipeline.sql", import.meta.url), "utf8"));
    database.prepare("INSERT INTO memory_extraction_runs(id,tenant_id,project_id,installation_id,task_id,execution_status,provider,model,packet_hash,cache_key,key_version,schema_version,contract_hash,prompt_version,redaction_version,prefilter_version,reserved_tokens,staging_r2_key,created_at,updated_at,staging_expires_at,capsule_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("run-old", "tenant-a", "project-a", "installation-a", "task-old", "reserved", "openai", "gpt-test", "packet", "cache", "key", "v2", "contract", "prompt", "redaction", "prefilter", 2_800, "staging", 1, 1, 2, 3);
    database.prepare("INSERT INTO memory_extraction_token_buckets VALUES(?,?,?,?,?,?,?)").run("tenant-a", "2026-09", "tier2", 10_000, 2_800, 125, 1);
    database.prepare("INSERT INTO memory_extraction_token_reservations(tenant_id,run_id,utc_month,tier,reserved_tokens,applied,settled,created_at) VALUES(?,?,?,?,?,1,0,?)").run("tenant-a", "run-old", "2026-09", "tier2", 2_800, 1);
    database.prepare("INSERT INTO memory_extraction_outbox(id,tenant_id,run_id,task_id,envelope_json,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("out-old", "tenant-a", "run-old", "task-old", "{}", 1, 1, 1);
    database.exec(readFileSync(new URL("../../../migrations/0039_memory_extraction_coverage.sql", import.meta.url), "utf8"));
    expect(database.prepare("SELECT id, reserved_tokens, extraction_profile FROM memory_extraction_runs").get()).toEqual({ id: "run-old", reserved_tokens: 2_800, extraction_profile: null });
    expect(database.prepare("SELECT reserved_tokens, consumed_tokens FROM memory_extraction_token_buckets").get()).toEqual({ reserved_tokens: 2_800, consumed_tokens: 125 });
    expect(database.prepare("SELECT run_id FROM memory_extraction_token_reservations").get()).toEqual({ run_id: "run-old" });
    expect(database.prepare("SELECT run_id FROM memory_extraction_outbox").get()).toEqual({ run_id: "run-old" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memory_extraction_%' ORDER BY name").all().map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["idx_memory_extraction_outbox_dispatch", "idx_memory_extraction_passes_state", "idx_memory_extraction_runs_execution", "idx_memory_extraction_runs_expiry", "idx_memory_extraction_runs_project"]));
    expect(database.prepare("SELECT cost_limit_ms FROM capabilities WHERE name='memory_extraction'").get()).toEqual({ cost_limit_ms: 90_000 });
  });

  it("accepts legacy v1/v2 packets but rejects an incomplete v3 contract", () => {
    for (const schema of ["learning-extraction-proposal/v1", "learning-extraction-proposal/v2"]) {
      const raw = input();
      (raw.packet as Record<string, unknown>).schema = schema;
      expect(__memoryExtractionEnqueueInternals.parseInput(raw).packet.schema).toBe(schema);
    }
    const raw = input();
    (raw.packet as Record<string, unknown>).schema = "learning-extraction-proposal/v3";
    expect(() => __memoryExtractionEnqueueInternals.parseInput(raw)).toThrow("v3_routing_invalid");
  });

  it("uses UTC calendar months for token buckets", () => {
    expect(__memoryExtractionEnqueueInternals.utcMonth(Date.parse("2026-08-31T23:59:59.999Z"))).toBe("2026-08");
    expect(__memoryExtractionEnqueueInternals.utcMonth(Date.parse("2026-09-01T00:00:00.000Z"))).toBe("2026-09");
  });

  it("atomically reserves 2800 tokens, creates task/outbox, and deduplicates by tenant HMAC", async () => {
    const { database, bucket, sent, env } = createFixture();
    const first = await enqueueMemoryExtraction(env, input(), options);
    const duplicate = await enqueueMemoryExtraction(env, input(), options);

    expect(first).toMatchObject({ execution_status: "reserved", outcome: null, reserved_tokens: 2_800, cache_hit: false });
    expect(duplicate).toMatchObject({ run_id: first.run_id, reserved_tokens: 0, cache_hit: true });
    expect(sent).toHaveLength(1);
    expect(database.prepare("SELECT reserved_tokens, consumed_tokens FROM memory_extraction_token_buckets").get())
      .toEqual({ reserved_tokens: 2_800, consumed_tokens: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT state FROM memory_extraction_outbox").get()).toEqual({ state: "sent" });
    expect([...bucket.objects.keys()].filter((key) => key.includes("/staging/"))).toHaveLength(1);
  });

  it("requires an exact coverage allowlist match and reserves the full two-pass budget", async () => {
    const fixture = createFixture();
    await expect(enqueueMemoryExtraction(fixture.env, coverageInput(), options)).rejects.toMatchObject({
      status: 403, code: "memory_extraction_coverage_not_allowlisted"
    });
    expect(fixture.bucket.objects.size).toBe(0);
    fixture.env.MEMORY_EXTRACTION_COVERAGE_ALLOWLIST_JSON = JSON.stringify([{
      tenant_id: options.tenantId, project_id: "project-a", installation_id: options.installationId
    }]);
    const queued = await enqueueMemoryExtraction(fixture.env, coverageInput(), options);
    expect(queued).toMatchObject({ execution_status: "reserved", reserved_tokens: 5_600, cache_hit: false });
    expect(fixture.database.prepare("SELECT extraction_profile, reserved_tokens, length(prompt_policy_hash) AS prompt_hash_length, length(verifier_policy_hash) AS verifier_hash_length, length(execution_policy_hash) AS execution_hash_length FROM memory_extraction_runs").get()).toEqual({
      extraction_profile: "coverage/v1", reserved_tokens: 5_600, prompt_hash_length: 71, verifier_hash_length: 71, execution_hash_length: 71
    });
    expect((fixture.sent[0] as any).payload.constraints).toEqual({ reserved_tokens: 5_600, calls: 2 });
    const stored = JSON.parse([...fixture.bucket.objects.values()][0]);
    // Load the consumer at runtime to exercise the wire contract across TS project boundaries.
    const runnerPath = "../../cap-runner/src/capabilities/memory-extraction.ts";
    const { __memoryExtractionInternals } = await import(runnerPath);
    const parsed = __memoryExtractionInternals.parseInput(stored, { tenantId: options.tenantId });
    expect(parsed.run_id).toBe(queued.run_id);
    expect(parsed.extraction_profile).toBe("coverage/v1");
  });

  it("fails closed before R2/Queue for model unavailability and rejects Tier 3 on the extraction route", async () => {
    const unavailable = createFixture();
    unavailable.env.MEMORY_EXTRACTION_PROVIDER_MODELS_JSON = "[]";
    const modelResult = await enqueueMemoryExtraction(unavailable.env, input(), options);
    expect(modelResult).toMatchObject({ execution_status: "settled", outcome: "model_unavailable", reserved_tokens: 0 });
    expect(unavailable.sent).toHaveLength(0);
    expect(unavailable.bucket.objects.size).toBe(0);

    const budget = createFixture();
    await expect(enqueueMemoryExtraction(budget.env, input({ tier: "tier3", turn_hash: "turnhash-tier3" }), options)).rejects.toMatchObject({
      code: "tier3_requires_certification_pipeline"
    });
    expect(budget.sent).toHaveLength(0);
    expect(budget.bucket.objects.size).toBe(0);
  });

  it("hard-excludes PII without retaining a packet and recovers an unsent outbox once", async () => {
    const blocked = createFixture();
    const piiInput = input();
    (piiInput.packet as Record<string, unknown>).snippets = [{ span_id: "s1", role: "user", text: "owner@example.invalid に連絡する" }];
    const excluded = await enqueueMemoryExtraction(blocked.env, piiInput, options);
    expect(excluded).toMatchObject({ outcome: "hard_excluded", reserved_tokens: 0 });
    expect(blocked.bucket.objects.size).toBe(0);

    const recovery = createFixture();
    await enqueueMemoryExtraction(recovery.env, input(), options);
    recovery.database.prepare("UPDATE memory_extraction_outbox SET state='pending', sent_at=NULL").run();
    recovery.sent.length = 0;
    const dispatched = await dispatchMemoryExtractionOutbox(recovery.env, Date.now());
    expect(dispatched.sent).toBe(1);
    expect(recovery.sent).toHaveLength(1);
    const second = await dispatchMemoryExtractionOutbox(recovery.env, Date.now());
    expect(second.sent).toBe(0);
  });

  it("records no_candidate without staging and rejects packets over the input ceiling", async () => {
    const empty = createFixture();
    const emptyInput = input();
    (emptyInput.packet as Record<string, unknown>).rule_proposals = [];
    const noCandidate = await enqueueMemoryExtraction(empty.env, emptyInput, options);
    expect(noCandidate).toMatchObject({ execution_status: "settled", outcome: "no_candidate", reserved_tokens: 0 });
    expect(empty.bucket.objects.size).toBe(0);
    expect(empty.sent).toHaveLength(0);

    const oversized = createFixture();
    const oversizedInput = input();
    (oversizedInput.packet as Record<string, unknown>).snippets = [{
      span_id: "s1",
      role: "user",
      text: "a".repeat(9_000)
    }];
    await expect(enqueueMemoryExtraction(oversized.env, oversizedInput, options)).rejects.toMatchObject({
      status: 413,
      code: "memory_extraction_input_too_large"
    });
    expect(oversized.bucket.objects.size).toBe(0);
    expect(oversized.sent).toHaveLength(0);
  });

  it("queues a high-recall router candidate even when legacy rule proposals are empty", async () => {
    const routed = createFixture();
    const routedInput = input();
    (routedInput.packet as Record<string, unknown>).rule_proposals = [];
    (routedInput.packet as Record<string, unknown>).routing = {
      disposition: "operational_history",
      llm_recommended: true,
      decisions: { durable_candidate: true, operational_history: true },
      reason_codes: ["ambiguous_durable_signal"]
    };
    const result = await enqueueMemoryExtraction(routed.env, routedInput, options);
    expect(result).toMatchObject({ execution_status: "reserved", outcome: null, reserved_tokens: 2_800 });
    expect(routed.bucket.objects.size).toBe(1);
    expect(routed.sent).toHaveLength(1);
  });

  it("honors the previous HMAC key during rotation and prevents budget over-reservation", async () => {
    const rotated = createFixture();
    rotated.env.MEMORY_EXTRACTION_HMAC_KEYS_JSON = JSON.stringify({
      active: { version: "key-v1", key: "b".repeat(32) }
    });
    const first = await enqueueMemoryExtraction(rotated.env, input(), options);
    rotated.env.MEMORY_EXTRACTION_HMAC_KEYS_JSON = JSON.stringify({
      active: { version: "key-v2", key: "a".repeat(32) },
      previous: { version: "key-v1", key: "b".repeat(32) }
    });
    const afterRotation = await enqueueMemoryExtraction(rotated.env, input(), options);
    expect(afterRotation).toMatchObject({ run_id: first.run_id, cache_hit: true, reserved_tokens: 0 });

    const constrained = createFixture();
    constrained.env.MEMORY_EXTRACTION_TIER2_MONTHLY_TOKENS = "2800";
    const accepted = await enqueueMemoryExtraction(constrained.env, input(), options);
    const rejected = await enqueueMemoryExtraction(constrained.env, input({ turn_hash: "turnhash-second" }), options);
    expect(accepted.outcome).toBeNull();
    expect(rejected).toMatchObject({ outcome: "budget_exhausted", reserved_tokens: 0 });
    expect(constrained.database.prepare("SELECT reserved_tokens FROM memory_extraction_token_buckets").get()).toEqual({ reserved_tokens: 2_800 });
  });

  it("reconciles a settled run after a budget-ledger crash and retries failed R2 deletion", async () => {
    const fixture = createFixture();
    const queued = await enqueueMemoryExtraction(fixture.env, input(), options);
    fixture.database.prepare(
      "UPDATE memory_extraction_runs SET execution_status='settled', outcome='succeeded', charged_tokens=125, settled_at=? WHERE id=?"
    ).run(Date.now(), queued.run_id);
    const reconciliation = await reconcileMemoryExtractionReservations(fixture.env, Date.now());
    expect(reconciliation).toEqual({ examined: 1, settled: 1, expired: 0 });
    expect(fixture.database.prepare("SELECT reserved_tokens, consumed_tokens FROM memory_extraction_token_buckets").get())
      .toEqual({ reserved_tokens: 0, consumed_tokens: 125 });

    const stagingKey = String(fixture.database.prepare("SELECT staging_r2_key FROM memory_extraction_runs WHERE id=?").get(queued.run_id)?.staging_r2_key);
    fixture.database.prepare("UPDATE memory_extraction_runs SET staging_expires_at=0 WHERE id=?").run(queued.run_id);
    fixture.bucket.failDeletes.add(stagingKey);
    const failedSweep = await sweepMemoryExtractionArtifacts(fixture.env, Date.now());
    expect(failedSweep.delete_failed).toBe(1);
    expect(fixture.database.prepare("SELECT staging_r2_key FROM memory_extraction_runs WHERE id=?").get(queued.run_id))
      .toEqual({ staging_r2_key: stagingKey });
    fixture.bucket.failDeletes.delete(stagingKey);
    const successfulSweep = await sweepMemoryExtractionArtifacts(fixture.env, Date.now());
    expect(successfulSweep.staging_deleted).toBe(1);
    expect(fixture.database.prepare("SELECT staging_r2_key FROM memory_extraction_runs WHERE id=?").get(queued.run_id))
      .toEqual({ staging_r2_key: "" });
  });

  it("garbage-collects an expired R2 staging orphan left by a failed D1 batch", async () => {
    const fixture = createFixture();
    const originalBatch = fixture.env.OPEN_BRAIN_DB.batch.bind(fixture.env.OPEN_BRAIN_DB);
    fixture.env.OPEN_BRAIN_DB.batch = async () => { throw new Error("simulated D1 failure"); };
    fixture.bucket.failAllDeletes = true;
    await expect(enqueueMemoryExtraction(fixture.env, input(), options)).rejects.toThrow("simulated D1 failure");
    const [orphanKey] = [...fixture.bucket.objects.keys()];
    expect(orphanKey).toContain("/memory-extraction/staging/");
    fixture.env.OPEN_BRAIN_DB.batch = originalBatch;
    fixture.bucket.failAllDeletes = false;
    const swept = await sweepMemoryExtractionArtifacts(fixture.env, Date.now());
    expect(swept.orphan_staging_examined).toBe(1);
    expect(swept.orphan_staging_deleted).toBe(1);
    expect(fixture.bucket.objects.size).toBe(0);
  });

  it("deletes expired coverage pass artifacts and clears their D1 references", async () => {
    const fixture = createFixture();
    fixture.env.MEMORY_EXTRACTION_COVERAGE_ALLOWLIST_JSON = JSON.stringify([{
      tenant_id: options.tenantId, project_id: "project-a", installation_id: options.installationId
    }]);
    const queued = await enqueueMemoryExtraction(fixture.env, coverageInput(), options);
    const passKey = `tenants/${options.tenantId}/memory-extraction/passes/${queued.run_id}/1.json`;
    fixture.bucket.objects.set(passKey, "{}");
    const now = Date.now();
    fixture.database.prepare("INSERT INTO memory_extraction_passes(tenant_id,run_id,pass_no,state,result_r2_key,charged_tokens,created_at,updated_at) VALUES(?,?,1,'succeeded',?,10,?,?)")
      .run(options.tenantId, queued.run_id, passKey, now, now);
    fixture.database.prepare("UPDATE memory_extraction_runs SET capsule_expires_at=0 WHERE id=?").run(queued.run_id);
    const swept = await sweepMemoryExtractionArtifacts(fixture.env, now);
    expect(swept.pass_results_deleted).toBe(1);
    expect(fixture.bucket.objects.has(passKey)).toBe(false);
    expect(fixture.database.prepare("SELECT result_r2_key FROM memory_extraction_passes WHERE run_id=? AND pass_no=1").get(queued.run_id)).toEqual({ result_r2_key: null });
  });

  it("expires unexecuted reservations without charge and releases the monthly bucket", async () => {
    const fixture = createFixture();
    const queued = await enqueueMemoryExtraction(fixture.env, input(), options);
    fixture.database.prepare("UPDATE memory_extraction_runs SET staging_expires_at=0 WHERE id=?").run(queued.run_id);
    const reconciled = await reconcileMemoryExtractionReservations(fixture.env, Date.now());
    expect(reconciled).toEqual({ examined: 1, settled: 1, expired: 1 });
    expect(fixture.database.prepare("SELECT execution_status, outcome, charged_tokens FROM memory_extraction_runs WHERE id=?").get(queued.run_id))
      .toEqual({ execution_status: "settled", outcome: "expired", charged_tokens: 0 });
    expect(fixture.database.prepare("SELECT reserved_tokens, consumed_tokens FROM memory_extraction_token_buckets").get())
      .toEqual({ reserved_tokens: 0, consumed_tokens: 0 });
  });

  it("charges only an uncertain running coverage pass when its reservation expires", async () => {
    const fixture = createFixture();
    fixture.env.MEMORY_EXTRACTION_COVERAGE_ALLOWLIST_JSON = JSON.stringify([{
      tenant_id: options.tenantId, project_id: "project-a", installation_id: options.installationId
    }]);
    const queued = await enqueueMemoryExtraction(fixture.env, coverageInput(), options);
    const now = Date.now();
    fixture.database.prepare("UPDATE memory_extraction_runs SET execution_status='running', staging_expires_at=0 WHERE id=?").run(queued.run_id);
    fixture.database.prepare("INSERT INTO memory_extraction_passes(tenant_id,run_id,pass_no,state,charged_tokens,created_at,updated_at) VALUES(?,?,1,'running',0,?,?)")
      .run(options.tenantId, queued.run_id, now, now);
    fixture.database.prepare("INSERT INTO memory_extraction_passes(tenant_id,run_id,pass_no,state,charged_tokens,created_at,updated_at) VALUES(?,?,2,'planned',0,?,?)")
      .run(options.tenantId, queued.run_id, now, now);

    const reconciled = await reconcileMemoryExtractionReservations(fixture.env, now);

    expect(reconciled).toEqual({ examined: 1, settled: 1, expired: 1 });
    expect(fixture.database.prepare("SELECT outcome, charged_tokens FROM memory_extraction_runs WHERE id=?").get(queued.run_id))
      .toEqual({ outcome: "outcome_unknown", charged_tokens: 2_800 });
    expect(fixture.database.prepare("SELECT pass_no,state,charged_tokens FROM memory_extraction_passes ORDER BY pass_no").all()).toEqual([
      { pass_no: 1, state: "outcome_unknown", charged_tokens: 2_800 },
      { pass_no: 2, state: "skipped", charged_tokens: 0 }
    ]);
    expect(fixture.database.prepare("SELECT reserved_tokens, consumed_tokens FROM memory_extraction_token_buckets").get())
      .toEqual({ reserved_tokens: 0, consumed_tokens: 2_800 });
  });

  it("returns the winning run as a cache hit under concurrent enqueue", async () => {
    const fixture = createFixture();
    const [first, second] = await Promise.all([
      enqueueMemoryExtraction(fixture.env, input(), options),
      enqueueMemoryExtraction(fixture.env, input(), options)
    ]);
    expect(first.run_id).toBe(second.run_id);
    expect([first.cache_hit, second.cache_hit].sort()).toEqual([false, true]);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_extraction_runs").get()).toEqual({ count: 1 });
    expect(fixture.sent).toHaveLength(1);
  });
});
