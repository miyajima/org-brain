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
  `);
  database.exec(readFileSync(new URL("../../../migrations/0038_memory_extraction_pipeline.sql", import.meta.url), "utf8"));
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

function providerCandidate() {
  return {
    lesson_type: "decision",
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
    const [candidate] = await __memoryExtractionInternals.verifiedCandidates(stored as never, [{
      lesson_type: "decision",
      support_span_ids: ["s1.1"],
      gaps: [],
      fields: [
        { name: "decision_type", values: ["implementation"] },
        { name: "decision", values: ["実装ではREST APIを採用する。理由は既存クライアントとの互換性。"] },
        { name: "rationale", values: ["理由は処理速度を優先するため。"] }
      ]
    }]);
    expect(candidate.observation.rationale).toBeNull();
    expect(candidate.gaps).toContain("rationale_unsupported");
    expect(candidate.support_span_ids).toEqual(["s1.1"]);
    expect(context.tenantId).toBe("tenant-a");
  });
});
