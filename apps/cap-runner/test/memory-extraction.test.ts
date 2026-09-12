import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_CONTRACT_V2_CONTRACT_HASH, sha256 } from "@org-brain/shared";
import { __memoryExtractionInternals, runMemoryExtraction } from "../src/capabilities/memory-extraction";
import type { CapabilityContext, Env } from "../src/types";

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  run: (...args: unknown[]) => { changes?: number | bigint };
};
type SqliteDatabase = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStatement };
const runtime = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};
const { readFileSync } = runtime.getBuiltinModule("node:fs") as {
  readFileSync: (path: URL, encoding: string) => string;
};

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
  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { json: async <T>() => JSON.parse(value) as T, text: async () => value };
  }
  async put(key: string, value: string) { this.objects.set(key, value); return {}; }
  async delete(key: string) { this.objects.delete(key); }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, stableValue(row[key])]));
}

async function fixture(status: "planned" | "reserved" = "reserved") {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE capabilities(
      tenant_id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      input_schema TEXT NOT NULL, output_schema TEXT NOT NULL, max_concurrency INTEGER,
      cost_limit_ms INTEGER, allowed_tools TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, name)
    );
    CREATE TABLE memory_learning_candidates(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, task_key TEXT,
      external_key TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL, prompt_contract_id TEXT, prompt_hash TEXT,
      verifier_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, reviewed_at INTEGER, UNIQUE(tenant_id, external_key)
    );
    CREATE TABLE mcp_client_installations(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_principal TEXT NOT NULL,
      client_type TEXT NOT NULL, device_label TEXT NOT NULL, purpose TEXT NOT NULL,
      status TEXT NOT NULL, access_subject_hash TEXT, enrollment_token_hash TEXT,
      enrollment_expires_at INTEGER, created_at INTEGER NOT NULL, activated_at INTEGER,
      last_used_at INTEGER, revoked_at INTEGER
    );
    CREATE TABLE memories(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, content TEXT NOT NULL,
      summary TEXT, kind TEXT NOT NULL DEFAULT 'episodic', lifecycle_state TEXT DEFAULT 'active',
      expires_at INTEGER, created_at INTEGER NOT NULL,
      permissions_json TEXT DEFAULT '[]', deleted_at INTEGER, valid_from INTEGER, valid_until INTEGER
    );
    CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, tenant_id UNINDEXED, content);
  `);
  database.exec(readFileSync(new URL("../../../migrations/0038_memory_extraction_pipeline.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../../../migrations/0039_memory_extraction_coverage.sql", import.meta.url), "utf8"));
  database.prepare("INSERT INTO mcp_client_installations(id,tenant_id,owner_principal,client_type,device_label,purpose,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("installation-a", "tenant-a", "user:test", "codex", "test", "capture", "active", Date.now());
  const packet = {
    schema: "learning-extraction-proposal/v1",
    evidence_schema: "turn-evidence/v1",
    tenant_scope: true,
    project_id: "project-a",
    session_hash: "session-hash",
    turn_hash: "turn-hash",
    provider: "openai",
    model: "gpt-test",
    snippets: [{
      span_id: "s1.1",
      role: "user",
      text: "実装ではREST APIを採用する。理由は既存クライアントとの互換性。",
      text_hash: `sha256:${"a".repeat(64)}`
    }],
    events: [],
    rule_proposals: [{ lesson_type: "decision", support_span_ids: ["s1.1"], gaps: ["question_missing", "alternatives_missing"] }],
    limits: { input_tokens: 2_000, output_tokens: 800, candidates: 3, calls: 1 }
  };
  const packetHash = `sha256:${await sha256(JSON.stringify(stableValue(packet)))}`;
  const input = {
    schema_version: 1,
    run_id: "run-a",
    tenant_id: "tenant-a",
    project_id: "project-a",
    installation_id: "installation-a",
    provider: "openai",
    model: "gpt-test",
    session_hash: "session-hash",
    turn_hash: "turn-hash",
    tier: "tier2",
    packet_hash: packetHash,
    contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
    prompt_version: "memory-extraction-prompt/v1",
    redaction_version: "turn-evidence-redaction/v1",
    prefilter_version: "episode-state-machine/v1",
    capsule_expires_at: Date.now() + 86_400_000,
    packet
  };
  const now = Date.now();
  database.prepare(
    `INSERT INTO memory_extraction_runs(
      id, tenant_id, project_id, installation_id, task_id, execution_status, provider, model,
      packet_hash, cache_key, key_version, schema_version, contract_hash, prompt_version,
      redaction_version, prefilter_version, reserved_tokens, staging_r2_key, created_at, updated_at,
      staging_expires_at, capsule_expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "run-a", "tenant-a", "project-a", "installation-a", "task-a", status,
    "openai", "gpt-test", packetHash, "cache-a", "key-v1", "learning-extraction-proposal/v1",
    MEMORY_CONTRACT_V2_CONTRACT_HASH, "memory-extraction-prompt/v1", "turn-evidence-redaction/v1",
    "episode-state-machine/v1", status === "reserved" ? 2_800 : 0, "inputs/run-a.json", now, now,
    now + 86_400_000, input.capsule_expires_at
  );
  database.prepare("INSERT INTO memory_extraction_token_buckets VALUES(?,?,?,?,?,?,?)").run(
    "tenant-a", new Date(now).toISOString().slice(0, 7), "tier2", 500_000,
    status === "reserved" ? 2_800 : 0, 0, now
  );
  if (status === "reserved") {
    database.prepare("INSERT INTO memory_extraction_token_reservations VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      "tenant-a", "run-a", new Date(now).toISOString().slice(0, 7), "tier2", 2_800, null, 1, 0, now, null
    );
  }
  const bucket = new Bucket();
  bucket.objects.set("inputs/run-a.json", JSON.stringify(input));
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
  const env = {
    OPEN_BRAIN_DB: db,
    OPEN_BRAIN_BUCKET: bucket,
    OPENAI_API_KEY: "test-key",
    MEMORY_EXTRACTION_PROVIDER_MODELS_JSON: JSON.stringify([{
      provider: "openai", model: "gpt-test", zero_retention: true, strict_json_schema: true,
      input_token_profile: "utf8_byte_upper_bound_v1"
    }])
  } as unknown as Env;
  const context = {
    env,
    tenantId: "tenant-a",
    projectId: "project-a",
    taskId: "task-a",
    capability: "memory_extraction",
    inputRef: "r2://inputs/run-a.json"
  } as CapabilityContext;
  return { database, bucket, context };
}

