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

    if (this.sql.startsWith("SELECT id FROM measurement_runs")) {
      const tenantId = this.args[0] as string;
      const pairKey = this.args[1] as string;
      const found = this.db.measurementRuns.find((x) => x.tenant_id === tenantId && x.pair_key === pairKey);
      return (found ? { id: found.id } : null) as T | null;
    }

    return null;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO measurement_runs")) {
      this.db.measurementRuns.push({
        id: this.args[0] as string,
        tenant_id: this.args[1] as string,
        pair_key: this.args[6] as string
      });
    }

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

    if (this.sql.startsWith("INSERT INTO measurement_variants")) {
      this.db.measurementVariants.push({
        run_id: this.args[0] as string,
        tenant_id: this.args[1] as string,
        variant: this.args[2] as "control" | "treatment",
        task_id: this.args[3] as string,
        status: this.args[4] as string
      });
    }

    return { success: true };
  }

  async all<T>() {
    if (this.sql.startsWith("SELECT variant, task_id, status FROM measurement_variants")) {
      const tenantId = this.args[0] as string;
      const runId = this.args[1] as string;
      return {
        results: this.db.measurementVariants.filter((row) => row.tenant_id === tenantId && row.run_id === runId) as T[]
      };
    }

    return { results: [] as T[] };
  }
}

class FakeD1 {
  tasks: Array<{ id: string; tenant_id: string; status: string; idempotency_key: string }> = [];
  events: Array<{ id: string; task_id: string }> = [];
  measurementRuns: Array<{ id: string; tenant_id: string; pair_key: string }> = [];
  measurementVariants: Array<{
    run_id: string;
    tenant_id: string;
    variant: "control" | "treatment";
    task_id: string;
    status: string;
  }> = [];

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
      ORG_BUS_OUT: {
        send: async (payload: unknown) => {
          sent.push(payload);
        }
      }
    } as any;

    const body = {
      tenant_id: "default",
      capability: "memory_measurement",
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

  it("creates paired control and treatment tasks for measurement mode", async () => {
    const db = new FakeD1();
    const sent: any[] = [];

    const env = {
      OPEN_BRAIN_DB: db,
      OPEN_BRAIN_BUCKET: {},
      API_KEY: "x",
      ORG_BUS_OUT: {
        send: async (payload: unknown) => {
          sent.push(payload);
        }
      }
    } as any;

    const result = await createTask(env, {
      tenant_id: "default",
      project_id: "proj1",
      capability: "memory_measurement",
      input_ref: "spec://abc",
      measurement_mode: true,
      measurement_session_id: "session-1",
      measurement_unit: "session",
      measurement_reference_model: "estimated_tokens_v1"
    });

    expect(result.measurement_run_id).toBeTruthy();
    expect(result.variants?.map((item) => item.variant).sort()).toEqual(["control", "treatment"]);
    expect(db.tasks).toHaveLength(2);
    expect(db.measurementRuns).toHaveLength(1);
    expect(db.measurementVariants).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(sent.find((payload) => payload.payload.measurement.variant === "control").payload.measurement).toMatchObject({
      session_id: "session-1",
      unit: "session",
      memory_enabled: false,
      memory_write_enabled: false
    });
    expect(sent.find((payload) => payload.payload.measurement.variant === "treatment").payload.measurement).toMatchObject({
      memory_enabled: true,
      memory_write_enabled: false
    });
  });
});
