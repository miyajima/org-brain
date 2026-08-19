import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@org-brain/shared";
import { runSkillGeneration } from "../src/capabilities/skill-generation";
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
  readonly objects = new Map<string, string>();
  failGeneratedWrites = false;

  async get(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      json: async <T>() => JSON.parse(value) as T,
      text: async () => value
    };
  }

  async put(key: string, value: string) {
    if (this.failGeneratedWrites && key.includes("/skills/")) throw new Error("r2 write failed");
    this.objects.set(key, value);
    return {};
  }
}

async function fixture(options: { currentVersionId?: string | null } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE decision_memories(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT);
    CREATE TABLE decision_memory_versions(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, decision_memory_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE group_members(tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, principal TEXT NOT NULL);
    CREATE TABLE resource_access_policies(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL, scope TEXT NOT NULL, owner_principal TEXT NOT NULL,
      project_id TEXT, group_ids_json TEXT NOT NULL, restricted_subjects_json TEXT NOT NULL
    );
    CREATE TABLE skill_assets(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
      status TEXT NOT NULL, current_version_id TEXT, owner_principal TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE skill_generation_runs(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, skill_asset_id TEXT NOT NULL,
      status TEXT NOT NULL, output_version_id TEXT, error_code TEXT, error_message TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE skill_asset_versions(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, skill_asset_id TEXT NOT NULL,
      version INTEGER NOT NULL, schema_version INTEGER NOT NULL, manifest_json TEXT NOT NULL,
      content_hash TEXT NOT NULL, validation_json TEXT NOT NULL, generation_provider TEXT,
      generation_model TEXT, generation_prompt_version TEXT, source_digest TEXT,
      created_by_principal TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE skill_asset_files(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, skill_asset_id TEXT NOT NULL,
      skill_asset_version_id TEXT NOT NULL, path TEXT NOT NULL, media_type TEXT NOT NULL,
      content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL, r2_key TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  const snapshot = JSON.stringify({
    title: "Canonical rollout",
    decision: "Use the verified release sequence",
    rationale: "It preserves rollback boundaries",
    source_refs: [{ type: "test", ref: "fixture" }]
  });
  const sourceHash = await sha256(snapshot);
  const sources = [{ source_type: "decision_memory", source_id: "decision-a", version_hash: sourceHash }];
  const instructions = "Create an operational checklist with observable completion conditions.";
  const input = {
    schema_version: 1,
    generation_run_id: "run-a",
    tenant_id: "tenant-a",
    project_id: "project-a",
    skill_asset_id: "skill-a",
    requested_by_principal: "user:runner",
    provider: "openai",
    model: "gpt-test",
    prompt_version: "decision-skill-v1",
    sources,
    source_digest: await sha256(JSON.stringify(sources)),
    instructions,
    instruction_digest: await sha256(instructions)
  };
  const now = Date.now();
  database.prepare("INSERT INTO decision_memories VALUES(?,?,?)").run("decision-a", "tenant-a", "project-a");
  database.prepare("INSERT INTO decision_memory_versions VALUES(?,?,?,?,?)").run("decision-version-a", "tenant-a", "decision-a", snapshot, now);
  database.prepare("INSERT INTO resource_access_policies VALUES(?,?,?,?,?,?,?,?,?)").run(
    "policy-a", "tenant-a", "decision_memory", "decision-a", "tenant", "user:runner", "project-a", "[]", "[]"
  );
  database.prepare("INSERT INTO skill_assets VALUES(?,?,?,?,?,?,?,?)").run(
    "skill-a", "tenant-a", "Draft", "Pending generation", "draft",
    options.currentVersionId ?? null, "user:runner", now
  );
  database.prepare("INSERT INTO skill_generation_runs VALUES(?,?,?,?,?,?,?,?)").run(
    "run-a", "tenant-a", "skill-a", "pending", null, null, null, now
  );
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
    SKILL_GENERATION_PROVIDERS_JSON: '["openai"]'
  } as unknown as Env;
  const context = {
    env,
    tenantId: "tenant-a",
    projectId: "project-a",
    taskId: "task-a",
    capability: "skill_generation",
    inputRef: "r2://inputs/run-a.json",
    constraints: {}
  } as CapabilityContext;
  return { database, bucket, context };
}

const manifest = {
  name: "Verified rollout",
  description: "Apply the selected release decision",
  instructions: "Follow the release sequence and stop when a validation condition fails.",
  validation_conditions: ["All checks report success"],
  files: [{ path: "references/checklist.md", media_type: "text/markdown", content: "# Checklist" }]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Skill generation capability", () => {
  it("stores one private immutable version and deduplicates a completed retry", async () => {
    const { database, bucket, context } = await fixture();
    const provider = vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(manifest),
      usage: { input_tokens: 120, output_tokens: 80 }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", provider);

    const result = await runSkillGeneration(context);
    expect(result.summary).toContain("private Skill draft");
    expect(database.prepare("SELECT status FROM skill_generation_runs WHERE id = 'run-a'").get()).toEqual({ status: "succeeded" });
    expect(database.prepare("SELECT status, current_version_id FROM skill_assets WHERE id = 'skill-a'").get())
      .toMatchObject({ status: "draft", current_version_id: expect.any(String) });
    expect(database.prepare("SELECT COUNT(*) AS count FROM skill_asset_versions").get()).toEqual({ count: 1 });
    expect([...bucket.objects.keys()].some((key) => key.endsWith("/SKILL.md"))).toBe(true);

    const duplicate = await runSkillGeneration(context);
    expect(duplicate.summary).toContain("already completed");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("fails invalid provider schema without creating a partial version", async () => {
    const { database, context } = await fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({ name: "Incomplete" })
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(runSkillGeneration(context)).rejects.toThrow("invalid Skill schema");
    expect(database.prepare("SELECT status, error_code FROM skill_generation_runs WHERE id = 'run-a'").get())
      .toEqual({ status: "failed", error_code: "generation_failed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM skill_asset_versions").get()).toEqual({ count: 0 });
  });

  it("marks retryable provider timeouts and R2 failures without publishing partial data", async () => {
    const timeout = await fixture();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    await expect(runSkillGeneration(timeout.context)).rejects.toThrow("retryable: provider request failed");
    expect(timeout.database.prepare("SELECT status, error_code FROM skill_generation_runs WHERE id = 'run-a'").get())
      .toEqual({ status: "failed", error_code: "provider_retryable" });

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(manifest)
    }), { status: 200 })));
    await expect(runSkillGeneration(timeout.context)).resolves.toMatchObject({
      summary: expect.stringContaining("private Skill draft")
    });
    expect(timeout.database.prepare("SELECT status FROM skill_generation_runs WHERE id = 'run-a'").get())
      .toEqual({ status: "succeeded" });
    expect(timeout.database.prepare("SELECT COUNT(*) AS count FROM skill_asset_versions").get())
      .toEqual({ count: 1 });

    vi.unstubAllGlobals();
    const r2 = await fixture();
    r2.bucket.failGeneratedWrites = true;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify(manifest) }), { status: 200 })));
    await expect(runSkillGeneration(r2.context)).rejects.toThrow("r2 write failed");
    expect(r2.database.prepare("SELECT status FROM skill_generation_runs WHERE id = 'run-a'").get()).toEqual({ status: "failed" });
    expect(r2.database.prepare("SELECT COUNT(*) AS count FROM skill_asset_versions").get()).toEqual({ count: 0 });
    expect(r2.database.prepare("SELECT current_version_id FROM skill_assets WHERE id = 'skill-a'").get()).toEqual({ current_version_id: null });
  });

  it("leaves no database version when a concurrent draft revision wins", async () => {
    const { database, context } = await fixture({ currentVersionId: "manual-version" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify(manifest) }), { status: 200 })));

    await expect(runSkillGeneration(context)).rejects.toThrow("generation publish conflict");
    expect(database.prepare("SELECT COUNT(*) AS count FROM skill_asset_versions").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT current_version_id FROM skill_assets WHERE id = 'skill-a'").get())
      .toEqual({ current_version_id: "manual-version" });
    expect(database.prepare("SELECT status FROM skill_generation_runs WHERE id = 'run-a'").get()).toEqual({ status: "failed" });
  });
});