async function enableCoverage(fx: Awaited<ReturnType<typeof fixture>>) {
  const stored = await (await fx.bucket.get("inputs/run-a.json"))!.json<any>();
  stored.packet = {
    ...stored.packet,
    schema: "learning-extraction-proposal/v2",
    extraction_profile: "coverage/v1",
    snippets: [
      { span_id: "s1@0:18", parent_span_id: "s1", role: "user", source: "user", start: 0, end: 18, order: 0, text: "実装ではREST APIを必ず使う。", text_hash: `sha256:${await sha256("実装ではREST APIを必ず使う。")}` },
      { span_id: "s2@0:9", parent_span_id: "s2", role: "assistant", source: "assistant", start: 0, end: 9, order: 1, text: "旧方式は失敗した。", text_hash: `sha256:${await sha256("旧方式は失敗した。")}` }
    ],
    coverage: {
      groups: [
        { group_id: "g1", span_ids: ["s1@0:18"], priority: 2, important: true, latest_order: 0 },
        { group_id: "g2", span_ids: ["s2@0:9"], priority: 3, important: true, latest_order: 1 }
      ],
      pass1_group_ids: ["g1"], omitted: []
    },
    limits: { input_tokens: 2_000, output_tokens: 800, candidates: 3, calls: 2 }
  };
  stored.extraction_profile = "coverage/v1";
  stored.prompt_policy_hash = `sha256:${"1".repeat(64)}`;
  stored.verifier_policy_hash = `sha256:${"2".repeat(64)}`;
  stored.execution_policy_hash = `sha256:${"3".repeat(64)}`;
  stored.packet_hash = `sha256:${await sha256(JSON.stringify(stableValue(stored.packet)))}`;
  fx.bucket.objects.set("inputs/run-a.json", JSON.stringify(stored));
  fx.database.prepare("UPDATE memory_extraction_runs SET schema_version='learning-extraction-proposal/v2', packet_hash=?, extraction_profile='coverage/v1', prompt_policy_hash=?, verifier_policy_hash=?, execution_policy_hash=?, reserved_tokens=5600 WHERE id='run-a'")
    .run(stored.packet_hash, stored.prompt_policy_hash, stored.verifier_policy_hash, stored.execution_policy_hash);
  fx.database.prepare("UPDATE memory_extraction_token_buckets SET reserved_tokens=5600").run();
  fx.database.prepare("UPDATE memory_extraction_token_reservations SET reserved_tokens=5600").run();
  fx.context.env.MEMORY_EXTRACTION_COVERAGE_ALLOWLIST_JSON = JSON.stringify([{
    tenant_id: "tenant-a", project_id: "project-a", installation_id: "installation-a"
  }]);
  return fx;
}

