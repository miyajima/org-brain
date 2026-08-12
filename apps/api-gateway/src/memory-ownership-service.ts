import { HttpError } from "@org-brain/shared";
import type { Env } from "./types";

type MappingRow = {
  tenant_id: string;
  producer_principal: string;
  owner_principal: string;
  created_by_principal: string;
  created_at: number;
  updated_at: number;
};

function objectBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  return raw as Record<string, unknown>;
}

function requiredPrincipal(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_payload", `${field} must be a non-empty principal`);
  }
  return value.trim().slice(0, 128);
}

export async function listPrincipalOwnerMappings(env: Env, tenantId: string): Promise<MappingRow[]> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, producer_principal, owner_principal,
            created_by_principal, created_at, updated_at
     FROM principal_owner_mappings
     WHERE tenant_id = ?
     ORDER BY producer_principal`
  ).bind(tenantId).all<MappingRow>();
  return result.results;
}

export async function getPrincipalOwnerMapping(
  env: Env,
  tenantId: string,
  producerPrincipal: string
): Promise<MappingRow | null> {
  const producer = requiredPrincipal(producerPrincipal, "producer_principal");
  return env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, producer_principal, owner_principal,
            created_by_principal, created_at, updated_at
     FROM principal_owner_mappings
     WHERE tenant_id = ? AND producer_principal = ?`
  ).bind(tenantId, producer).first<MappingRow>();
}

export async function upsertPrincipalOwnerMapping(
  env: Env,
  tenantId: string,
  raw: unknown,
  actorPrincipal: string
): Promise<MappingRow> {
  const body = objectBody(raw);
  const producerPrincipal = requiredPrincipal(body.producer_principal, "producer_principal");
  const ownerPrincipal = requiredPrincipal(body.owner_principal, "owner_principal");
  return upsertMapping(env, tenantId, producerPrincipal, ownerPrincipal, actorPrincipal);
}

export async function upsertOwnPrincipalOwnerMapping(
  env: Env,
  tenantId: string,
  raw: unknown,
  producerPrincipal: string
): Promise<MappingRow> {
  const producer = requiredPrincipal(producerPrincipal, "producer_principal");
  const body = objectBody(raw);
  const owner = requiredPrincipal(body.owner_principal ?? producer, "owner_principal");
  return upsertMapping(env, tenantId, producer, owner, producer);
}

async function upsertMapping(
  env: Env,
  tenantId: string,
  producerPrincipal: string,
  ownerPrincipal: string,
  actorPrincipal: string
): Promise<MappingRow> {
  const now = Date.now();
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT created_at FROM principal_owner_mappings
     WHERE tenant_id = ? AND producer_principal = ?`
  ).bind(tenantId, producerPrincipal).first<{ created_at: number }>();
  const createdAt = Number(existing?.created_at ?? now);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO principal_owner_mappings(
       tenant_id, producer_principal, owner_principal,
       created_by_principal, created_at, updated_at
     ) VALUES(?,?,?,?,?,?)
     ON CONFLICT(tenant_id, producer_principal) DO UPDATE SET
       owner_principal = excluded.owner_principal,
       created_by_principal = excluded.created_by_principal,
       updated_at = excluded.updated_at`
  ).bind(tenantId, producerPrincipal, ownerPrincipal, actorPrincipal, createdAt, now).run();
  return {
    tenant_id: tenantId,
    producer_principal: producerPrincipal,
    owner_principal: ownerPrincipal,
    created_by_principal: actorPrincipal,
    created_at: createdAt,
    updated_at: now
  };
}

export async function assignUnownedMemories(
  env: Env,
  tenantId: string,
  ownerPrincipal: string,
  actorPrincipal: string
): Promise<{ updated_count: number; owner_principal: string }> {
  const owner = requiredPrincipal(ownerPrincipal, "owner_principal");
  const result = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE memories
     SET owner_principal = ?, updated_at = ?
     WHERE tenant_id = ? AND owner_principal IS NULL AND deleted_at IS NULL`
  ).bind(owner, Date.now(), tenantId).run();
  void actorPrincipal;
  return { updated_count: Number(result.meta.changes ?? 0), owner_principal: owner };
}
