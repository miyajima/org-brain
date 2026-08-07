import { HttpError, sha256, ulid } from "@org-brain/shared";
import type { Env } from "./types";

const STALE_JOB_MS = 36 * 60 * 60_000;
const STUCK_TASK_MS = 30 * 60_000;
const REPEAT_NOTIFICATION_MS = 6 * 60 * 60_000;
const JOB_NAMES = ["memory-maintenance", "retrieval-metrics-rollup", "retention-sweep"] as const;

type AlertSeverity = "warning" | "critical";
type AlertStatus = "firing" | "resolved";

type EvaluatedAlert = {
  key: string;
  severity: AlertSeverity;
  title: string;
  summary: string;
  details: Record<string, unknown>;
  confirmations: 1 | 2;
};

type AlertState = {
  alert_key: string;
  severity: AlertSeverity;
  status: "pending" | "firing" | "resolved";
  fingerprint: string;
  observation_count: number;
  first_seen_at: number;
  last_seen_at: number;
  last_notified_at: number | null;
  resolved_at: number | null;
  details_json: string;
};

type WebhookPayload = {
  schema_version: 1;
  event_id: string;
  alert_key: string;
  status: AlertStatus;
  severity: AlertSeverity;
  title: string;
  summary: string;
  observed_at: number;
  details: Record<string, unknown>;
  text: string;
};

export function shouldNotifyAlert(
  previousStatus: AlertState["status"] | null,
  previousFingerprint: string | null,
  fingerprint: string,
  lastNotifiedAt: number | null,
  now: number
): boolean {
  return previousStatus !== "firing" ||
    previousFingerprint !== fingerprint ||
    lastNotifiedAt === null ||
    now - lastNotifiedAt >= REPEAT_NOTIFICATION_MS;
}

export function alertStatusForObservationCount(
  observationCount: number,
  confirmations: 1 | 2
): "pending" | "firing" {
  return observationCount >= confirmations ? "firing" : "pending";
}

