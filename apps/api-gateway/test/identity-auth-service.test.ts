import { describe, expect, it } from "vitest";
import { InMemoryEmailSender, requestEmailCode, verifyEmailCode, authenticateSession } from "../src/email-auth-service";
import { listDirectory, listUsers, updateOrganization } from "../src/organization-user-service";
import { createGroup, listGroups, updateGroup } from "../src/group-service";
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
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
const { readFileSync } = runtime.getBuiltinModule("node:fs") as { readFileSync: (path: string, encoding: string) => string };

class D1StatementAdapter {
  private args: unknown[] = [];
  constructor(private readonly database: SqliteDatabase, private readonly sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.args) as T[], success: true }; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function testEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE user_profiles(
      tenant_id TEXT NOT NULL, principal TEXT NOT NULL, display_name TEXT, email TEXT,
      company_name TEXT, organization_name TEXT, avatar_url TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(tenant_id, principal)
    );
    CREATE TABLE groups(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, created_by_principal TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE group_members(
      tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, principal TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, group_id, principal)
    );
    CREATE TABLE principal_role_assignments(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, principal TEXT NOT NULL,
      role TEXT NOT NULL, created_by_principal TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_principal_role_identity ON principal_role_assignments(
      tenant_id, COALESCE(project_id, ''), principal, role
    );
  `);
  database.exec(readFileSync(`${runtime.cwd()}/../../migrations/0024_identity_organization.sql`, "utf8"));
  const db = {
    prepare: (sql: string) => new D1StatementAdapter(database, sql),
    batch: async (statements: D1StatementAdapter[]) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
  return {
    database,
    env: {
      OPEN_BRAIN_DB: db,
      EMAIL_AUTH_ENABLED: "true",
      EMAIL_AUTH_PEPPER: "test-pepper",
      EMAIL_WEBHOOK_URL: "https://mailer.example.test/send",
      EMAIL_WEBHOOK_SECRET: "test-secret"
    } as unknown as Env
  };
}

describe("email identity service", () => {
  it("self-registers with an opaque principal and never exposes full_name in directory", async () => {
    const { env } = testEnv();
    await updateOrganization(env, "tenant-a", {
      slug: "tenant-a",
      display_name: "Tenant A",
      allowed_email_domains: ["example.com"],
      email_self_registration_enabled: true
    });
    const sender = new InMemoryEmailSender();
    await expect(requestEmailCode(env, {
      organization_slug: "tenant-a",
      email: "person@example.com"
    }, "203.0.113.1", sender)).resolves.toEqual({ accepted: true });
    const deliveredCode = sender.deliveries[0]?.code ?? "";
    expect(deliveredCode).toMatch(/^\d{6}$/u);

    const verified = await verifyEmailCode(env, {
      organization_slug: "tenant-a",
      email: "person@example.com",
      code: deliveredCode
    });
    expect(verified.user.principal).toMatch(/^user:[0-9a-z]+$/u);
    expect(verified.user.email_verified).toBe(true);
    await expect(verifyEmailCode(env, {
      organization_slug: "tenant-a",
      email: "person@example.com",
      code: deliveredCode
    })).rejects.toMatchObject({ status: 401 });
    expect((await authenticateSession(env, verified.session_token))?.allowedTenants).toEqual(["tenant-a"]);

    await env.OPEN_BRAIN_DB.prepare(
      "UPDATE user_profiles SET full_name='Private Person' WHERE tenant_id='tenant-a'"
    ).run();
    expect(await listDirectory(env, "tenant-a")).not.toContainEqual(expect.objectContaining({ full_name: expect.anything() }));
    expect((await listUsers(env, "tenant-a"))[0]?.full_name).toBe("Private Person");
    expect(await listDirectory(env, "tenant-b")).toEqual([]);
  });

  it("returns the same accepted response for unknown organizations", async () => {
    const { env } = testEnv();
    const sender = new InMemoryEmailSender();
    await expect(requestEmailCode(env, {
      organization_slug: "missing",
      email: "unknown@example.com"
    }, null, sender)).resolves.toEqual({ accepted: true });
    expect(sender.deliveries).toEqual([]);
  });

  it("expires challenges, enforces resend limits, and consumes the fifth failed attempt", async () => {
    const { env, database } = testEnv();
    await updateOrganization(env, "tenant-a", {
      slug: "tenant-a", display_name: "Tenant A", allowed_email_domains: ["example.com"],
      email_self_registration_enabled: true
    });
    const sender = new InMemoryEmailSender();
    await requestEmailCode(env, { organization_slug: "tenant-a", email: "limited@example.com" }, "203.0.113.5", sender);
    await requestEmailCode(env, { organization_slug: "tenant-a", email: "limited@example.com" }, "203.0.113.5", sender);
    expect(sender.deliveries).toHaveLength(1);
    const code = sender.deliveries[0]!.code;
    database.prepare("UPDATE email_auth_challenges SET attempt_count=4 WHERE email='limited@example.com'").run();
    await expect(verifyEmailCode(env, { organization_slug: "tenant-a", email: "limited@example.com", code: "000000" }))
      .rejects.toMatchObject({ status: 401 });
    await expect(verifyEmailCode(env, { organization_slug: "tenant-a", email: "limited@example.com", code }))
      .rejects.toMatchObject({ status: 401 });
    expect(database.prepare("SELECT consumed_at FROM email_auth_challenges WHERE email='limited@example.com'").get()?.consumed_at).not.toBeNull();
  });

  it("rejects an expired code and enforces the five-per-hour email/IP request limit", async () => {
    const { env, database } = testEnv();
    await updateOrganization(env, "tenant-a", {
      slug: "tenant-a", display_name: "Tenant A", allowed_email_domains: ["example.com"],
      email_self_registration_enabled: true
    });
    const sender = new InMemoryEmailSender();
    await requestEmailCode(env, { organization_slug: "tenant-a", email: "expired@example.com" }, "203.0.113.8", sender);
    const expiredCode = sender.deliveries[0]!.code;
    database.prepare("UPDATE email_auth_challenges SET expires_at=0 WHERE email='expired@example.com'").run();
    await expect(verifyEmailCode(env, {
      organization_slug: "tenant-a", email: "expired@example.com", code: expiredCode
    })).rejects.toMatchObject({ status: 401 });

    const limitedSender = new InMemoryEmailSender();
    for (let index = 0; index < 6; index += 1) {
      await requestEmailCode(env, {
        organization_slug: "tenant-a", email: "hourly@example.com"
      }, "203.0.113.9", limitedSender);
      database.prepare("UPDATE email_auth_challenges SET created_at=created_at-61000 WHERE email='hourly@example.com'").run();
    }
    expect(limitedSender.deliveries).toHaveLength(5);
  });

  it("keeps the existence-hiding accepted response and invalidates a challenge when delivery fails", async () => {
    const { env, database } = testEnv();
    await updateOrganization(env, "tenant-a", {
      slug: "tenant-a", display_name: "Tenant A", allowed_email_domains: ["example.com"],
      email_self_registration_enabled: true
    });
    await expect(requestEmailCode(env, { organization_slug: "tenant-a", email: "failure@example.com" }, null, {
      async send() { throw new Error("delivery failed"); }
    })).resolves.toEqual({ accepted: true });
    expect(database.prepare("SELECT consumed_at FROM email_auth_challenges WHERE email='failure@example.com'").get()?.consumed_at).not.toBeNull();
  });

  it("lets a tenant administrator list and manage local groups without group membership", async () => {
    const { env } = testEnv();
    const first = await createGroup(env, "tenant-a", "user:owner", { name: "First" });
    const second = await createGroup(env, "tenant-a", "user:other", { name: "Second" });
    expect((await listGroups(env, "tenant-a", "user:tenant-admin", true)).groups).toHaveLength(2);
    await expect(updateGroup(env, "tenant-a", second.group.id, "user:tenant-admin", {
      name: "Second updated"
    }, true)).resolves.toMatchObject({ group: { name: "Second updated" } });
    expect(first.group.role).toBe("owner");
  });
});
