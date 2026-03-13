import { ulid } from "@org-brain/shared";
import type { CapabilityName } from "@org-brain/shared";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const RAW_RETENTION_DAYS = 90;

type RetrievalEventRow = {
  tenant_id: string;
  capability: CapabilityName;
  search_strategy: string;
  task_id: string;
  matched_count: number;
  returned_count: number;
  fallback_used: number;
  latency_ms: number;
  created_at: number;
};

type TaskStatusRow = {
  id: string;
  status: string;
  created_at: number;
  updated_at: number;
};

type RetrievalTelemetryEvent = {
  tenantId: string;
  projectId?: string;
  taskId: string;
  capability: CapabilityName;
  searchStrategy: string;
  queryText: string;
  queryHash: string;
  matchedCount: number;
  returnedCount: number;
  fallbackUsed: boolean;
  latencyMs: number;
  topMemoryIds: string[];
  topScores: Array<number | null> | null;
  createdAt?: number;
};

type RetrievalDailyMetric = {
  day: string;
  tenantId: string;
  capability: CapabilityName;
  searchStrategy: string;
  searchCount: number;
  taskCount: number;
  hitRate: number;
  fallbackRate: number;
  avgMatchedCount: number;
  avgReturnedCount: number;
  avgLatencyMs: number;
  p95LatencyMs: number | null;
  successRate: number;
  avgTaskDurationMs: number | null;
  failedTaskCount: number;
  createdAt: number;
};

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatUtcDayFromTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function utcDayBounds(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start)) {
    throw new Error(`invalid UTC day: ${day}`);
  }
  return { start, end: start + MS_PER_DAY };
}

export function previousUtcDay(now: number): string {
  return formatUtcDayFromTimestamp(now - MS_PER_DAY);
}

export function rawRetentionCutoff(now: number): number {
  return now - RAW_RETENTION_DAYS * MS_PER_DAY;
}

function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[Math.min(rank, sorted.length - 1)] ?? null;
}

function asBooleanInt(value: boolean): number {
  return value ? 1 : 0;
}

export async function appendTaskEvent(
  db: D1Database,
  tenantId: string,
  taskId: string,
  kind: string,
  payload: Record<string, unknown>,
  createdAt = Date.now()
): Promise<void> {
  await db.prepare("INSERT INTO task_events(id, tenant_id, task_id, kind, payload, created_at) VALUES(?,?,?,?,?,?)")
    .bind(ulid(), tenantId, taskId, kind, JSON.stringify(payload), createdAt)
    .run();
}