async function sendWebhook(url: string, payload: WebhookPayload): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`ops alert webhook returned HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

function payloadFor(alert: EvaluatedAlert, status: AlertStatus, now: number): WebhookPayload {
  const title = status === "resolved" ? `Resolved: ${alert.title}` : alert.title;
  return {
    schema_version: 1,
    event_id: ulid(),
    alert_key: alert.key,
    status,
    severity: alert.severity,
    title,
    summary: status === "resolved" ? `Resolved: ${alert.summary}` : alert.summary,
    observed_at: now,
    details: alert.details,
    text: `[${alert.severity}] ${title}`
  };
}

async function evaluateScheduledJobs(env: Env, now: number): Promise<EvaluatedAlert[]> {
  const alerts: EvaluatedAlert[] = [];
  for (const jobName of JOB_NAMES) {
    const latest = await env.OPEN_BRAIN_DB.prepare(
      `SELECT status, scheduled_for, finished_at, error_message
       FROM scheduled_job_runs WHERE job_name = ?
       ORDER BY scheduled_for DESC LIMIT 1`
    ).bind(jobName).first<{
      status: string;
      scheduled_for: number;
      finished_at: number | null;
      error_message: string | null;
    }>();
    const success = await env.OPEN_BRAIN_DB.prepare(
      `SELECT MAX(finished_at) AS last_success_at
       FROM scheduled_job_runs WHERE job_name = ? AND status = 'succeeded'`
    ).bind(jobName).first<{ last_success_at: number | null }>();
    const lastSuccessAt = success?.last_success_at ?? null;
    if (latest?.status === "failed") {
      alerts.push({
        key: `scheduled-job:${jobName}`,
        severity: "critical",
        title: "Scheduled job failed",
        summary: `${jobName} latest execution failed`,
        details: {
          job_name: jobName,
          scheduled_for: latest.scheduled_for,
          error: latest.error_message
        },
        confirmations: 1
      });
      continue;
    }
    if (lastSuccessAt === null || now - lastSuccessAt > STALE_JOB_MS) {
      alerts.push({
        key: `scheduled-job:${jobName}`,
        severity: "critical",
        title: "Scheduled job is stale",
        summary: `${jobName} has no successful run within 36 hours`,
        details: { job_name: jobName, last_success_at: lastSuccessAt },
        confirmations: 1
      });
    }
  }
  return alerts;
}

async function evaluateTenants(env: Env, now: number): Promise<EvaluatedAlert[]> {
  const tenants = await env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id FROM memories
     UNION SELECT tenant_id FROM tasks
     UNION SELECT tenant_id FROM retention_policies
     ORDER BY tenant_id`
  ).all<{ tenant_id: string }>();
  const alerts: EvaluatedAlert[] = [];
  for (const { tenant_id: tenantId } of tenants.results) {
    const [tasks, memories, retrieval, retentionQueue] = await Promise.all([
      env.OPEN_BRAIN_DB.prepare(
        `SELECT
           SUM(CASE WHEN status IN ('failed', 'dead_letter') THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status IN ('created', 'queued', 'leased', 'running') AND updated_at < ? THEN 1 ELSE 0 END) AS stuck
         FROM tasks WHERE tenant_id = ?`
      ).bind(now - STUCK_TASK_MS, tenantId).first<Record<string, number | null>>(),
      env.OPEN_BRAIN_DB.prepare(
        `SELECT COUNT(*) AS active FROM memories
         WHERE tenant_id = ? AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')`
      ).bind(tenantId).first<Record<string, number | null>>(),
      env.OPEN_BRAIN_DB.prepare(
        `SELECT COUNT(DISTINCT units.memory_id) AS projected,
                SUM(CASE WHEN units.extraction_state != 'ready' THEN 1 ELSE 0 END) AS degraded
         FROM memory_retrieval_units units
         INNER JOIN memories
           ON memories.tenant_id = units.tenant_id AND memories.id = units.memory_id
         WHERE units.tenant_id = ?
           AND (memories.lifecycle_state IS NULL OR memories.lifecycle_state != 'suppressed')`
      ).bind(tenantId).first<Record<string, number | null>>(),
      env.OPEN_BRAIN_DB.prepare(
        `SELECT
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'manual_review' THEN 1 ELSE 0 END) AS manual_review,
           SUM(CASE WHEN status IN ('pending', 'failed') AND delete_after <= ? THEN 1 ELSE 0 END) AS overdue
         FROM retention_deletion_queue WHERE tenant_id = ?`
      ).bind(now, tenantId).first<Record<string, number | null>>()
    ]);
    const failedTasks = Number(tasks?.failed ?? 0);
    const stuckTasks = Number(tasks?.stuck ?? 0);
    if (failedTasks > 0 || stuckTasks > 0) {
      alerts.push({
        key: `tasks:${tenantId}`,
        severity: "critical",
        title: "Task failures require attention",
        summary: `${tenantId} has ${failedTasks} failed/DLQ and ${stuckTasks} stuck tasks`,
        details: { tenant_id: tenantId, failed: failedTasks, stuck: stuckTasks },
        confirmations: 1
      });
    }
    const active = Number(memories?.active ?? 0);
    const projected = Number(retrieval?.projected ?? 0);
    const degraded = Number(retrieval?.degraded ?? 0);
    const coverage = active > 0 ? projected / active : 1;
    if (coverage < 0.98 || degraded > 0) {
      alerts.push({
        key: `retrieval-projection:${tenantId}`,
        severity: "warning",
        title: "Retrieval projection is degraded",
        summary: `${tenantId} retrieval coverage is ${(coverage * 100).toFixed(2)}% with ${degraded} degraded units`,
        details: { tenant_id: tenantId, active, projected, coverage, degraded },
        confirmations: 2
      });
    }
    const failedRetention = Number(retentionQueue?.failed ?? 0);
    const manualReview = Number(retentionQueue?.manual_review ?? 0);
    const overdue = Number(retentionQueue?.overdue ?? 0);
    if (failedRetention > 0 || manualReview > 0 || overdue > 0) {
      alerts.push({
        key: `retention-queue:${tenantId}`,
        severity: "critical",
        title: "Retention queue requires attention",
        summary: `${tenantId} has ${failedRetention} failed, ${manualReview} manual-review, and ${overdue} overdue retention items`,
        details: { tenant_id: tenantId, failed: failedRetention, manual_review: manualReview, overdue },
        confirmations: 1
      });
    }
  }
  return alerts;
}

