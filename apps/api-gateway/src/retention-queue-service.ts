import { HttpError, ulid } from "@org-brain/shared";
import { appendAuditEvent } from "./audit-service";
import { deleteMemory, restoreSuppressedMemory, suppressMemory } from "./memory-lifecycle-service";
import {
  removeMemoryIdsFromSemanticIndex,
  removeMemoryIdsFromV3SemanticIndex,
  removeMemoryIdsFromV4SemanticIndex,
  syncMemoryIdsToSemanticIndex,
  syncMemoryIdsToV3SemanticIndex,
  syncMemoryIdsToV4SemanticIndex
} from "./retrieval-index-service";
import {
  assertMemoryNotOnLegalHold,
  effectiveRetentionPolicy,
  isRetentionEligible,
  listRetentionPolicies,
  loadRetentionCandidates,
  type RetentionCandidate,
  type RetentionPolicy
} from "./retention-service";
import type { Env } from "./types";

const DAY_MS = 86_400_000;
const GRACE_PERIOD_MS = 7 * DAY_MS;
const DISCOVERY_LIMIT = 500;
const DELETION_LIMIT = 100;
const MAX_FAILURES = 5;
const HISTORY_RETENTION_MS = 90 * DAY_MS;
const SYSTEM_ACTOR = "system:retention-sweep";

export const RETENTION_SWEEP_LIMITS = {
  discovery: DISCOVERY_LIMIT,
  deletion: DELETION_LIMIT,
  gracePeriodMs: GRACE_PERIOD_MS,
  maxFailures: MAX_FAILURES
} as const;

export type RetentionQueueStatus = "pending" | "deleted" | "cancelled" | "failed" | "manual_review";

export type RetentionQueueRow = {
  id: string;
  tenant_id: string;
  memory_id: string;
  policy_id: string;
  original_lifecycle_state: string;
  original_version: number;
  suppressed_version: number | null;
  effective_at: number;
  detected_at: number;
  delete_after: number;
  status: RetentionQueueStatus;
  attempt_count: number;
  last_error: string | null;
  deleted_at: number | null;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number;
};

type MemoryState = {
  id: string;
  project_id: string | null;
  lifecycle_state: string;
  current_version: number;
};

export type RetentionQueueDecision = "cancel" | "prepare" | "wait" | "delete" | "manual_review";

export function decideRetentionQueueAction(
  row: Pick<RetentionQueueRow, "suppressed_version" | "delete_after">,
  memory: Pick<MemoryState, "current_version"> | null,
  eligible: boolean,
  now: number
): RetentionQueueDecision {
  if (!memory) return "manual_review";
  if (!eligible) return "cancel";
  if (row.suppressed_version === null) return "prepare";
  if (memory.current_version !== row.suppressed_version) return "manual_review";
  return row.delete_after > now ? "wait" : "delete";
}

export function retentionFailureStatus(previousAttempts: number): RetentionQueueStatus {
  return previousAttempts + 1 >= MAX_FAILURES ? "manual_review" : "failed";
}

type SweepStats = {
  mode: "off" | "observe" | "enforce";
  candidate_count: number;
  queued_count: number;
  deleted_count: number;
  cancelled_count: number;
  failed_count: number;
  manual_review_count: number;
};

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

function projectionError(results: Array<{ error?: string }>): string | null {
  return results.find((result) => result.error)?.error ?? null;
}

async function removeFromAllIndexes(env: Env, tenantId: string, memoryId: string): Promise<void> {
  const results = await Promise.all([
    removeMemoryIdsFromSemanticIndex(env, tenantId, [memoryId]),
    removeMemoryIdsFromV3SemanticIndex(env, tenantId, [memoryId]),
    removeMemoryIdsFromV4SemanticIndex(env, tenantId, [memoryId])
  ]);
  const error = projectionError(results);
  if (error) throw new HttpError(503, "retrieval_projection_failed", error);
}

async function syncAllIndexes(env: Env, tenantId: string, memoryId: string): Promise<void> {
  const results = await Promise.all([
    syncMemoryIdsToSemanticIndex(env, tenantId, [memoryId]),
    syncMemoryIdsToV3SemanticIndex(env, tenantId, [memoryId]),
    syncMemoryIdsToV4SemanticIndex(env, tenantId, [memoryId])
  ]);
  const error = projectionError(results);
  if (error) throw new HttpError(503, "retrieval_projection_failed", error);
}

