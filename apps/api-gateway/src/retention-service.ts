import { HttpError, ulid } from "@org-brain/shared";
import { deleteMemory } from "./memory-lifecycle-service";
import { removeMemoryIdsFromSemanticIndex } from "./retrieval-index-service";
import type { Env } from "./types";

export type RetentionPolicy = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  retention_days: number;
  legal_hold: number;
  updated_by_principal: string;
  created_at: number;
  updated_at: number;
};

function parseProjectId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_payload", "project_id must be a string or null");
  }
  return value.trim().slice(0, 128);
}

export async function listRetentionPolicies(env: Env, tenantId: string): Promise<RetentionPolicy[]> {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, retention_days, legal_hold,
            updated_by_principal, created_at, updated_at
     FROM retention_policies
     WHERE tenant_id = ?
     ORDER BY project_id`
  ).bind(tenantId).all<RetentionPolicy>();
  return rows.results;
}

export async function upsertRetentionPolicy(
  env: Env,
  tenantId: string,
  raw: unknown,
  principal: string
): Promise<RetentionPolicy> {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = raw as Record<string, unknown>;
  const projectId = parseProjectId(body.project_id);
  const retentionDays = body.retention_days;
  if (
    typeof retentionDays !== "number" ||
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3650
  ) {
    throw new HttpError(400, "invalid_payload", "retention_days must be an integer between 1 and 3650");
  }
  if (body.legal_hold !== undefined && typeof body.legal_hold !== "boolean") {
    throw new HttpError(400, "invalid_payload", "legal_hold must be a boolean");
  }
  const legalHold = body.legal_hold === true ? 1 : 0;
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, created_at FROM retention_policies
     WHERE tenant_id = ? AND COALESCE(project_id, '') = COALESCE(?, '')
     LIMIT 1`
  ).bind(tenantId, projectId).first<{ id: string; created_at: number }>();
  const now = Date.now();
  const record: RetentionPolicy = {
    id: existing?.id ?? ulid(),
    tenant_id: tenantId,
    project_id: projectId,
    retention_days: retentionDays,
    legal_hold: legalHold,
    updated_by_principal: principal,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  if (existing) {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE retention_policies
       SET retention_days = ?, legal_hold = ?, updated_by_principal = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(retentionDays, legalHold, principal, now, tenantId, record.id).run();
  } else {
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO retention_policies(
        id, tenant_id, project_id, retention_days, legal_hold,
        updated_by_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?)`
    ).bind(
      record.id,
      tenantId,
      projectId,
      retentionDays,
      legalHold,
      principal,
      now,
      now
    ).run();
  }
  return record;
}

export async function assertMemoryNotOnLegalHold(
  env: Env,
  tenantId: string,
  memoryId: string
): Promise<void> {
  const memory = await env.OPEN_BRAIN_DB.prepare(
    "SELECT project_id FROM memories WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, memoryId).first<{ project_id: string | null }>();
  if (!memory) return;
  const hold = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id FROM retention_policies
     WHERE tenant_id = ? AND legal_hold = 1
       AND (project_id IS NULL OR project_id = ?)
     LIMIT 1`
  ).bind(tenantId, memory.project_id).first<{ id: string }>();
  if (hold) {
    throw new HttpError(409, "legal_hold", "Memory cannot be deleted while a matching legal hold is active");
  }
}

export async function applyRetentionPolicies(
  env: Env,
  tenantId: string,
  raw: unknown,
  principal: string
) {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const execute = body.execute === true;
  const limit =
    typeof body.limit === "number" && Number.isInteger(body.limit)
      ? Math.max(1, Math.min(500, body.limit))
      : 100;
  const policies = await listRetentionPolicies(env, tenantId);
  const tenantPolicy = policies.find((policy) => policy.project_id === null);
  const projectPolicies = new Map(
    policies.filter((policy) => policy.project_id !== null).map((policy) => [policy.project_id, policy])
  );
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, project_id, COALESCE(updated_at, created_at) AS effective_at
     FROM memories
     WHERE tenant_id = ?
     ORDER BY effective_at
     LIMIT 5000`
  ).bind(tenantId).all<{ id: string; project_id: string | null; effective_at: number }>();
  const now = Date.now();
  const candidates = rows.results.filter((row) => {
    const policy = (row.project_id ? projectPolicies.get(row.project_id) : undefined) ?? tenantPolicy;
    if (!policy || tenantPolicy?.legal_hold === 1 || policy.legal_hold === 1) return false;
    return row.effective_at < now - policy.retention_days * 86_400_000;
  }).slice(0, limit);

  const deleted: string[] = [];
  if (execute) {
    for (const row of candidates) {
      const retrievalProjection = await removeMemoryIdsFromSemanticIndex(env, tenantId, [row.id]);
      if (retrievalProjection.error) {
        throw new HttpError(
          503,
          "retrieval_projection_failed",
          retrievalProjection.error
        );
      }
      await deleteMemory(env, {
        tenantId,
        memoryId: row.id,
        actorType: "principal",
        actorId: principal
      });
      deleted.push(row.id);
    }
  }
  return {
    tenant_id: tenantId,
    execute,
    candidate_count: candidates.length,
    candidate_ids: candidates.map((row) => row.id),
    deleted_count: deleted.length,
    deleted_ids: deleted,
    dry_run: !execute
  };
}