async function storeObservedAlert(
  env: Env,
  alert: EvaluatedAlert,
  existing: AlertState | undefined,
  fingerprint: string,
  observationCount: number,
  status: "pending" | "firing",
  now: number
): Promise<void> {
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO ops_alert_state(
      alert_key, severity, status, fingerprint, observation_count, first_seen_at,
      last_seen_at, last_notified_at, resolved_at, details_json, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(alert_key) DO UPDATE SET
      severity = excluded.severity,
      status = excluded.status,
      fingerprint = excluded.fingerprint,
      observation_count = excluded.observation_count,
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at,
      resolved_at = NULL,
      details_json = excluded.details_json,
      updated_at = excluded.updated_at`
  ).bind(
    alert.key,
    alert.severity,
    status,
    fingerprint,
    observationCount,
    existing && existing.status !== "resolved" ? existing.first_seen_at : now,
    now,
    existing?.last_notified_at ?? null,
    null,
    JSON.stringify(alert.details),
    existing ? existing.first_seen_at : now,
    now
  ).run();
}

export async function runOpsWatchdog(env: Env, now = Date.now()): Promise<{
  ok: true;
  checked_at: number;
  active_alert_count: number;
  sent_count: number;
  resolved_count: number;
  alerts: Array<{ alert_key: string; severity: AlertSeverity; status: "pending" | "firing" }>;
}> {
  const webhookUrl = env.OPS_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) throw new HttpError(503, "watchdog_not_configured", "OPS_ALERT_WEBHOOK_URL is not configured");
  const alerts = [...await evaluateScheduledJobs(env, now), ...await evaluateTenants(env, now)];
  const currentKeys = new Set(alerts.map((alert) => alert.key));
  const stored = await env.OPEN_BRAIN_DB.prepare(
    `SELECT alert_key, severity, status, fingerprint, observation_count, first_seen_at,
            last_seen_at, last_notified_at, resolved_at, details_json
     FROM ops_alert_state`
  ).all<AlertState>();
  const byKey = new Map(stored.results.map((state) => [state.alert_key, state]));
  const statuses: Array<{ alert_key: string; severity: AlertSeverity; status: "pending" | "firing" }> = [];
  let sentCount = 0;
  let resolvedCount = 0;

  for (const alert of alerts) {
    const existing = byKey.get(alert.key);
    const fingerprint = await sha256(JSON.stringify([alert.severity, alert.title]));
    const sameObservation = existing && existing.status !== "resolved";
    const observationCount = sameObservation ? existing.observation_count + 1 : 1;
    const status = alertStatusForObservationCount(observationCount, alert.confirmations);
    await storeObservedAlert(env, alert, existing, fingerprint, observationCount, status, now);
    statuses.push({ alert_key: alert.key, severity: alert.severity, status });
    if (
      status === "firing" &&
      shouldNotifyAlert(
        existing?.status ?? null,
        existing?.fingerprint ?? null,
        fingerprint,
        existing?.last_notified_at ?? null,
        now
      )
    ) {
      await sendWebhook(webhookUrl, payloadFor(alert, "firing", now));
      await env.OPEN_BRAIN_DB.prepare(
        "UPDATE ops_alert_state SET last_notified_at = ?, updated_at = ? WHERE alert_key = ?"
      ).bind(now, now, alert.key).run();
      sentCount += 1;
    }
  }

  for (const state of stored.results) {
    if (state.status === "resolved" || currentKeys.has(state.alert_key)) continue;
    if (state.status === "firing") {
      const details = JSON.parse(state.details_json) as Record<string, unknown>;
      await sendWebhook(webhookUrl, payloadFor({
        key: state.alert_key,
        severity: state.severity,
        title: "Operational alert",
        summary: state.alert_key,
        details,
        confirmations: 1
      }, "resolved", now));
      resolvedCount += 1;
    }
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE ops_alert_state
       SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE alert_key = ?`
    ).bind(now, now, state.alert_key).run();
  }

  return {
    ok: true,
    checked_at: now,
    active_alert_count: alerts.length,
    sent_count: sentCount,
    resolved_count: resolvedCount,
    alerts: statuses
  };
}