async function loadMemoryState(env: Env, tenantId: string, memoryId: string): Promise<MemoryState | null> {
  return env.OPEN_BRAIN_DB.prepare(
    `SELECT id, project_id, COALESCE(lifecycle_state, 'active') AS lifecycle_state,
            COALESCE(current_version, 1) AS current_version
     FROM memories WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, memoryId).first<MemoryState>();
}

async function loadQueueRow(env: Env, tenantId: string, memoryId: string): Promise<RetentionQueueRow | null> {
  return env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, memory_id, policy_id, original_lifecycle_state, original_version,
            suppressed_version, effective_at, detected_at, delete_after, status, attempt_count,
            last_error, deleted_at, cancelled_at, created_at, updated_at
     FROM retention_deletion_queue WHERE tenant_id = ? AND memory_id = ?`
  ).bind(tenantId, memoryId).first<RetentionQueueRow>();
}

async function markQueueFailure(env: Env, row: RetentionQueueRow, error: unknown, now: number): Promise<RetentionQueueStatus> {
  const attempts = row.attempt_count + 1;
  const status = retentionFailureStatus(row.attempt_count);
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE retention_deletion_queue
     SET status = ?, attempt_count = ?, last_error = ?, updated_at = ?
     WHERE id = ?`
  ).bind(status, attempts, message(error), now, row.id).run();
  return status;
}

async function reconcileSuppressionFailure(
  env: Env,
  row: RetentionQueueRow,
  priorVersion: number,
  indexesRemoved: boolean,
  error: unknown,
  now: number
): Promise<RetentionQueueStatus> {
  let recordedError = error;
  try {
    const current = await loadMemoryState(env, row.tenant_id, row.memory_id);
    if (
      current?.lifecycle_state === "suppressed" &&
      current.current_version > priorVersion
    ) {
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE retention_deletion_queue
         SET suppressed_version = ?, updated_at = ? WHERE id = ?`
      ).bind(current.current_version, now, row.id).run();
    } else if (current && indexesRemoved) {
      await syncAllIndexes(env, row.tenant_id, row.memory_id);
    }
  } catch (recoveryError) {
    recordedError = new Error(
      `${message(error)}; suppression recovery failed: ${message(recoveryError)}`
    );
  }
  return markQueueFailure(env, row, recordedError, now);
}

async function auditQueueAction(
  env: Env,
  row: Pick<RetentionQueueRow, "tenant_id" | "memory_id" | "id">,
  action: string,
  outcome: "succeeded" | "failed",
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await appendAuditEvent(env, {
    tenantId: row.tenant_id,
    principal: SYSTEM_ACTOR,
    action,
    resourceType: "retention-queue",
    resourceId: row.memory_id,
    outcome,
    metadata: { queue_id: row.id, ...metadata }
  });
}

async function stageCandidate(env: Env, candidate: RetentionCandidate, now: number): Promise<RetentionQueueStatus | "skipped"> {
  const existing = await loadQueueRow(env, candidate.tenant_id, candidate.id);
  if (existing && ["pending", "failed", "manual_review"].includes(existing.status)) return "skipped";
  if (existing?.status === "deleted") return "skipped";
  const queueId = existing?.id ?? ulid();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO retention_deletion_queue(
      id, tenant_id, memory_id, policy_id, original_lifecycle_state, original_version,
      suppressed_version, effective_at, detected_at, delete_after, status, attempt_count,
      last_error, deleted_at, cancelled_at, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id, memory_id) DO UPDATE SET
      policy_id = excluded.policy_id,
      original_lifecycle_state = excluded.original_lifecycle_state,
      original_version = excluded.original_version,
      suppressed_version = NULL,
      effective_at = excluded.effective_at,
      detected_at = excluded.detected_at,
      delete_after = excluded.delete_after,
      status = 'pending',
      attempt_count = 0,
      last_error = NULL,
      deleted_at = NULL,
      cancelled_at = NULL,
      updated_at = excluded.updated_at`
  ).bind(
    queueId,
    candidate.tenant_id,
    candidate.id,
    candidate.policy_id,
    candidate.lifecycle_state,
    candidate.current_version,
    null,
    candidate.effective_at,
    now,
    now + GRACE_PERIOD_MS,
    "pending",
    0,
    null,
    null,
    null,
    existing?.created_at ?? now,
    now
  ).run();
  let row = await loadQueueRow(env, candidate.tenant_id, candidate.id);
  if (!row) throw new Error("retention queue row disappeared after staging");
  let indexesRemoved = false;
  try {
    let suppressedVersion = candidate.current_version;
    if (candidate.lifecycle_state !== "suppressed") {
      indexesRemoved = true;
      await removeFromAllIndexes(env, candidate.tenant_id, candidate.id);
      const suppressed = await suppressMemory(env, {
        tenantId: candidate.tenant_id,
        memoryId: candidate.id,
        reason: "Retention policy grace period",
        actorType: "system",
        actorId: SYSTEM_ACTOR
      });
      suppressedVersion = suppressed.version;
    }
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE retention_deletion_queue
       SET status = 'pending', suppressed_version = ?, attempt_count = 0,
           last_error = NULL, updated_at = ? WHERE id = ?`
    ).bind(suppressedVersion, now, row.id).run();
    row = { ...row, suppressed_version: suppressedVersion };
    await auditQueueAction(env, row, "retention.queue", "succeeded", { delete_after: row.delete_after });
    return "pending";
  } catch (error) {
    const status = await reconcileSuppressionFailure(
      env,
      row,
      candidate.current_version,
      indexesRemoved,
      error,
      now
    );
    await auditQueueAction(env, row, "retention.queue", "failed", { error: message(error) });
    return status;
  }
}

