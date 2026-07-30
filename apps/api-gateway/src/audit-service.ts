import { HttpError, sha256, ulid } from "@org-brain/shared";
import type { Env } from "./types";

export type AuditEvent = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  principal: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: "succeeded" | "denied" | "failed";
  request_id: string | null;
  metadata: Record<string, unknown>;
  previous_hash: string;
  entry_hash: string;
  created_at: number;
};

function stableMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item) || item === null)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function hashPayload(event: Omit<AuditEvent, "entry_hash" | "metadata"> & { metadata_json: string }): string {
  return JSON.stringify([
    event.id,
    event.tenant_id,
    event.project_id,
    event.principal,
    event.action,
    event.resource_type,
    event.resource_id,
    event.outcome,
    event.request_id,
    event.metadata_json,
    event.previous_hash,
    event.created_at
  ]);
}

export async function appendAuditEvent(
  env: Env,
  input: {
    tenantId: string;
    projectId?: string | null;
    principal: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    outcome: "succeeded" | "denied" | "failed";
    requestId?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<AuditEvent> {
  const previous = await env.OPEN_BRAIN_DB.prepare(
    `SELECT entry_hash, created_at
     FROM audit_events
     WHERE tenant_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  ).bind(input.tenantId).first<{ entry_hash: string; created_at: number }>();
  const metadata = stableMetadata(input.metadata);
  const metadataJson = JSON.stringify(metadata);
  const partial = {
    id: ulid(),
    tenant_id: input.tenantId,
    project_id: input.projectId?.trim() || null,
    principal: input.principal,
    action: input.action.slice(0, 128),
    resource_type: input.resourceType.slice(0, 64),
    resource_id: input.resourceId?.slice(0, 256) || null,
    outcome: input.outcome,
    request_id: input.requestId?.slice(0, 128) || null,
    metadata_json: metadataJson,
    previous_hash: previous?.entry_hash ?? "GENESIS",
    created_at: Math.max(Date.now(), Number(previous?.created_at ?? 0) + 1)
  } as const;
  const entryHash = await sha256(hashPayload(partial));
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO audit_events(
      id, tenant_id, project_id, principal, action, resource_type, resource_id, outcome,
      request_id, metadata_json, previous_hash, entry_hash, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    partial.id,
    partial.tenant_id,
    partial.project_id,
    partial.principal,
    partial.action,
    partial.resource_type,
    partial.resource_id,
    partial.outcome,
    partial.request_id,
    partial.metadata_json,
    partial.previous_hash,
    entryHash,
    partial.created_at
  ).run();
  return {
    ...partial,
    metadata,
    entry_hash: entryHash
  };
}

export async function listAuditEvents(
  env: Env,
  tenantId: string,
  limit = 100
): Promise<AuditEvent[]> {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, principal, action, resource_type, resource_id, outcome,
            request_id, metadata_json, previous_hash, entry_hash, created_at
     FROM audit_events
     WHERE tenant_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`
  ).bind(tenantId, Math.max(1, Math.min(500, limit))).all<Omit<AuditEvent, "metadata"> & { metadata_json: string }>();
  return rows.results.map(({ metadata_json, ...row }) => ({
    ...row,
    metadata: JSON.parse(metadata_json) as Record<string, unknown>
  }));
}

export async function verifyAuditChain(
  env: Env,
  tenantId: string
): Promise<{ ok: boolean; checked: number; errors: string[] }> {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, principal, action, resource_type, resource_id, outcome,
            request_id, metadata_json, previous_hash, entry_hash, created_at
     FROM audit_events
     WHERE tenant_id = ?
     ORDER BY created_at ASC, id ASC`
  ).bind(tenantId).all<Omit<AuditEvent, "metadata"> & { metadata_json: string }>();
  const errors: string[] = [];
  let expectedPrevious = "GENESIS";
  for (const row of rows.results) {
    if (row.previous_hash !== expectedPrevious) errors.push(`broken previous hash at ${row.id}`);
    const expectedHash = await sha256(hashPayload(row));
    if (row.entry_hash !== expectedHash) errors.push(`entry hash mismatch at ${row.id}`);
    expectedPrevious = row.entry_hash;
  }
  return { ok: errors.length === 0, checked: rows.results.length, errors };
}

export function parseAuditLimit(value: string | undefined): number {
  if (!value) return 100;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new HttpError(400, "invalid_payload", "limit must be between 1 and 500");
  }
  return parsed;
}
