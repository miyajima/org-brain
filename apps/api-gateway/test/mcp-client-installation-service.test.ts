import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateMcpClientInstallation,
  createMcpClientInstallation,
  listMcpClientInstallations,
  resolveMcpClientInstallation,
  revokeMcpClientInstallation,
  touchMcpClientInstallation
} from "../src/mcp-client-installation-service";
import type { Env } from "../src/types";

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  run: (...args: unknown[]) => { changes?: number | bigint };
};
type SqliteDatabase = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStatement };
const runtime = (globalThis as unknown as {
  process: { cwd: () => string; getBuiltinModule: (name: string) => unknown };
}).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};
const { readFileSync } = runtime.getBuiltinModule("node:fs") as {
  readFileSync: (path: string | URL, encoding: string) => string;
};

class D1StatementAdapter {
  private args: unknown[] = [];
  constructor(private readonly database: SqliteDatabase, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.args) as T[] }; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function testEnv(): Env {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(
    new URL("../../../migrations/0029_mcp_client_installations.sql", import.meta.url),
    "utf8"
  ));
  database.exec(`
    CREATE TABLE user_profiles (
      tenant_id TEXT NOT NULL,
      principal TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (tenant_id, principal)
    );
    INSERT INTO user_profiles(tenant_id, principal, status) VALUES
      ('default', 'user:alice', 'active'),
      ('default', 'user:bob', 'active');
  `);
  return {
    OPEN_BRAIN_DB: {
      prepare: (sql: string) => new D1StatementAdapter(database, sql)
    }
  } as unknown as Env;
}

describe("MCP client installations", () => {
  afterEach(() => vi.useRealTimers());

  it("enrolls once, resolves by hashed Access subject, throttles usage, and revokes independently", async () => {
    const env = testEnv();
    const created = await createMcpClientInstallation(env, "default", "user:alice", {
      client_type: "codex",
      device_label: "Work Mac"
    });
    expect(created.enrollment_code).toMatch(/^obi_/u);
    expect(created.enrollment_expires_at).toBeGreaterThan(Date.now());
    expect(JSON.stringify(created.installation)).not.toContain("token_hash");

    const pending = await listMcpClientInstallations(env, "default", "user:alice");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "pending", client_type: "codex" });
    expect(JSON.stringify(pending)).not.toContain("access_subject_hash");

    const active = await activateMcpClientInstallation(
      env,
      created.enrollment_code,
      "cloudflare-service-client-id",
      "codex"
    );
    expect(active).toMatchObject({
      id: created.installation.id,
      owner_principal: "user:alice",
      status: "active"
    });
    await expect(activateMcpClientInstallation(
      env,
      created.enrollment_code,
      "cloudflare-service-client-id",
      "codex"
    )).rejects.toMatchObject({ status: 401 });
    await expect(resolveMcpClientInstallation(env, "cloudflare-service-client-id"))
      .resolves.toMatchObject({ id: active.id });

    const otherCreated = await createMcpClientInstallation(env, "default", "user:bob", {
      client_type: "cursor",
      device_label: "Travel laptop"
    });
    const otherActive = await activateMcpClientInstallation(
      env,
      otherCreated.enrollment_code,
      "cloudflare-service-client-id-2",
      "cursor"
    );

    const firstUsedAt = active.last_used_at ?? 0;
    await touchMcpClientInstallation(env, active.id, firstUsedAt + 1_000);
    const notRetouched = (await listMcpClientInstallations(env, "default", "user:alice"))[0];
    expect(notRetouched.last_used_at).toBe(firstUsedAt);
    await touchMcpClientInstallation(env, active.id, firstUsedAt + 16 * 60 * 1000);
    const retouched = (await listMcpClientInstallations(env, "default", "user:alice"))[0];
    expect(retouched.last_used_at).toBe(firstUsedAt + 16 * 60 * 1000);

    await expect(revokeMcpClientInstallation(
      env,
      "default",
      active.id,
      "user:bob",
      false
    )).rejects.toMatchObject({ status: 403 });
    await expect(revokeMcpClientInstallation(
      env,
      "default",
      active.id,
      "user:alice",
      false
    )).resolves.toMatchObject({ status: "revoked" });
    await expect(resolveMcpClientInstallation(env, "cloudflare-service-client-id")).resolves.toBeNull();
    await expect(resolveMcpClientInstallation(env, "cloudflare-service-client-id-2"))
      .resolves.toMatchObject({ id: otherActive.id, status: "active", client_type: "cursor" });
  });

  it("rejects expired enrollment and service-subject rebinding", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    const env = testEnv();
    const expired = await createMcpClientInstallation(env, "default", "user:alice", {
      client_type: "claude",
      device_label: "Laptop"
    });
    vi.advanceTimersByTime(10 * 60 * 1000);
    await expect(activateMcpClientInstallation(
      env,
      expired.enrollment_code,
      "expired-subject",
      "claude"
    )).rejects.toMatchObject({ status: 401 });

    const first = await createMcpClientInstallation(env, "default", "user:alice", {
      client_type: "codex",
      device_label: "Desktop"
    });
    await activateMcpClientInstallation(env, first.enrollment_code, "shared-subject", "codex");
    await revokeMcpClientInstallation(env, "default", first.installation.id, "user:alice", false);
    const second = await createMcpClientInstallation(env, "default", "user:bob", {
      client_type: "cursor",
      device_label: "Second machine"
    });
    await expect(activateMcpClientInstallation(
      env,
      second.enrollment_code,
      "shared-subject",
      "cursor"
    )).rejects.toMatchObject({ status: 409 });
  });

  it("does not consume an enrollment code for another client type", async () => {
    const env = testEnv();
    const created = await createMcpClientInstallation(env, "default", "user:alice", {
      client_type: "cursor",
      device_label: "Design laptop"
    });
    await expect(activateMcpClientInstallation(
      env,
      created.enrollment_code,
      "wrong-client-subject",
      "codex"
    )).rejects.toMatchObject({ status: 401 });
    await expect(activateMcpClientInstallation(
      env,
      created.enrollment_code,
      "cursor-client-subject",
      "cursor"
    )).resolves.toMatchObject({ client_type: "cursor", status: "active" });
  });

  it.each([
    "/Users/alice/private-machine",
    "C02Z12ABC123",
    "c02z12abc123",
    "550e8400-e29b-41d4-a716-446655440000",
    "00:1A:2B:3C:4D:5E",
    "serial: C02Z12ABC123",
    "Work Mac\u0000hidden"
  ])("rejects path-like or hardware-derived device label %s", async (deviceLabel) => {
    await expect(createMcpClientInstallation(testEnv(), "default", "user:alice", {
      client_type: "cursor",
      device_label: deviceLabel
    })).rejects.toMatchObject({ status: 400 });
  });
});