async function cancelRow(env: Env, row: RetentionQueueRow, now: number): Promise<RetentionQueueStatus> {
  const memory = await loadMemoryState(env, row.tenant_id, row.memory_id);
  if (!memory) {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE retention_deletion_queue
       SET status = 'manual_review', last_error = ?, updated_at = ? WHERE id = ?`
    ).bind("memory no longer exists and cannot be restored", now, row.id).run();
    return "manual_review";
  }
  try {
    if (
      row.original_lifecycle_state !== "suppressed" &&
      row.suppressed_version !== null
    ) {
      if (memory.current_version !== row.suppressed_version) {
        await env.OPEN_BRAIN_DB.prepare(
          `UPDATE retention_deletion_queue
           SET status = 'manual_review', last_error = ?, updated_at = ? WHERE id = ?`
        ).bind("memory changed after retention suppression", now, row.id).run();
        return "manual_review";
      }
      await restoreSuppressedMemory(env, {
        tenantId: row.tenant_id,
        memoryId: row.memory_id,
        restoreVersion: row.original_version,
        actorType: "system",
        actorId: SYSTEM_ACTOR
      });
      await syncAllIndexes(env, row.tenant_id, row.memory_id);
    }
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE retention_deletion_queue
       SET status = 'cancelled', cancelled_at = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`
    ).bind(now, now, row.id).run();
    await auditQueueAction(env, row, "retention.cancel", "succeeded");
    return "cancelled";
  } catch (error) {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE retention_deletion_queue
       SET status = 'manual_review', last_error = ?, updated_at = ? WHERE id = ?`
    ).bind(message(error), now, row.id).run();
    await auditQueueAction(env, row, "retention.cancel", "failed", { error: message(error) });
    return "manual_review";
  }
}

async function prepareIncompleteRow(env: Env, row: RetentionQueueRow, memory: MemoryState, now: number): Promise<RetentionQueueRow | null> {
  if (row.suppressed_version !== null) return row;
  if (memory.current_version !== row.original_version) {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE retention_deletion_queue
       SET status = 'manual_review', last_error = ?, updated_at = ? WHERE id = ?`
    ).bind("memory changed before retention suppression completed", now, row.id).run();
    return null;
  }
  let indexesRemoved = false;
  try {
    let suppressedVersion = memory.current_version;
    if (memory.lifecycle_state !== "suppressed") {
      indexesRemoved = true;
      await removeFromAllIndexes(env, row.tenant_id, row.memory_id);
      const suppressed = await suppressMemory(env, {
        tenantId: row.tenant_id,
        memoryId: row.memory_id,
        reason: "Retention policy grace period",
        actorType: "system",
        actorId: SYSTEM_ACTOR
      });
      suppressedVersion = suppressed.version;
    }
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE retention_deletion_queue
       SET status = 'pending', suppressed_version = ?, last_error = NULL, updated_at = ? WHERE id = ?`
    ).bind(suppressedVersion, now, row.id).run();
    return { ...row, status: "pending", suppressed_version: suppressedVersion, last_error: null };
  } catch (error) {
    await reconcileSuppressionFailure(
      env,
      row,
      memory.current_version,
      indexesRemoved,
      error,
      now
    );
    return null;
  }
}

async function cleanupOperationalHistory(env: Env, now: number): Promise<void> {
  const cutoff = now - HISTORY_RETENTION_MS;
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM scheduled_job_runs WHERE status = 'succeeded' AND finished_at < ?"
    ).bind(cutoff),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM ops_alert_state WHERE status = 'resolved' AND resolved_at < ?"
    ).bind(cutoff),
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM retention_deletion_queue
       WHERE status IN ('deleted', 'cancelled') AND updated_at < ?`
    ).bind(cutoff)
  ]);
}

