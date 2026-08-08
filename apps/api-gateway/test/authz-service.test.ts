import { describe, expect, it } from "vitest";
import { buildAuthzContext, loadReadableResourceIds } from "../src/authz-service";
import type { Env } from "../src/types";

type SqliteStatement = {
  all: (...args: unknown[]) => Record<string, unknown>[];
  run: (...args: unknown[]) => unknown;
};

type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

const runtime = (globalThis as unknown as {
  process: { getBuiltinModule: (name: string) => unknown };
}).process;

const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

class D1StatementAdapter {
  private args: unknown[] = [];

  constructor(
    private readonly database: SqliteDatabase,
    private readonly sql: string
  ) {}

  bind(...args: unknown[]) {
    expect(args.length).toBeLessThanOrEqual(100);
    this.args = args;
    return this;
  }

  async all<T>() {
    return {
      results: this.database.prepare(this.sql).all(...this.args) as T[],
      success: true
    };
  }
}

describe("dashboard resource ACL lookup", () => {
  it("keeps dense resource and group sets below the D1 bind limit", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE group_members(tenant_id TEXT, group_id TEXT, principal TEXT);
        CREATE TABLE resource_acl(
          tenant_id TEXT,
          resource_type TEXT,
          resource_id TEXT,
          subject_type TEXT,
          subject_id TEXT,
          permission TEXT
        );
      `);
      const insertGroup = database.prepare(
        "INSERT INTO group_members(tenant_id, group_id, principal) VALUES(?,?,?)"
      );
      for (let index = 0; index < 120; index += 1) {
        insertGroup.run("tenant-a", `group-${index}`, "user:alice");
      }
      const insertAcl = database.prepare(
        `INSERT INTO resource_acl(
           tenant_id, resource_type, resource_id, subject_type, subject_id, permission
         ) VALUES(?,?,?,?,?,?)`
      );
      insertAcl.run("tenant-a", "decision_memory", "decision-149", "group", "group-119", "read");
      insertAcl.run("tenant-a", "decision_memory", "decision-201", "principal", "user:alice", "read");
      insertAcl.run("tenant-a", "decision_memory", "decision-249", "tenant", "tenant-a", "read");
      insertAcl.run("tenant-b", "decision_memory", "decision-149", "group", "group-119", "read");

      const d1 = {
        prepare(sql: string) {
          return new D1StatementAdapter(database, sql);
        }
      } as unknown as D1Database;
      const env = { OPEN_BRAIN_DB: d1 } as Env;
      const authz = await buildAuthzContext(env, "tenant-a", "user:alice");
      const readable = await loadReadableResourceIds(env, {
        tenantId: "tenant-a",
        resourceType: "decision_memory",
        resourceIds: Array.from({ length: 250 }, (_, index) => `decision-${index}`),
        authz
      });

      expect(readable).toEqual(new Set(["decision-149", "decision-201", "decision-249"]));
    } finally {
      database.close();
    }
  });
});
