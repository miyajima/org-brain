import { describe, expect, it } from "vitest";
import { buildSignedVerifiedKnowledgeBundle, type LocalSessionV1 } from "@org-brain/shared";
import { ingestVerifiedKnowledgeBundle, registerCollectorKey } from "../src/verified-ingestion-service";
import type { Env } from "../src/types";

const runtime = (globalThis as unknown as { process: { getBuiltinModule: (name: string) => unknown } }).process;
  const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec: (sql: string) => void; prepare: (sql: string) => { bind: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] } };
};
const { readFileSync, readdirSync } = runtime.getBuiltinModule("node:fs") as {
  readFileSync: (path: URL, encoding: "utf8") => string;
  readdirSync: (path: URL) => string[];
};

function envWithMigrations() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../../../migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(new URL(file, directory), "utf8"));
  }
  const db = {
    prepare: (sql: string) => {
      const statement = database.prepare(sql);
      return {
        bind(...args: unknown[]) {
          return {
            first: async <T>() => statement.get(...args) as T | null,
            all: async <T>() => ({ results: statement.all(...args) as T[] }),
            run: async () => ({ meta: { changes: Number((statement.run as unknown as (...values: unknown[]) => { changes?: number }).apply(statement, args).changes ?? 0) } })
          };
        },
        first: async <T>() => statement.get() as T | null,
        all: async <T>() => ({ results: statement.all() as T[] }),
        run: async () => ({ meta: { changes: Number((statement.run as unknown as () => { changes?: number }).call(statement).changes ?? 0) } })
      };
    },
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const output = [];
      for (const statement of statements) output.push(await statement.run());
      return output;
    }
  };
  return { database, env: { OPEN_BRAIN_DB: db, VERIFIED_INGESTION_MODE: "beta", VERIFIED_AUTO_PROMOTE: "off" } as unknown as Env };
}