export async function runScheduledRetentionSweep(env: Env, now = Date.now()): Promise<SweepStats> {
  const rawMode = env.RETENTION_SWEEP_MODE ?? "observe";
  const mode: SweepStats["mode"] = ["off", "observe", "enforce"].includes(rawMode)
    ? rawMode as SweepStats["mode"]
    : "observe";
  const stats: SweepStats = {
    mode,
    candidate_count: 0,
    queued_count: 0,
    deleted_count: 0,
    cancelled_count: 0,
    failed_count: 0,
    manual_review_count: 0
  };
  if (mode === "off") return stats;

  const tenantRows = await env.OPEN_BRAIN_DB.prepare(
    "SELECT DISTINCT tenant_id FROM retention_policies ORDER BY tenant_id"
  ).all<{ tenant_id: string }>();
  const policiesByTenant = new Map<string, RetentionPolicy[]>();
  const candidates: RetentionCandidate[] = [];
  for (const tenant of tenantRows.results) {
    const policies = await listRetentionPolicies(env, tenant.tenant_id);
    policiesByTenant.set(tenant.tenant_id, policies);
    const remaining = DISCOVERY_LIMIT - candidates.length;
    if (remaining <= 0) break;
    candidates.push(...await loadRetentionCandidates(env, tenant.tenant_id, policies, { now, limit: remaining }));
  }
  stats.candidate_count = candidates.length;
  if (mode === "observe") {
    await cleanupOperationalHistory(env, now);
    return stats;
  }

  const queued = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, memory_id, policy_id, original_lifecycle_state, original_version,
            suppressed_version, effective_at, detected_at, delete_after, status, attempt_count,
            last_error, deleted_at, cancelled_at, created_at, updated_at
     FROM retention_deletion_queue
     WHERE status IN ('pending', 'failed')
     ORDER BY delete_after, tenant_id, memory_id
     LIMIT 5000`
  ).all<RetentionQueueRow>();
  let deletionBudget = DELETION_LIMIT;
  for (const initialRow of queued.results) {
    const policies = policiesByTenant.get(initialRow.tenant_id) ?? await listRetentionPolicies(env, initialRow.tenant_id);
    policiesByTenant.set(initialRow.tenant_id, policies);
    const tenantPolicy = policies.find((policy) => policy.project_id === null) ?? null;
    const memory = await loadMemoryState(env, initialRow.tenant_id, initialRow.memory_id);
    if (!memory) {
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE retention_deletion_queue
         SET status = 'manual_review', last_error = ?, updated_at = ? WHERE id = ?`
      ).bind("memory no longer exists", now, initialRow.id).run();
      stats.manual_review_count += 1;
      continue;
    }
    const policy = effectiveRetentionPolicy(policies, memory.project_id);
    const policyChanged =
      !policy ||
      policy.id !== initialRow.policy_id ||
      policy.updated_at > initialRow.detected_at;
    if (policyChanged || !isRetentionEligible(policy, initialRow.effective_at, now, tenantPolicy)) {
      const status = await cancelRow(env, initialRow, now);
      if (status === "cancelled") stats.cancelled_count += 1;
      else stats.manual_review_count += 1;
      continue;
    }
    const row = await prepareIncompleteRow(env, initialRow, memory, now);
    if (!row) {
      const current = await loadQueueRow(env, initialRow.tenant_id, initialRow.memory_id);
      if (current?.status === "manual_review") stats.manual_review_count += 1;
      else stats.failed_count += 1;
      continue;
    }
    if (row.delete_after > now || deletionBudget <= 0) continue;
    const refreshed = await loadMemoryState(env, row.tenant_id, row.memory_id);
    if (!refreshed || refreshed.current_version !== row.suppressed_version) {
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE retention_deletion_queue
         SET status = 'manual_review', last_error = ?, updated_at = ? WHERE id = ?`
      ).bind("memory changed during retention grace period", now, row.id).run();
      stats.manual_review_count += 1;
      continue;
    }
    let memoryDeleted = false;
    try {
      await assertMemoryNotOnLegalHold(env, row.tenant_id, row.memory_id);
      await removeFromAllIndexes(env, row.tenant_id, row.memory_id);
      await deleteMemory(env, {
        tenantId: row.tenant_id,
        memoryId: row.memory_id,
        actorType: "system",
        actorId: SYSTEM_ACTOR
      });
      memoryDeleted = true;
      deletionBudget -= 1;
      stats.deleted_count += 1;
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE retention_deletion_queue
         SET status = 'deleted', deleted_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`
      ).bind(now, now, row.id).run();
      try {
        await auditQueueAction(env, row, "retention.delete", "succeeded", { policy_id: row.policy_id });
      } catch (auditError) {
        await env.OPEN_BRAIN_DB.prepare(
          `UPDATE retention_deletion_queue
           SET status = 'manual_review', last_error = ?, updated_at = ? WHERE id = ?`
        ).bind(`memory deleted but audit event failed: ${message(auditError)}`, now, row.id).run();
        stats.manual_review_count += 1;
      }
    } catch (error) {
      if (memoryDeleted) {
        await env.OPEN_BRAIN_DB.prepare(
          `UPDATE retention_deletion_queue
           SET status = 'manual_review', deleted_at = COALESCE(deleted_at, ?),
               last_error = ?, updated_at = ? WHERE id = ?`
        ).bind(now, `memory deleted but queue finalization failed: ${message(error)}`, now, row.id).run();
        stats.manual_review_count += 1;
        continue;
      }
      const status = await markQueueFailure(env, row, error, now);
      await auditQueueAction(env, row, "retention.delete", "failed", { error: message(error) });
      if (status === "manual_review") stats.manual_review_count += 1;
      else stats.failed_count += 1;
    }
  }

  for (const candidate of candidates) {
    const status = await stageCandidate(env, candidate, now);
    if (status === "pending") stats.queued_count += 1;
    else if (status === "failed") stats.failed_count += 1;
    else if (status === "manual_review") stats.manual_review_count += 1;
  }
  await cleanupOperationalHistory(env, now);
  return stats;
}