function providerCandidate() {
  return {
    lesson_type: "decision" as const,
    support_span_ids: ["s1.1"],
    gaps: ["question_missing", "alternatives_missing"],
    fields: [
      { name: "trigger", values: ["実装ではREST APIを採用する。理由は既存クライアントとの互換性。"] },
      { name: "decision_type", values: ["implementation"] },
      { name: "decision", values: ["実装ではREST APIを採用する。理由は既存クライアントとの互換性。"] },
      { name: "rationale", values: ["理由は既存クライアントとの互換性。"] }
    ]
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("memory extraction capability", () => {
  it("accepts legacy schemas and rejects v3 without its routing contract", async () => {
    const { bucket, context } = await fixture();
    const stored = await (await bucket.get("inputs/run-a.json"))!.json<Record<string, unknown> & { packet: Record<string, unknown> }>();
    for (const schema of ["learning-extraction-proposal/v1", "learning-extraction-proposal/v2"]) {
      stored.packet.schema = schema;
      expect(__memoryExtractionInternals.parseInput(stored, context).packet.schema).toBe(schema);
    }
    stored.packet.schema = "learning-extraction-proposal/v3";
    expect(() => __memoryExtractionInternals.parseInput(stored, context)).toThrow("v3_routing_invalid");
  });

  it("preserves A+ profile and rejects a second call or coverage combination", async () => {
    const { bucket, context } = await fixture();
    const stored = await (await bucket.get("inputs/run-a.json"))!.json<Record<string, unknown> & { packet: Record<string, unknown> }>();
    stored.packet.schema = "learning-extraction-proposal/v2";
    stored.packet.refinement_profile = "a-plus/v1";
    expect(__memoryExtractionInternals.parseInput(stored, context).packet.refinement_profile).toBe("a-plus/v1");
    stored.packet.limits = { input_tokens: 2000, output_tokens: 800, candidates: 3, calls: 2 };
    expect(() => __memoryExtractionInternals.parseInput(stored, context)).toThrow();
    stored.packet.limits = { input_tokens: 2000, output_tokens: 800, candidates: 3, calls: 1 };
    stored.packet.extraction_profile = "coverage/v1";
    expect(() => __memoryExtractionInternals.parseInput(stored, context)).toThrow();
  });

  it("settles one review-only candidate, exact usage, and never calls the provider twice", async () => {
    const { database, bucket, context } = await fixture();
    const provider = vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({ candidates: [providerCandidate()] }),
      usage: { input_tokens: 100, output_tokens: 50 }
    }), { status: 200 }));
    vi.stubGlobal("fetch", provider);

    const result = await runMemoryExtraction(context);
    expect(result.totalTokens).toBe(150);
    const requestInit = (provider.mock.calls as unknown[][])[0]?.[1] as unknown as RequestInit;
    expect(JSON.parse(String(requestInit.body))).toMatchObject({ store: false, max_output_tokens: 800 });
    expect(database.prepare("SELECT execution_status, outcome, charged_tokens FROM memory_extraction_runs WHERE id='run-a'").get())
      .toEqual({ execution_status: "settled", outcome: "succeeded", charged_tokens: 150 });
    expect(database.prepare("SELECT status FROM memory_learning_candidates").get()).toEqual({ status: "quarantine" });
    expect(database.prepare("SELECT reserved_tokens, consumed_tokens FROM memory_extraction_token_buckets").get())
      .toEqual({ reserved_tokens: 0, consumed_tokens: 150 });
    expect(bucket.objects.has("inputs/run-a.json")).toBe(false);

    await runMemoryExtraction(context);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("runs coverage pass two once, persists both checkpoints, and settles measured usage", async () => {
    const { database, bucket, context } = await enableCoverage(await fixture());
    const first = {
      lesson_type: "decision", support_span_ids: ["s1@0:18"], gaps: [],
      fields: [{ name: "decision", values: ["実装ではREST APIを必ず使う。"] }]
    };
    const second = {
      lesson_type: "failure", support_span_ids: ["s2@0:9"], gaps: [],
      fields: [{ name: "symptom", values: ["旧方式は失敗した。"] }]
    };
    const provider = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: JSON.stringify({ candidates: [first] }), usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: JSON.stringify({ candidates: [second] }), usage: { input_tokens: 110, output_tokens: 25 } }), { status: 200 }));
    vi.stubGlobal("fetch", provider);
    const result = await runMemoryExtraction(context);
    expect(result.totalTokens).toBe(255);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(database.prepare("SELECT pass_no, state, charged_tokens, result_r2_key FROM memory_extraction_passes ORDER BY pass_no").all()).toEqual([
      expect.objectContaining({ pass_no: 1, state: "succeeded", charged_tokens: 120 }),
      expect.objectContaining({ pass_no: 2, state: "succeeded", charged_tokens: 135 })
    ]);
    expect(database.prepare("SELECT outcome, coverage_status, charged_tokens FROM memory_extraction_runs WHERE id='run-a'").get()).toEqual({ outcome: "succeeded", coverage_status: "executed", charged_tokens: 255 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_learning_candidates").get()).toEqual({ count: 2 });
    expect([...bucket.objects.keys()].filter((key) => key.includes("/passes/run-a/"))).toHaveLength(2);
  });

  it("keeps pass-one candidates when coverage pass two fails and never retries it", async () => {
    const { database, context } = await enableCoverage(await fixture());
    const first = {
      lesson_type: "decision", support_span_ids: ["s1@0:18"], gaps: [],
      fields: [{ name: "decision", values: ["実装ではREST APIを必ず使う。"] }]
    };
    const provider = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: JSON.stringify({ candidates: [first] }), usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: "not-json" }), { status: 200 }));
    vi.stubGlobal("fetch", provider);
    const result = await runMemoryExtraction(context);
    expect(result.summary).toContain("coverage failed");
    expect(database.prepare("SELECT outcome, coverage_status, charged_tokens FROM memory_extraction_runs WHERE id='run-a'").get()).toEqual({ outcome: "succeeded", coverage_status: "failed", charged_tokens: 2_920 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_learning_candidates").get()).toEqual({ count: 1 });
    await runMemoryExtraction(context);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("resumes only pass two from a persisted pass-one checkpoint", async () => {
    const fx = await enableCoverage(await fixture());
    const stored = await (await fx.bucket.get("inputs/run-a.json"))!.json<any>();
    const parsed = __memoryExtractionInternals.parseInput(stored, fx.context);
    const first = {
      lesson_type: "decision" as const, support_span_ids: ["s1@0:18"], gaps: [],
      fields: [{ name: "decision", values: ["実装ではREST APIを必ず使う。"] }]
    };
    const verification = await __memoryExtractionInternals.verifiedCandidates(parsed, [first]);
    const artifactKey = "tenants/tenant-a/memory-extraction/passes/run-a/1.json";
    const artifact = { pass_no: 1, state: "succeeded", request_hash: "sha256:checkpoint", generated: { candidates: [first], inputTokens: 100, outputTokens: 20 }, verification, input_tokens: 100, output_tokens: 20, charged_tokens: 120, error_code: null, result_r2_key: artifactKey, presented_group_ids: ["g1"], omitted_groups: [] };
    fx.bucket.objects.set(artifactKey, JSON.stringify(artifact));
    const now = Date.now();
    fx.database.prepare("INSERT INTO memory_extraction_passes(tenant_id,run_id,pass_no,state,request_hash,result_r2_key,actual_input_tokens,actual_output_tokens,charged_tokens,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("tenant-a", "run-a", 1, "succeeded", artifact.request_hash, artifactKey, 100, 20, 120, now, now, now);
    fx.database.prepare("UPDATE memory_extraction_runs SET execution_status='running' WHERE id='run-a'").run();
    const second = { lesson_type: "failure" as const, support_span_ids: ["s2@0:9"], gaps: [], fields: [{ name: "symptom", values: ["旧方式は失敗した。"] }] };
    const provider = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({ candidates: [second] }), usage: { input_tokens: 110, output_tokens: 25 } }), { status: 200 }));
    vi.stubGlobal("fetch", provider);
    const result = await runMemoryExtraction(fx.context);
    expect(result.totalTokens).toBe(255);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(fx.database.prepare("SELECT pass_no,state FROM memory_extraction_passes ORDER BY pass_no").all()).toEqual([{ pass_no: 1, state: "succeeded" }, { pass_no: 2, state: "succeeded" }]);
  });

  it("revalidates the coverage allowlist before any provider call", async () => {
    const { database, context } = await enableCoverage(await fixture());
    context.env.MEMORY_EXTRACTION_COVERAGE_ALLOWLIST_JSON = "[]";
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    await runMemoryExtraction(context);
    expect(provider).not.toHaveBeenCalled();
    expect(database.prepare("SELECT outcome, coverage_status, charged_tokens FROM memory_extraction_runs WHERE id='run-a'").get()).toEqual({ outcome: "provider_failed", coverage_status: "rejected", charged_tokens: 0 });
  });

  it("keeps coverage candidate keys independent of pass and array position", async () => {
    const fx = await enableCoverage(await fixture());
    const stored = await (await fx.bucket.get("inputs/run-a.json"))!.json<any>();
    const parsed = __memoryExtractionInternals.parseInput(stored, fx.context);
    const valid = {
      lesson_type: "decision" as const, support_span_ids: ["s1@0:18"], gaps: [],
      fields: [{ name: "decision", values: ["実装ではREST APIを必ず使う。"] }]
    };
    const first = await __memoryExtractionInternals.verifiedCandidates(parsed, [valid]);
    const shifted = await __memoryExtractionInternals.verifiedCandidates(parsed, [{ ...valid, lesson_type: "unknown" } as never, valid]);
    expect(first.candidates[0].external_key).toBe(shifted.candidates[0].external_key);
  });

  it("charges the full reservation and forbids automatic rerun after an uncertain timeout", async () => {
    const { database, context } = await fixture();
    const provider = vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); });
    vi.stubGlobal("fetch", provider);

    const result = await runMemoryExtraction(context);
    expect(result.summary).toContain("outcome_unknown");
    expect(database.prepare("SELECT outcome, charged_tokens FROM memory_extraction_runs WHERE id='run-a'").get())
      .toEqual({ outcome: "outcome_unknown", charged_tokens: 2_800 });
    await runMemoryExtraction(context);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("fails closed with no fallback and zero token charge when the same model is unavailable", async () => {
    const { database, context } = await fixture("planned");
    context.env.MEMORY_EXTRACTION_PROVIDER_MODELS_JSON = "[]";
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);

    const result = await runMemoryExtraction(context);
    expect(result.summary).toContain("no fallback");
    expect(database.prepare("SELECT outcome, charged_tokens FROM memory_extraction_runs WHERE id='run-a'").get())
      .toEqual({ outcome: "model_unavailable", charged_tokens: 0 });
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects provider-reported usage above either hard ceiling", async () => {
    const { database, context } = await fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({ candidates: [providerCandidate()] }),
      usage: { input_tokens: 2_001, output_tokens: 1 }
    }), { status: 200 })));

    await runMemoryExtraction(context);
    expect(database.prepare("SELECT outcome, charged_tokens, error_code FROM memory_extraction_runs WHERE id='run-a'").get())
      .toEqual({ outcome: "provider_failed", charged_tokens: 2_800, error_code: "provider_usage_ceiling_exceeded" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_learning_candidates").get()).toEqual({ count: 0 });
  });

  it("rejects a delayed worker after the run is tombstoned", async () => {
    const { database, context } = await fixture();
    database.prepare("UPDATE memory_extraction_runs SET tombstoned_at=? WHERE id='run-a'").run(Date.now());
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    await expect(runMemoryExtraction(context)).rejects.toThrow("memory extraction run tombstoned");
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects a delayed worker after its capture installation is revoked", async () => {
    const { database, context } = await fixture();
    database.prepare("UPDATE mcp_client_installations SET status='revoked' WHERE id='installation-a'").run();
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    const result = await runMemoryExtraction(context);
    expect(result.summary).toContain("installation inactive");
    expect(database.prepare("SELECT outcome, error_code FROM memory_extraction_runs WHERE id='run-a'").get())
      .toEqual({ outcome: "model_unavailable", error_code: "installation_inactive" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("grounds every populated field only in the candidate's declared support spans", async () => {
    const { bucket, context } = await fixture();
    const stored = await (await bucket.get("inputs/run-a.json"))!.json<Record<string, unknown> & {
      packet: { snippets: Array<{ span_id: string; role: string; text: string }> };
    }>();
    stored.packet.snippets.push({ span_id: "s2.1", role: "user", text: "理由は処理速度を優先するため。" });
    const verification = await __memoryExtractionInternals.verifiedCandidates(stored as never, [{
      lesson_type: "decision",
      support_span_ids: ["s1.1"],
      gaps: [],
      fields: [
        { name: "decision_type", values: ["implementation"] },
        { name: "decision", values: ["実装ではREST APIを採用する。理由は既存クライアントとの互換性。"] },
        { name: "rationale", values: ["理由は処理速度を優先するため。"] }
      ]
    }]);
    expect(verification.candidates).toEqual([]);
    expect(verification.rejections).toEqual([{
      candidate_index: 0,
      reason_codes: ["rationale_not_exactly_grounded"]
    }]);
    expect(context.tenantId).toBe("tenant-a");
  });

  it("allows update and conflict actions only for a memory retrieved from the same project", async () => {
    const { bucket } = await fixture();
    const stored = await (await bucket.get("inputs/run-a.json"))!.json<Record<string, unknown> & {
      packet: { existing_memories?: Array<{ id: string; kind: string; text: string }> };
    }>();
    stored.packet.existing_memories = [{ id: "memory-1", kind: "decision", text: "REST APIを利用する。" }];
    const proposal = providerCandidate();
    proposal.fields.push(
      { name: "persistence", values: ["durable"] },
      { name: "memory_kind", values: ["decision"] },
      { name: "action", values: ["update"] },
      { name: "target_memory_id", values: ["memory-1"] }
    );
    const { candidates: [candidate] } = await __memoryExtractionInternals.verifiedCandidates(stored as never, [proposal]);
    expect(candidate).toMatchObject({ action: "update", target_memory_id: "memory-1", memory_kind: "decision" });

    proposal.fields = proposal.fields.map((field) => field.name === "target_memory_id"
      ? { ...field, values: ["memory-from-another-project"] }
      : field);
    await expect(__memoryExtractionInternals.verifiedCandidates(stored as never, [proposal])).resolves.toEqual({
      candidates: [],
      accepted_indices: [],
      rejections: [{ candidate_index: 0, reason_codes: ["target_memory_id_unsearched"] }]
    });
  });

  it("never forwards restricted, invalid-lifecycle or sensitive existing memories", async () => {
    const { database, context, bucket } = await fixture();
    const input = await (await bucket.get("inputs/run-a.json"))!.json<{ packet: { snippets: Array<{ span_id: string; text: string }> } }>();
    input.packet.snippets = [{ span_id: "s1.1", text: "REST API" }];
    const now = Date.now();
    const insert = (id: string, options: { tenant?: string; project?: string; acl?: string; deleted?: number; from?: number; until?: number; expires?: number; state?: string; summary?: string; content?: string } = {}) => {
      database.prepare("INSERT INTO memories(id,tenant_id,project_id,content,summary,kind,lifecycle_state,expires_at,created_at,permissions_json,deleted_at,valid_from,valid_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, options.tenant ?? "tenant-a", options.project ?? "project-a", options.content ?? "REST API", options.summary ?? "REST API", "decision", options.state ?? "active", options.expires ?? null, now, options.acl ?? "[]", options.deleted ?? null, options.from ?? null, options.until ?? null);
      database.prepare("INSERT INTO memories_fts(memory_id,tenant_id,content) VALUES(?,?,?)").run(id, options.tenant ?? "tenant-a", "REST API");
    };
    // Every rejected class is tested separately so LIMIT 5 cannot hide a leak.
    const rejected = [
      { acl: '[{"principal_type":"principal","principal_id":"user:test","permissions":["read"]}]' },
      { acl: "invalid-json" }, { tenant: "other" }, { project: "other" },
      { deleted: now }, { from: now + 100_000 }, { until: now - 1 },
      { expires: now - 1 }, { state: "suppressed" },
      { content: "x".repeat(200) + " password=not-a-real-test-secret", summary: "safe summary" },
      { summary: "REST API test@example.com" },
      { content: "x".repeat(200) + ' password = "synthetic-test-secret"', summary: "safe summary" },
      { summary: 'REST API password = "synthetic-test-secret"' },
      { content: "x".repeat(200) + "\nBearer synthetic-test-token-1234567890", summary: "safe summary" },
      { summary: "REST API\nBearer synthetic-test-token-1234567890" }
    ];
    for (const [i, options] of rejected.entries()) {
      database.exec("DELETE FROM memories; DELETE FROM memories_fts;");
      insert("safe"); insert(`blocked-${i}`, options);
      const result = await __memoryExtractionInternals.loadExistingMemoryCandidates(context, input as never);
      expect(result.map(row => row.id)).toEqual(["safe"]);
    }
  });

  it("does not persist a provider skip as a review candidate", async () => {
    const { bucket } = await fixture();
    const stored = await (await bucket.get("inputs/run-a.json"))!.json<Record<string, unknown>>();
    const proposal = providerCandidate();
    proposal.fields.push({ name: "action", values: ["skip"] });
    await expect(__memoryExtractionInternals.verifiedCandidates(stored as never, [proposal])).resolves.toEqual({
      candidates: [],
      accepted_indices: [],
      rejections: [{ candidate_index: 0, reason_codes: ["provider_skip"] }]
    });
  });

  it("rejects unresolved supports and lesson-kind mismatches with reason codes only", async () => {
    const { bucket } = await fixture();
    const stored = await (await bucket.get("inputs/run-a.json"))!.json<Record<string, unknown>>();
    const unresolved = providerCandidate();
    unresolved.support_span_ids = ["s1.1.fake"];
    const mismatch = providerCandidate();
    mismatch.fields.push({ name: "memory_kind", values: ["pitfall"] });
    await expect(__memoryExtractionInternals.verifiedCandidates(stored as never, [unresolved, mismatch])).resolves.toEqual({
      candidates: [],
      accepted_indices: [],
      rejections: [
        { candidate_index: 0, reason_codes: ["support_id_unresolved"] },
        { candidate_index: 1, reason_codes: ["lesson_memory_kind_mismatch"] }
      ]
    });
  });
});
