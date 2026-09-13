import { describe, expect, it } from "vitest";

type SqliteStatement = { get: (...args: unknown[]) => Record<string, unknown> | undefined; run: (...args: unknown[]) => unknown };
type SqliteDatabase = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStatement };
const runtime = (globalThis as unknown as { process: { cwd: () => string; getBuiltinModule: (name: string) => unknown } }).process;
const { DatabaseSync } = runtime.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };
const { readFileSync } = runtime.getBuiltinModule("node:fs") as { readFileSync: (path: string, encoding: string) => string };
const migration = (name: string) => readFileSync(`${runtime.cwd()}/../../migrations/${name}`, "utf8");
const loopSchema = migration("0039_knowledge_measurement_loop.sql").split("-- Forward-only compatibility")[0]!;

function oldDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(loopSchema);
  database.exec(`
    CREATE TABLE decision_memories (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', updated_at INTEGER NOT NULL
    );
    CREATE TABLE decision_rationales (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, memory_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
    );
    CREATE TABLE resource_access_policies (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
      policy_version INTEGER NOT NULL DEFAULT 1
    );
  `);
  return database;
}

describe("0042 Knowledge Loop pilot migration", () => {
  it("applies to an empty 0039 database", () => {
    const database = oldDatabase();
    database.exec(migration("0042_knowledge_loop_pilot.sql"));
    expect(database.prepare("SELECT COUNT(*) AS count FROM retrospective_item_eligible_participants").get()?.count).toBe(0);
    expect(database.prepare("SELECT participant_group_id, participant_count_at_close, unanswered_response_count_at_close FROM retrospective_sessions LIMIT 1").get()).toBeUndefined();
  });

  it("backfills old eligibility and reconstructs closed-session counts without integrity gaps", () => {
    const database = oldDatabase();
    database.prepare("INSERT INTO retrospective_sessions(id, tenant_id, status, title, created_by, opened_at, closed_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("session-1", "tenant-a", "closed", "Legacy review", "user:admin", 1, 2, 1, 2);
    for (const principal of ["user:admin", "user:alice"]) {
      database.prepare("INSERT INTO retrospective_participants(session_id, tenant_id, principal, created_at) VALUES(?,?,?,?)")
        .run("session-1", "tenant-a", principal, 1);
    }
    for (const [index, itemId] of ["item-1", "item-2"].entries()) {
      database.prepare("INSERT INTO retrospective_items(id, tenant_id, session_id, ordinal, source_type, source_id, source_version, source_digest, title, statement, rationale, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(itemId, "tenant-a", "session-1", index, "decision_memory", `decision-${index}`, "1", "a".repeat(64), "Decision", "Statement", "Reason", 1);
    }
    database.prepare("INSERT INTO retrospective_responses(id, tenant_id, session_id, item_id, principal, decision, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run("response-1", "tenant-a", "session-1", "item-1", "user:admin", "adopt", 1, 1);

    database.exec(migration("0042_knowledge_loop_pilot.sql"));
    expect(database.prepare("SELECT COUNT(*) AS count FROM retrospective_item_eligible_participants").get()?.count).toBe(4);
    expect(database.prepare("SELECT participant_count_at_close AS participants, unanswered_response_count_at_close AS unanswered FROM retrospective_sessions WHERE id='session-1'").get())
      .toEqual({ participants: 2, unanswered: 3 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM retrospective_item_eligible_participants eligible
      LEFT JOIN retrospective_sessions session ON session.id=eligible.session_id AND session.tenant_id=eligible.tenant_id
      LEFT JOIN retrospective_items item ON item.id=eligible.item_id AND item.session_id=eligible.session_id AND item.tenant_id=eligible.tenant_id
      WHERE session.id IS NULL OR item.id IS NULL`).get()?.count).toBe(0);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM retrospective_responses response
      LEFT JOIN retrospective_item_eligible_participants eligible ON eligible.tenant_id=response.tenant_id
       AND eligible.session_id=response.session_id AND eligible.item_id=response.item_id AND eligible.principal=response.principal
      WHERE eligible.item_id IS NULL`).get()?.count).toBe(0);
  });
});
