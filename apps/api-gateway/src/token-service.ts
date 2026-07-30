import {
  HttpError,
  ORG_PERMISSIONS,
  sha256,
  ulid,
  type OrgPermission
} from "@org-brain/shared";
import type { Env } from "./types";

export type ScopedTokenRecord = {
  id: string;
  tenant_id: string;
  principal: string;
  scopes: OrgPermission[];
  project_id: string | null;
  expires_at: number;
  revoked_at: number | null;
  rotated_from_id: string | null;
  created_by_principal: string;
  created_at: number;
  last_used_at: number | null;
};

type ScopedTokenRow = Omit<ScopedTokenRecord, "scopes"> & {
  scopes_json: string;
};

function parseString(value: unknown, field: string, max = 128): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_payload", `${field} must be a non-empty string`);
  }
  return value.trim().slice(0, max);
}

function parseScopes(value: unknown): OrgPermission[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "invalid_payload", "scopes must be a non-empty array");
  }
  const scopes = [...new Set(value.filter((scope): scope is OrgPermission =>
    typeof scope === "string" && ORG_PERMISSIONS.includes(scope as OrgPermission)
  ))];
  if (scopes.length !== value.length) {
    throw new HttpError(400, "invalid_payload", `scopes must contain only ${ORG_PERMISSIONS.join(", ")}`);
  }
  return scopes;
}

function parseRow(row: ScopedTokenRow): ScopedTokenRecord {
  let scopes: OrgPermission[] = [];
  try {
    scopes = parseScopes(JSON.parse(row.scopes_json));
  } catch {
    scopes = [];
  }
  return { ...row, scopes };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = Array.from(bytes, (value) => String.fromCharCode(value)).join("");
  return `obp_${btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

export async function issueScopedToken(
  env: Env,
  tenantId: string,
  raw: unknown,
  createdByPrincipal: string
) {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = raw as Record<string, unknown>;
  const principal = parseString(body.principal, "principal");
  const scopes = parseScopes(body.scopes);
  const projectId =
    body.project_id === undefined || body.project_id === null
      ? null
      : parseString(body.project_id, "project_id");
  const expiresInSeconds =
    typeof body.expires_in_seconds === "number" && Number.isInteger(body.expires_in_seconds)
      ? body.expires_in_seconds
      : 86_400;
  if (expiresInSeconds < 300 || expiresInSeconds > 7_776_000) {
    throw new HttpError(400, "invalid_payload", "expires_in_seconds must be between 300 and 7776000");
  }
  const rotatedFromId =
    body.rotated_from_id === undefined || body.rotated_from_id === null
      ? null
      : parseString(body.rotated_from_id, "rotated_from_id");
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = Date.now();
  const record: ScopedTokenRecord = {
    id: ulid(),
    tenant_id: tenantId,
    principal,
    scopes,
    project_id: projectId,
    expires_at: now + expiresInSeconds * 1000,
    revoked_at: null,
    rotated_from_id: rotatedFromId,
    created_by_principal: createdByPrincipal,
    created_at: now,
    last_used_at: null
  };
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO scoped_tokens(
      id, tenant_id, principal, token_hash, scopes_json, project_id, expires_at,
      revoked_at, rotated_from_id, created_by_principal, created_at, last_used_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    record.id,
    record.tenant_id,
    record.principal,
    tokenHash,
    JSON.stringify(scopes),
    record.project_id,
    record.expires_at,
    null,
    record.rotated_from_id,
    record.created_by_principal,
    record.created_at,
    null
  ).run();
  if (rotatedFromId) {
    await env.OPEN_BRAIN_DB.prepare(
      "UPDATE scoped_tokens SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL"
    ).bind(now, tenantId, rotatedFromId).run();
  }
  return { token, record };
}

export async function authenticateScopedToken(
  env: Env,
  token: string
): Promise<ScopedTokenRecord | null> {
  if (!token.startsWith("obp_")) return null;
  const tokenHash = await sha256(token);
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, principal, scopes_json, project_id, expires_at, revoked_at,
            rotated_from_id, created_by_principal, created_at, last_used_at
     FROM scoped_tokens
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
     LIMIT 1`
  ).bind(tokenHash, Date.now()).first<ScopedTokenRow>();
  if (!row) return null;
  const record = parseRow(row);
  if (record.scopes.length === 0) return null;
  await env.OPEN_BRAIN_DB.prepare(
    "UPDATE scoped_tokens SET last_used_at = ? WHERE id = ?"
  ).bind(Date.now(), record.id).run();
  return record;
}

export async function listScopedTokens(env: Env, tenantId: string): Promise<ScopedTokenRecord[]> {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, principal, scopes_json, project_id, expires_at, revoked_at,
            rotated_from_id, created_by_principal, created_at, last_used_at
     FROM scoped_tokens
     WHERE tenant_id = ?
     ORDER BY created_at DESC`
  ).bind(tenantId).all<ScopedTokenRow>();
  return rows.results.map(parseRow);
}

export async function revokeScopedToken(
  env: Env,
  tenantId: string,
  id: string
): Promise<{ id: string; revoked: boolean; revoked_at: number }> {
  const revokedAt = Date.now();
  const result = await env.OPEN_BRAIN_DB.prepare(
    "UPDATE scoped_tokens SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL"
  ).bind(revokedAt, tenantId, id).run();
  return { id, revoked: Boolean(result.meta.changes), revoked_at: revokedAt };
}
