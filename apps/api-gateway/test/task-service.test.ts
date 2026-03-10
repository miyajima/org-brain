import { describe, expect, it } from "vitest";
import { createTask } from "../src/task-service";

class FakeStatement {
  sql: string;
  db: FakeD1;
  args: unknown[] = [];

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    if (this.sql.startsWith("SELECT id, status FROM tasks")) {
      const tenantId = this.args[0] as string;
      const idem = this.args[1] as string;
      const found = this.db.tasks.find((x) => x.tenant_id === tenantId && x.idempotency_key === idem);
      return (found ? { id: found.id, status: found.status } : null) as T | null;
    }

    return null;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO tasks")) {
      this.db.tasks.push({
        id: this.args[0] as string,
        tenant_id: this.args[1] as string,
        status: this.args[4] as string,
        idempotency_key: this.args[7] as string
      });
    }

    if (this.sql.startsWith("INSERT INTO task_events")) {
      this.db.events.push({ id: this.args[0] as string, task_id: this.args[2] as string });
    }

    return { success: true };
  }

  async all<T>() {
    return { results: [] as T[] };
  }
}

class FakeD1 {
  tasks: Array<{ id: string; tenant_id: string; status: string; idempotency_key: string }> = [];
  events: Array<{ id: string; task_id: string }> = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    for (const stmt of statements) {
      await stmt.run();
    }
    return [];
  }
}

describe("createTask", () => {
  it("dedupes with idempotency key and sends queue only once", async () => {
    const db = new FakeD1();
    const sent: unknown[] = [];

    const env = {
      OPEN_BRAIN_DB: db,
      OPEN_BRAIN_BUCKET: {},
      API_KEY: "x",
      WF_SPEC2CODE: {},
      ORG_BUS_OUT: {
        send: async (payload: unknown) => {
          sent.push(payload);
        }
      }
    } as any;

    const body = {
      tenant_id: "default",
      capability: "plan_writer",
      input_ref: "spec://abc"
    };

    const first = await createTask(env, body);
    const second = await createTask(env, body);

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.task_id).toBe(first.task_id);
    expect(db.tasks).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});
