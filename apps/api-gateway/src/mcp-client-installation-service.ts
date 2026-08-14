import { HttpError, ulid } from "@org-brain/shared";
import type { Env } from "./types";

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const LAST_USED_WRITE_INTERVAL_MS = 15 * 60 * 1000;
const CLIENT_TYPES = new Set(["codex", "claude", "cursor"]);

export type McpClientType = "codex" | "claude" | "cursor";
export type McpClientInstallation = {
  id: string;
  tenant_id: string;
  owner_principal: string;
  client_type: McpClientType;
  device_label: string;
  purpose: "hook";
  status: "pending" | "active" | "revoked";
  created_at: number;
  activated_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  enrollment_expires_at: number | null;
};

type StoredInstallation = McpClientInstallation & {
  access_subject_hash: string | null;
  enrollment_token_hash: string | null;
};

function parseClientType(value: unknown): McpClientType {
  if (typeof value !== "string" || !CLIENT_TYPES.has(value)) {
    throw new HttpError(400, "invalid_payload", "client_type must be codex, claude, or cursor");
  }
  return value as McpClientType;
}

function parseDeviceLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_payload", "device_label must be a non-empty string");
  }
  const normalized = value.trim();
  const looksLikeHardwareIdentifier =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized) ||
    /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/iu.test(normalized) ||
    /^(?=[A-Z0-9]{10,20}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]+$/iu.test(normalized) ||
    /^(?:serial(?: number)?|s\/n|uuid|mac(?: address)?)\s*[:=]/iu.test(normalized);
  if (
    normalized.length > 80 ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    looksLikeHardwareIdentifier
  ) {
    throw new HttpError(
      400,
      "invalid_payload",
      "device_label must be a human-readable label, not a path, serial number, UUID, or MAC address"
    );
  }
  return normalized;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `obi_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")}`;
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicInstallation(row: StoredInstallation): McpClientInstallation {
  const { access_subject_hash: _accessSubjectHash, enrollment_token_hash: _enrollmentTokenHash, ...visible } = row;
  return visible;
}

export async function createMcpClientInstallation(
  env: Env,
  tenantId: string,
  ownerPrincipal: string,
  raw: unknown
): Promise<{ installation: McpClientInstallation; enrollment_code: string; enrollment_expires_at: number }> {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = raw as Record<string, unknown>;
  const clientType = parseClientType(body.client_type);
  const deviceLabel = parseDeviceLabel(body.device_label);
  const owner = await env.OPEN_BRAIN_DB.prepare(
    "SELECT status FROM user_profiles WHERE tenant_id=? AND principal=?"
  ).bind(tenantId, ownerPrincipal).first<{ status: string }>();
  if (owner?.status !== "active") {
    throw new HttpError(403, "forbidden", "Only an active Org Brain user can create a client installation");
  }
  const now = Date.now();
  const enrollmentCode = randomToken();
  const enrollmentHash = await sha256Text(enrollmentCode);
  const expiresAt = now + ENROLLMENT_TTL_MS;
  const id = ulid(now);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO mcp_client_installations(
      id, tenant_id, owner_principal, client_type, device_label, purpose, status,
      access_subject_hash, enrollment_token_hash, enrollment_expires_at,
      created_at, activated_at, last_used_at, revoked_at
    ) VALUES(?,?,?,?,?,'hook','pending',NULL,?,?,?,NULL,NULL,NULL)`
  ).bind(id, tenantId, ownerPrincipal, clientType, deviceLabel, enrollmentHash, expiresAt, now).run();
  return {
    installation: {
      id,
      tenant_id: tenantId,
      owner_principal: ownerPrincipal,
      client_type: clientType,
      device_label: deviceLabel,
      purpose: "hook",
      status: "pending",
      created_at: now,
      activated_at: null,
      last_used_at: null,
      revoked_at: null,
      enrollment_expires_at: expiresAt
    },
    enrollment_code: enrollmentCode,
    enrollment_expires_at: expiresAt
  };
}

export async function listMcpClientInstallations(
  env: Env,
  tenantId: string,
  ownerPrincipal?: string
): Promise<McpClientInstallation[]> {
  const query = ownerPrincipal
    ? `SELECT * FROM mcp_client_installations
       WHERE tenant_id=? AND owner_principal=?
       ORDER BY created_at DESC, id DESC`
    : `SELECT * FROM mcp_client_installations
       WHERE tenant_id=?
       ORDER BY created_at DESC, id DESC`;
  const statement = env.OPEN_BRAIN_DB.prepare(query);
  const rows = ownerPrincipal
    ? await statement.bind(tenantId, ownerPrincipal).all<StoredInstallation>()
    : await statement.bind(tenantId).all<StoredInstallation>();
  return rows.results.map(publicInstallation);
}

export async function revokeMcpClientInstallation(
  env: Env,
  tenantId: string,
  installationId: string,
  actorPrincipal: string,
  allowTenantAdmin: boolean
): Promise<McpClientInstallation> {
  const existing = await env.OPEN_BRAIN_DB.prepare(
    "SELECT * FROM mcp_client_installations WHERE tenant_id=? AND id=?"
  ).bind(tenantId, installationId).first<StoredInstallation>();
  if (!existing) throw new HttpError(404, "not_found", "MCP client installation not found");
  if (!allowTenantAdmin && existing.owner_principal !== actorPrincipal) {
    throw new HttpError(403, "forbidden", "Only the owner or a tenant admin can revoke this installation");
  }
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE mcp_client_installations
     SET status='revoked', revoked_at=?, enrollment_token_hash=NULL, enrollment_expires_at=NULL
     WHERE tenant_id=? AND id=?`
  ).bind(now, tenantId, installationId).run();
  return publicInstallation({
    ...existing,
    status: "revoked",
    revoked_at: now,
    enrollment_token_hash: null,
    enrollment_expires_at: null
  });
}