const session: LocalSessionV1 = {
  tenant_id: "tenant-a",
  project_id: "project-a",
  task_id: "task-a",
  decision_thread_id: "thread-a",
  events: [{
    event_id: "event-1",
    turn_id: "turn-1",
    tenant_id: "tenant-a",
    project_id: "project-a",
    task_id: "task-a",
    decision_thread_id: "thread-a",
    role: "user",
    actor_type: "human",
    actor_id: "user:1",
    occurred_at: 1,
    text: "決定: src/app.ts を採用する。理由は変更範囲を小さくできるため。",
    file_change: { path: "src/app.ts", content_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }]
};

describe("verified ingestion service", () => {
  it("rejects duplicate manifests without creating another row", async () => {
    const { database, env } = envWithMigrations();
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await registerCollectorKey(env, "tenant-a", { key_id: "collector-1", public_key: publicKey }, "user:1");
    const bundle = await buildSignedVerifiedKnowledgeBundle(session, keys.privateKey, { collector_key_id: "collector-1" });
    const first = await ingestVerifiedKnowledgeBundle(env, "tenant-a", bundle, "user:1", { publishAuthorized: true });
    const second = await ingestVerifiedKnowledgeBundle(env, "tenant-a", bundle, "user:1", { publishAuthorized: true });
    expect(first.verification_state).toBe("active");
    expect(second.verification_state).toBe("duplicate");
    const count = database.prepare("SELECT COUNT(*) AS count FROM verified_ingestion_manifests").get() as { count: number };
    expect(Number(count.count)).toBe(1);
  });

  it("projects a complete bundle only when auto promotion is enabled", async () => {
    const { database, env } = envWithMigrations();
    (env as unknown as { VERIFIED_AUTO_PROMOTE: "on" }).VERIFIED_AUTO_PROMOTE = "on";
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await registerCollectorKey(env, "tenant-a", { key_id: "collector-2", public_key: publicKey }, "user:1");
    const bundle = await buildSignedVerifiedKnowledgeBundle(session, keys.privateKey, { collector_key_id: "collector-2" });
    const result = await ingestVerifiedKnowledgeBundle(env, "tenant-a", bundle, "user:1", { publishAuthorized: true });
    expect(result.verification_state).toBe("active");
    expect(result.projected_decision_id).toMatch(/^verified_decision_/u);
    const decision = database.prepare("SELECT decision, rationale FROM decision_memories WHERE tenant_id = ? AND id = ?").get("tenant-a", result.projected_decision_id) as { decision: string; rationale: string };
    expect(decision.decision).toContain("src/app.ts");
    expect(decision.rationale).toContain("変更範囲");
    const resources = database.prepare("SELECT COUNT(*) AS count FROM knowledge_resources WHERE tenant_id = ? AND source_system = 'verified_ingestion'").get("tenant-a") as { count: number };
    const evidence = database.prepare("SELECT COUNT(*) AS count FROM decision_evidence WHERE tenant_id = ? AND rationale_id LIKE 'verified_rationale_%'").get("tenant-a") as { count: number };
    expect(Number(resources.count)).toBeGreaterThan(0);
    expect(Number(evidence.count)).toBeGreaterThan(0);
  });

  it("quarantines a semantic change without an explicit supersedes edge", async () => {
    const { env } = envWithMigrations();
    (env as unknown as { VERIFIED_AUTO_PROMOTE: "on" }).VERIFIED_AUTO_PROMOTE = "on";
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await registerCollectorKey(env, "tenant-a", { key_id: "collector-3", public_key: publicKey }, "user:1");
    const firstBundle = await buildSignedVerifiedKnowledgeBundle({ ...session, events: [{ ...session.events[0], metadata: { decision_key: "same-key" } }] }, keys.privateKey, { collector_key_id: "collector-3" });
    await ingestVerifiedKnowledgeBundle(env, "tenant-a", firstBundle, "user:1", { publishAuthorized: true });
    const secondBundle = await buildSignedVerifiedKnowledgeBundle({ ...session, events: [{ ...session.events[0], event_id: "event-2", metadata: { decision_key: "same-key" }, text: "決定: src/other.ts を採用する。理由は別の都合による。", file_change: { path: "src/other.ts", content_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }] }, keys.privateKey, { collector_key_id: "collector-3" });
    const result = await ingestVerifiedKnowledgeBundle(env, "tenant-a", secondBundle, "user:1", { publishAuthorized: true });
    expect(result.verification_state).toBe("extractor_disagreement");
  });

  it("merges new provenance into an existing semantic projection", async () => {
    const { database, env } = envWithMigrations();
    (env as unknown as { VERIFIED_AUTO_PROMOTE: "on" }).VERIFIED_AUTO_PROMOTE = "on";
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await registerCollectorKey(env, "tenant-a", { key_id: "collector-4", public_key: publicKey }, "user:1");
    const firstBundle = await buildSignedVerifiedKnowledgeBundle({ ...session, events: [{ ...session.events[0], metadata: { decision_key: "merge-key" } }] }, keys.privateKey, { collector_key_id: "collector-4" });
    const first = await ingestVerifiedKnowledgeBundle(env, "tenant-a", firstBundle, "user:1", { publishAuthorized: true });
    const secondBundle = await buildSignedVerifiedKnowledgeBundle({ ...session, events: [{ ...session.events[0], event_id: "event-merge-2", metadata: { decision_key: "merge-key" }, command_result: "exit_code=0" }] }, keys.privateKey, { collector_key_id: "collector-4" });
    const second = await ingestVerifiedKnowledgeBundle(env, "tenant-a", secondBundle, "user:1", { publishAuthorized: true });
    expect(second.projected_decision_id).toBe(first.projected_decision_id);
    const row = database.prepare("SELECT source_refs_json FROM decision_memories WHERE tenant_id = ? AND id = ?").get("tenant-a", first.projected_decision_id) as { source_refs_json: string };
    expect(JSON.parse(row.source_refs_json)).toHaveLength(3);
  });

  it("masks sensitive excerpts before retaining a quarantined manifest", async () => {
    const { database, env } = envWithMigrations();
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await registerCollectorKey(env, "tenant-a", { key_id: "collector-5", public_key: publicKey }, "user:1");
    const unsafe = await buildSignedVerifiedKnowledgeBundle({ ...session, events: [{ ...session.events[0], text: "決定: src/private.ts を採用する。理由は user@example.invalid に送るため。" }] }, keys.privateKey, { collector_key_id: "collector-5" });
    const result = await ingestVerifiedKnowledgeBundle(env, "tenant-a", unsafe, "user:1", { publishAuthorized: true });
    expect(result.verification_state).toBe("quarantined");
    const row = database.prepare("SELECT manifest_json FROM verified_ingestion_manifests WHERE id = ?").get(result.manifest_id) as { manifest_json: string };
    expect(row.manifest_json).not.toContain("user@example.invalid");
    expect(row.manifest_json).toContain("[REDACTED_EMAIL]");
  });

  it("rejects cross-tenant and revoked collector submissions", async () => {
    const { env } = envWithMigrations();
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await registerCollectorKey(env, "tenant-a", { key_id: "collector-6", public_key: publicKey }, "user:1");
    const bundle = await buildSignedVerifiedKnowledgeBundle(session, keys.privateKey, { collector_key_id: "collector-6" });
    await expect(ingestVerifiedKnowledgeBundle(env, "tenant-b", bundle, "user:1", { publishAuthorized: true })).rejects.toMatchObject({ code: "cross_tenant_bundle" });
    const now = Date.now();
    await env.OPEN_BRAIN_DB.prepare("UPDATE local_collector_keys SET state = 'revoked', revoked_at = ? WHERE tenant_id = ? AND id = ?").bind(now, "tenant-a", "collector-6").run();
    await expect(ingestVerifiedKnowledgeBundle(env, "tenant-a", bundle, "user:1", { publishAuthorized: true })).rejects.toMatchObject({ code: "collector_key_revoked" });
  });
});
