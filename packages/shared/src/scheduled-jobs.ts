import { ulid } from "./ids";

export type ScheduledJobRunOptions = {
  jobName: string;
  scheduledFor: number;
  now?: number;
  staleAfterMs?: number;
};

export type ScheduledJobExecution<T> = {
  executed: boolean;
  deduplicated: boolean;
  attempt: number;
  value?: T;
};

type ScheduledJobRow = {
  id: string;
  status: "running" | "succeeded" | "failed";
  attempt: number;
  started_at: number;
};

function changedRows(result: unknown): number {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

export async function runRecordedScheduledJob<T>(
  db: D1Database,
  options: ScheduledJobRunOptions,
  handler: () => Promise<T>
): Promise<ScheduledJobExecution<T>> {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? 30 * 60 * 1_000;
  const scheduledFor = Math.floor(options.scheduledFor);
  const createdId = ulid();
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO scheduled_job_runs(
      id, job_name, scheduled_for, status, attempt, started_at,
      finished_at, result_json, error_message, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    createdId,
    options.jobName,
    scheduledFor,
    "running",
    1,
    now,
    null,
    null,
    null,
    now,
    now
  ).run();

  let runId = createdId;
  let attempt = 1;
  let claimed = changedRows(inserted) > 0;

  if (!claimed) {
    const existing = await db.prepare(
      `SELECT id, status, attempt, started_at
       FROM scheduled_job_runs
       WHERE job_name = ? AND scheduled_for = ?`
    ).bind(options.jobName, scheduledFor).first<ScheduledJobRow>();
    if (!existing) throw new Error("scheduled job run disappeared while claiming");
    runId = existing.id;
    attempt = existing.attempt;
    if (existing.status === "succeeded") {
      return { executed: false, deduplicated: true, attempt };
    }
    if (existing.status === "running" && existing.started_at > now - staleAfterMs) {
      return { executed: false, deduplicated: true, attempt };
    }
    const reclaimed = await db.prepare(
      `UPDATE scheduled_job_runs
       SET status = 'running', attempt = attempt + 1, started_at = ?, finished_at = NULL,
           result_json = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?
         AND (status = 'failed' OR (status = 'running' AND started_at <= ?))`
    ).bind(now, now, runId, now - staleAfterMs).run();
    claimed = changedRows(reclaimed) > 0;
    if (!claimed) return { executed: false, deduplicated: true, attempt };
    attempt += 1;
  }

  try {
    const value = await handler();
    const finishedAt = Date.now();
    await db.prepare(
      `UPDATE scheduled_job_runs
       SET status = 'succeeded', finished_at = ?, result_json = ?, error_message = NULL, updated_at = ?
       WHERE id = ? AND status = 'running' AND attempt = ?`
    ).bind(finishedAt, JSON.stringify(value ?? null), finishedAt, runId, attempt).run();
    return { executed: true, deduplicated: false, attempt, value };
  } catch (error) {
    const finishedAt = Date.now();
    await db.prepare(
      `UPDATE scheduled_job_runs
       SET status = 'failed', finished_at = ?, error_message = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND attempt = ?`
    ).bind(finishedAt, errorMessage(error), finishedAt, runId, attempt).run();
    throw error;
  }
}
