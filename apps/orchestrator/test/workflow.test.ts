import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class WorkflowEntrypoint<Env = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  }

  return { WorkflowEntrypoint };
});

import { SpecToCodeWorkflow } from "../src/index";

type TaskRow = {
  id: string;
  tenant_id: string;
  status: string;
  output_ref: string | null;
  wait_event_type: string | null;
  idempotency_key: string;
};

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
    if (this.sql.startsWith("SELECT id FROM tasks")) {
      const tenantId = this.args[0] as string;
      const idem = this.args[1] as string;
      const found = this.db.tasks.find((x) => x.tenant_id === tenantId && x.idempotency_key === idem);
      return (found ? { id: found.id } : null) as T | null;
    }

    if (this.sql.startsWith("SELECT status, output_ref, wait_event_type FROM tasks")) {
      const tenantId = this.args[0] as string;
      const taskId = this.args[1] as string;
      const found = this.db.tasks.find((x) => x.tenant_id === tenantId && x.id === taskId);
      if (!found) return null;
      return {
        status: found.status,
        output_ref: found.output_ref,
        wait_event_type: found.wait_event_type
      } as T;
    }

    return null;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO tasks")) {
      this.db.tasks.push({
        id: this.args[0] as string,
        tenant_id: this.args[1] as string,
        status: this.args[4] as string,
        output_ref: null,
        idempotency_key: this.args[7] as string,
        wait_event_type: this.args[9] as string | null
      });
    }

    if (this.sql.startsWith("INSERT INTO task_events")) {
      this.db.events += 1;
    }

    return { success: true };
  }
}

class FakeD1 {
  tasks: TaskRow[] = [];
  events = 0;

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

class FakeStep {
  waitCalls: Array<{ name: string; type: string; timeout: string }> = [];
  sleepCalls = 0;
  private readonly db: FakeD1;
  private readonly outputRefByType: Record<string, string>;

  constructor(db: FakeD1, outputRefByType: Record<string, string>) {
    this.db = db;
    this.outputRefByType = outputRefByType;
  }

  async do<T>(_: string, maybeConfigOrCb: (() => Promise<T>) | unknown, maybeCb?: () => Promise<T>): Promise<T> {
    const cb = typeof maybeConfigOrCb === "function" ? maybeConfigOrCb : maybeCb;
    if (!cb) throw new Error("missing callback");
    return cb();
  }

  async waitForEvent<T>(name: string, options: { type: string; timeout?: string }): Promise<{
    payload: T;
    timestamp: Date;
    type: string;
  }> {
    this.waitCalls.push({
      name,
      type: options.type,
      timeout: String(options.timeout ?? "")
    });

    const task = this.db.tasks.find((x) => x.wait_event_type === options.type);
    const outputRef = this.outputRefByType[options.type];
    if (!task || !outputRef) {
      throw new Error(`unexpected wait type: ${options.type}`);
    }

    return {
      payload: {
        task_id: task.id,
        status: "succeeded",
        output_ref: outputRef
      } as T,
      timestamp: new Date(),
      type: options.type
    };
  }

  async sleep(): Promise<void> {
    this.sleepCalls += 1;
  }
}

describe("SpecToCodeWorkflow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("waits via waitForEvent and returns sequential outputs", async () => {
    const db = new FakeD1();
    const sent: unknown[] = [];
    const env = {
      OPEN_BRAIN_DB: db,
      ORG_BUS_OUT: {
        send: async (payload: unknown) => {
          sent.push(payload);
        }
      }
    } as any;

    const workflow = new SpecToCodeWorkflow({} as any, env);
    const instanceId = "wf-1";
    const step = new FakeStep(db, {
      [`task.${instanceId}.plan.done`]: "r2://plan.md",
      [`task.${instanceId}.code.done`]: "r2://patch.diff",
      [`task.${instanceId}.review.done`]: "r2://review.md"
    });

    const result = await workflow.run(
      {
        instanceId,
        timestamp: new Date(),
        payload: {
          tenant_id: "default",
          project_id: "proj-1",
          spec_ref: "r2://spec.md"
        }
      } as any,
      step as any
    );

    expect(result).toMatchObject({
      ok: true,
      outputs: {
        plan: "r2://plan.md",
        code: "r2://patch.diff",
        review: "r2://review.md"
      }
    });
    expect(step.waitCalls.map((x) => x.type)).toEqual([
      "task.wf-1.plan.done",
      "task.wf-1.code.done",
      "task.wf-1.review.done"
    ]);
    expect(step.sleepCalls).toBe(0);
    expect(sent).toHaveLength(3);
    expect(db.tasks).toHaveLength(3);
  });
});