export async function activateMcpClientInstallation(
  env: Env,
  enrollmentCode: string,
  accessSubject: string,
  expectedClientType: McpClientType
): Promise<McpClientInstallation> {
  if (!enrollmentCode.startsWith("obi_")) {
    throw new HttpError(400, "invalid_payload", "Invalid enrollment code");
  }
  const now = Date.now();
  const enrollmentHash = await sha256Text(enrollmentCode);
  const accessSubjectHash = await sha256Text(accessSubject);
  const pending = await env.OPEN_BRAIN_DB.prepare(
    `SELECT * FROM mcp_client_installations
     WHERE enrollment_token_hash=? AND client_type=? AND status='pending' AND enrollment_expires_at>?`
  ).bind(enrollmentHash, expectedClientType, now).first<StoredInstallation>();
  if (!pending) throw new HttpError(401, "invalid_enrollment", "Enrollment code is invalid, expired, or already used");
  const duplicate = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM mcp_client_installations WHERE access_subject_hash=?"
  ).bind(accessSubjectHash).first<{ id: string }>();
  if (duplicate && duplicate.id !== pending.id) {
    throw new HttpError(409, "access_subject_in_use", "This Access service token is already enrolled");
  }
  let result;
  try {
    result = await env.OPEN_BRAIN_DB.prepare(
      `UPDATE mcp_client_installations
       SET status='active', access_subject_hash=?, enrollment_token_hash=NULL,
           enrollment_expires_at=NULL, activated_at=?, last_used_at=?
       WHERE id=? AND status='pending' AND enrollment_token_hash=? AND enrollment_expires_at>?`
    ).bind(accessSubjectHash, now, now, pending.id, enrollmentHash, now).run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/unique|idx_mcp_client_installations_access_subject/iu.test(detail)) {
      throw new HttpError(409, "access_subject_in_use", "This Access service token is already enrolled");
    }
    throw error;
  }
  if (!result.meta.changes) {
    throw new HttpError(409, "enrollment_race", "Enrollment code was consumed by another request");
  }
  return publicInstallation({
    ...pending,
    status: "active",
    access_subject_hash: accessSubjectHash,
    enrollment_token_hash: null,
    enrollment_expires_at: null,
    activated_at: now,
    last_used_at: now
  });
}

export async function resolveMcpClientInstallation(
  env: Env,
  accessSubject: string
): Promise<McpClientInstallation | null> {
  const accessSubjectHash = await sha256Text(accessSubject);
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT * FROM mcp_client_installations
     WHERE access_subject_hash=? AND status='active'`
  ).bind(accessSubjectHash).first<StoredInstallation>();
  return row ? publicInstallation(row) : null;
}

export async function touchMcpClientInstallation(
  env: Env,
  installationId: string,
  now = Date.now()
): Promise<void> {
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE mcp_client_installations
     SET last_used_at=?
     WHERE id=? AND status='active'
       AND (last_used_at IS NULL OR last_used_at<?)`
  ).bind(now, installationId, now - LAST_USED_WRITE_INTERVAL_MS).run();
}