export async function listRetentionQueue(
  env: Env,
  tenantId: string,
  options: { status?: RetentionQueueStatus; limit?: number } = {}
): Promise<RetentionQueueRow[]> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const columns = `id, tenant_id, memory_id, policy_id, original_lifecycle_state, original_version,
    suppressed_version, effective_at, detected_at, delete_after, status, attempt_count,
    last_error, deleted_at, cancelled_at, created_at, updated_at`;
  const result = options.status
    ? await env.OPEN_BRAIN_DB.prepare(
        `SELECT ${columns} FROM retention_deletion_queue
         WHERE tenant_id = ? AND status = ? ORDER BY detected_at DESC LIMIT ?`
      ).bind(tenantId, options.status, limit).all<RetentionQueueRow>()
    : await env.OPEN_BRAIN_DB.prepare(
        `SELECT ${columns} FROM retention_deletion_queue
         WHERE tenant_id = ? ORDER BY detected_at DESC LIMIT ?`
      ).bind(tenantId, limit).all<RetentionQueueRow>();
  return result.results;
}

export async function cancelRetentionQueue(
  env: Env,
  tenantId: string,
  ids: string[],
  now = Date.now()
): Promise<{ cancelled: string[]; manual_review: string[]; skipped: string[] }> {
  const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (normalized.length === 0 || normalized.length > 100) {
    throw new HttpError(400, "invalid_payload", "ids must contain between 1 and 100 queue ids");
  }
  const result = { cancelled: [] as string[], manual_review: [] as string[], skipped: [] as string[] };
  for (const id of normalized) {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, tenant_id, memory_id, policy_id, original_lifecycle_state, original_version,
              suppressed_version, effective_at, detected_at, delete_after, status, attempt_count,
              last_error, deleted_at, cancelled_at, created_at, updated_at
       FROM retention_deletion_queue WHERE tenant_id = ? AND id = ?`
    ).bind(tenantId, id).first<RetentionQueueRow>();
    if (!row || !["pending", "failed", "manual_review"].includes(row.status)) {
      result.skipped.push(id);
      continue;
    }
    const status = await cancelRow(env, row, now);
    if (status === "cancelled") result.cancelled.push(id);
    else result.manual_review.push(id);
  }
  return result;
}
