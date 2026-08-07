import { describe, expect, it } from "vitest";
import { runRecordedScheduledJob } from "../src/scheduled-jobs";

type RunRow = {
  id: string;
  job_name: string;
  scheduled_for: number;
  status: "running" | "succeeded" | "failed";
  attempt: number;
  started_at: number;
  finished_at: number | null;
  result_json: string | null;
  error_message: string | null;
};

class FakeStatement {
  args: unknown[] = [];

  constructor(private db: FakeD1, private sql: string) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    const row = this.db.rows.find(
      (candidate) => candidate.job_name === this.args[0] && candidate.scheduled_for === this.args[1]
    );
    return (row ?? null) as T | null;
  }

  async run() {
    if (this.sql.includes("INSERT OR IGNORE INTO scheduled_job_runs")) {
      const exists = this.db.rows.some(
        (row) => row.job_name === this.args[1] && row.scheduled_for === this.args[2]
      );
      if (exists) return { meta: { changes: 0 } };
      this.db.rows.push({
        id: String(this.args[0]),
        job_name: String(this.args[1]),
        scheduled_for: Number(this.args[2]),
        status: "running",
        attempt: 1,
        started_at: Number(this.args[5]),
        finished_at: null,
        result_json: null,
        error_message: null
      });
      return { meta: { changes: 1 } };
    }

    const row = this.db.rows.find((candidate) => candidate.id === this.args[this.sql.includes("attempt = attempt + 1") ? 2 : 3]);
    if (!row) return { meta: { changes: 0 } };

    if (this.sql.includes("attempt = attempt + 1")) {
      const staleCutoff = Number(this.args[3]);
      if (row.status !== "failed" && !(row.status === "running" && row.started_at <= staleCutoff)) {
        return { meta: { changes: 0 } };
      }
      row.status = "running";
      row.attempt += 1;
      row.started_at = Number(this.args[0]);
      row.finished_at = null;
      row.result_json = null;
      row.error_message = null;
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes("status = 'succeeded'")) {
      row.status = "succeeded";
      row.finished_at = Number(this.args[0]);
      row.result_json = String(this.args[1]);
      row.error_message = null;
      return { meta: { changes: 1 } };
    }

    row.status = "failed";
    row.finished_at = Number(this.args[0]);
    row.error_message = String(this.args[1]);
    return { meta: { changes: 1 } };
  }
}

class FakeD1 {
  rows: RunRow[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

describe("runRecordedScheduledJob", () => {
  it("records success and deduplicates the same scheduled run", async () => {
    const db = new FakeD1();
    let calls = 0;
    const first = await runRecordedScheduledJob(db as unknown as D1Database, {
      jobName: "daily",
      scheduledFor: 100,
      now: 1_000
    }, async () => ({ count: ++calls }));
    const duplicate = await runRecordedScheduledJob(db as unknown as D1Database, {
      jobName: "daily",
      scheduledFor: 100,
      now: 2_000
    }, async () => ({ count: ++calls }));

    expect(first).toMatchObject({ executed: true, attempt: 1, value: { count: 1 } });
    expect(duplicate).toEqual({ executed: false, deduplicated: true, attempt: 1 });
    expect(calls).toBe(1);
    expect(db.rows[0]).toMatchObject({ status: "succeeded", result_json: '{"count":1}' });
  });

  it("records failure and allows a later retry", async () => {
    const db = new FakeD1();
    await expect(runRecordedScheduledJob(db as unknown as D1Database, {
      jobName: "daily",
      scheduledFor: 100,
      now: 1_000
    }, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    const retry = await runRecordedScheduledJob(db as unknown as D1Database, {
      jobName: "daily",
      scheduledFor: 100,
      now: 2_000
    }, async () => "ok");

    expect(retry).toMatchObject({ executed: true, attempt: 2, value: "ok" });
    expect(db.rows[0]).toMatchObject({ status: "succeeded", attempt: 2 });
  });

  it("skips an active run but reclaims a stale run", async () => {
    const db = new FakeD1();
    db.rows.push({
      id: "run-1",
      job_name: "daily",
      scheduled_for: 100,
      status: "running",
      attempt: 1,
      started_at: 1_000,
      finished_at: null,
      result_json: null,
      error_message: null
    });

    const active = await runRecordedScheduledJob(db as unknown as D1Database, {
      jobName: "daily",
      scheduledFor: 100,
      now: 2_000,
      staleAfterMs: 2_000
    }, async () => "not-called");
    const reclaimed = await runRecordedScheduledJob(db as unknown as D1Database, {
      jobName: "daily",
      scheduledFor: 100,
      now: 4_000,
      staleAfterMs: 2_000
    }, async () => "reclaimed");

    expect(active.executed).toBe(false);
    expect(reclaimed).toMatchObject({ executed: true, attempt: 2, value: "reclaimed" });
  });
});