export async function recordRetrievalTelemetry(
  db: D1Database,
  event: RetrievalTelemetryEvent
): Promise<{ retrievalSaved: boolean; taskEventSaved: boolean }> {
  const createdAt = event.createdAt ?? Date.now();
  let retrievalSaved = false;
  let taskEventSaved = false;

  try {
    await db.prepare(
      `INSERT INTO retrieval_events(
        id, tenant_id, project_id, task_id, capability, search_strategy, query_text, query_hash,
        matched_count, returned_count, fallback_used, latency_ms, top_memory_ids_json, top_scores_json, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        ulid(),
        event.tenantId,
        event.projectId ?? null,
        event.taskId,
        event.capability,
        event.searchStrategy,
        event.queryText,
        event.queryHash,
        event.matchedCount,
        event.returnedCount,
        asBooleanInt(event.fallbackUsed),
        event.latencyMs,
        JSON.stringify(event.topMemoryIds),
        event.topScores ? JSON.stringify(event.topScores) : null,
        createdAt
      )
      .run();
    retrievalSaved = true;
  } catch {
    retrievalSaved = false;
  }

  try {
    await appendTaskEvent(
      db,
      event.tenantId,
      event.taskId,
      "memory.search",
      {
        strategy: event.searchStrategy,
        matched_count: event.matchedCount,
        returned_count: event.returnedCount,
        fallback_used: event.fallbackUsed,
        latency_ms: event.latencyMs
      },
      createdAt
    );
    taskEventSaved = true;
  } catch {
    taskEventSaved = false;
  }

  return { retrievalSaved, taskEventSaved };
}

async function loadRetrievalEventsForDay(db: D1Database, day: string): Promise<RetrievalEventRow[]> {
  const { start, end } = utcDayBounds(day);
  const result = await db.prepare(
    `SELECT tenant_id, capability, search_strategy, task_id, matched_count, returned_count, fallback_used, latency_ms, created_at
     FROM retrieval_events
     WHERE created_at >= ? AND created_at < ?`
  )
    .bind(start, end)
    .all<RetrievalEventRow>();

  return result.results.map((row) => ({
    tenant_id: row.tenant_id,
    capability: row.capability,
    search_strategy: row.search_strategy,
    task_id: row.task_id,
    matched_count: safeNumber(row.matched_count),
    returned_count: safeNumber(row.returned_count),
    fallback_used: safeNumber(row.fallback_used),
    latency_ms: safeNumber(row.latency_ms),
    created_at: safeNumber(row.created_at)
  }));
}

async function loadTasksByIds(db: D1Database, taskIds: string[]): Promise<Map<string, TaskStatusRow>> {
  const tasks = new Map<string, TaskStatusRow>();
  if (taskIds.length === 0) return tasks;

  for (let index = 0; index < taskIds.length; index += 100) {
    const chunk = taskIds.slice(index, index + 100);
    const placeholders = chunk.map(() => "?").join(",");
    const stmt = db.prepare(
      `SELECT id, status, created_at, updated_at
       FROM tasks
       WHERE id IN (${placeholders})`
    );
    const result = await stmt.bind(...chunk).all<TaskStatusRow>();
    for (const row of result.results) {
      tasks.set(row.id, {
        id: row.id,
        status: row.status,
        created_at: safeNumber(row.created_at),
        updated_at: safeNumber(row.updated_at)
      });
    }
  }

  return tasks;
}

function summarizeDailyMetrics(
  day: string,
  rows: RetrievalEventRow[],
  tasks: Map<string, TaskStatusRow>,
  createdAt: number
): RetrievalDailyMetric[] {
  const groups = new Map<
    string,
    {
      tenantId: string;
      capability: CapabilityName;
      searchStrategy: string;
      searchCount: number;
      hitCount: number;
      fallbackCount: number;
      matchedTotal: number;
      returnedTotal: number;
      latencies: number[];
      taskIds: Set<string>;
      succeededTaskIds: Set<string>;
      failedTaskIds: Set<string>;
      taskDurationTotal: number;
      taskDurationCount: number;
    }
  >();

  for (const row of rows) {
    const key = [row.tenant_id, row.capability, row.search_strategy].join("::");
    let group = groups.get(key);
    if (!group) {
      group = {
        tenantId: row.tenant_id,
        capability: row.capability,
        searchStrategy: row.search_strategy,
        searchCount: 0,
        hitCount: 0,
        fallbackCount: 0,
        matchedTotal: 0,
        returnedTotal: 0,
        latencies: [],
        taskIds: new Set<string>(),
        succeededTaskIds: new Set<string>(),
        failedTaskIds: new Set<string>(),
        taskDurationTotal: 0,
        taskDurationCount: 0
      };
      groups.set(key, group);
    }

    group.searchCount += 1;
    group.hitCount += row.matched_count > 0 ? 1 : 0;
    group.fallbackCount += row.fallback_used > 0 ? 1 : 0;
    group.matchedTotal += row.matched_count;
    group.returnedTotal += row.returned_count;
    group.latencies.push(row.latency_ms);

    if (group.taskIds.has(row.task_id)) continue;
    group.taskIds.add(row.task_id);

    const task = tasks.get(row.task_id);
    if (!task) continue;
    const duration = Math.max(0, task.updated_at - task.created_at);
    group.taskDurationTotal += duration;
    group.taskDurationCount += 1;
    if (task.status === "succeeded") {
      group.succeededTaskIds.add(row.task_id);
    } else if (task.status === "failed") {
      group.failedTaskIds.add(row.task_id);
    }
  }

  return [...groups.values()].map((group) => ({
    day,
    tenantId: group.tenantId,
    capability: group.capability,
    searchStrategy: group.searchStrategy,
    searchCount: group.searchCount,
    taskCount: group.taskIds.size,
    hitRate: group.searchCount > 0 ? group.hitCount / group.searchCount : 0,
    fallbackRate: group.searchCount > 0 ? group.fallbackCount / group.searchCount : 0,
    avgMatchedCount: group.searchCount > 0 ? group.matchedTotal / group.searchCount : 0,
    avgReturnedCount: group.searchCount > 0 ? group.returnedTotal / group.searchCount : 0,
    avgLatencyMs: group.searchCount > 0 ? group.latencies.reduce((sum, value) => sum + value, 0) / group.searchCount : 0,
    p95LatencyMs: percentile(group.latencies, 95),
    successRate: group.taskIds.size > 0 ? group.succeededTaskIds.size / group.taskIds.size : 0,
    avgTaskDurationMs:
      group.taskDurationCount > 0 ? group.taskDurationTotal / group.taskDurationCount : null,
    failedTaskCount: group.failedTaskIds.size,
    createdAt
  }));
}

function buildRollupStatements(db: D1Database, rows: RetrievalDailyMetric[], day: string) {
  const statements = [
    db.prepare("DELETE FROM retrieval_daily_metrics WHERE day = ?").bind(day)
  ];

  for (const row of rows) {
    statements.push(
      db.prepare(
        `INSERT INTO retrieval_daily_metrics(
          day, tenant_id, capability, search_strategy, search_count, task_count,
          hit_rate, fallback_rate, avg_matched_count, avg_returned_count, avg_latency_ms,
          p95_latency_ms, success_rate, avg_task_duration_ms, failed_task_count, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        row.day,
        row.tenantId,
        row.capability,
        row.searchStrategy,
        row.searchCount,
        row.taskCount,
        row.hitRate,
        row.fallbackRate,
        row.avgMatchedCount,
        row.avgReturnedCount,
        row.avgLatencyMs,
        row.p95LatencyMs,
        row.successRate,
        row.avgTaskDurationMs,
        row.failedTaskCount,
        row.createdAt
      )
    );
  }

  return statements;
}

export async function rollupRetrievalMetricsForDay(
  db: D1Database,
  day: string,
  now = Date.now()
): Promise<{ day: string; rawEventCount: number; groupCount: number }> {
  const rows = await loadRetrievalEventsForDay(db, day);
  const tasks = await loadTasksByIds(db, [...new Set(rows.map((row) => row.task_id))]);
  const summaries = summarizeDailyMetrics(day, rows, tasks, now);
  await db.batch(buildRollupStatements(db, summaries, day));
  return {
    day,
    rawEventCount: rows.length,
    groupCount: summaries.length
  };
}

export async function pruneRetrievalEvents(
  db: D1Database,
  cutoffTimestamp: number
): Promise<{ cutoffTimestamp: number }> {
  await db.prepare("DELETE FROM retrieval_events WHERE created_at < ?").bind(cutoffTimestamp).run();
  return { cutoffTimestamp };
}
