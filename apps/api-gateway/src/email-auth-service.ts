import { HttpError, isOrgRole, sha256, ulid, type OrgRole } from "@org-brain/shared";
import type { ApiAuthContext } from "./auth";
import {
  findOrganizationBySlug,
  getUserByEmail,
  getUserByPrincipal,
  normalizeEmail,
  privateUser
} from "./organization-user-service";
import type { Env } from "./types";

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS_PER_HOUR = 5;

type ChallengeRow = {
  id: string;
  tenant_id: string;
  email: string;
  code_hash: string;
  attempt_count: number;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
};

type SessionRow = {
  id: string;
  tenant_id: string;
  principal: string;
  csrf_hash: string;
  expires_at: number;
  auth_source: "email" | "oidc";
};

export type EmailDelivery = { email: string; code: string; organization: string; expiresAt: number };
export interface EmailSender { send(input: EmailDelivery): Promise<void>; }

function objectBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  return raw as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, max = 254): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_payload", `${field} must be a non-empty string`);
  }
  return value.trim().slice(0, max);
}

function randomUrlToken(bytes = 32): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(value % 1_000_000).padStart(6, "0");
}

async function codeHash(env: Env, tenantId: string, email: string, code: string) {
  const pepper = env.EMAIL_AUTH_PEPPER?.trim();
  if (!pepper) throw new HttpError(500, "misconfigured", "EMAIL_AUTH_PEPPER is required");
  return sha256(`${pepper}\0${tenantId}\0${email}\0${code}`);
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, "0")).join("");
}

export class HmacWebhookEmailSender implements EmailSender {
  constructor(private readonly env: Env) {}
  async send(input: EmailDelivery) {
  const url = this.env.EMAIL_WEBHOOK_URL?.trim();
  const secret = this.env.EMAIL_WEBHOOK_SECRET?.trim();
  if (!url || !secret) throw new HttpError(503, "email_delivery_unavailable", "email delivery is not configured");
  if (!url.startsWith("https://")) throw new HttpError(500, "misconfigured", "EMAIL_WEBHOOK_URL must use https");
  const payload = JSON.stringify({
    to: input.email,
    template: "orgbrain-login-code",
    locale: "ja",
    code: input.code,
    organization: input.organization,
    expires_at: input.expiresAt
  });
  const timestamp = String(Date.now());
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orgbrain-timestamp": timestamp,
      "x-orgbrain-signature": await hmacHex(secret, `${timestamp}.${payload}`)
    },
    body: payload
  });
  if (!response.ok) throw new HttpError(503, "email_delivery_failed", "email delivery failed");
  }
}

export class InMemoryEmailSender implements EmailSender {
  readonly deliveries: EmailDelivery[] = [];
  async send(input: EmailDelivery) { this.deliveries.push(input); }
}

function emailAllowed(organization: { allowed_email_domains: string[]; email_self_registration_enabled: boolean }, email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  return Boolean(organization.email_self_registration_enabled && domain && organization.allowed_email_domains.includes(domain));
}

export async function requestEmailCode(env: Env, raw: unknown, requestIp: string | null, sender: EmailSender = new HmacWebhookEmailSender(env)) {
  if (env.EMAIL_AUTH_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Email authentication is disabled");
  const body = objectBody(raw);
  const slug = requiredString(body.organization_slug, "organization_slug", 80).toLowerCase();
  const email = normalizeEmail(body.email);
  const organization = await findOrganizationBySlug(env, slug);
  if (!organization) return { accepted: true };
  const existing = await getUserByEmail(env, organization.tenant_id, email);
  if ((!existing && !emailAllowed(organization, email)) || existing?.status === "suspended" || existing?.status === "deprovisioned") {
    return { accepted: true };
  }
  const now = Date.now();
  const ipHash = requestIp ? await sha256(`${env.EMAIL_AUTH_PEPPER}\0${requestIp}`) : null;
  const recent = await env.OPEN_BRAIN_DB.prepare(
    `SELECT COUNT(*) AS count, MAX(created_at) AS latest
     FROM email_auth_challenges WHERE tenant_id = ? AND (email = ? OR (? IS NOT NULL AND request_ip_hash = ?)) AND created_at > ?`
  ).bind(organization.tenant_id, email, ipHash, ipHash, now - 60 * 60 * 1000).first<{ count: number; latest: number | null }>();
  if (Number(recent?.count ?? 0) >= MAX_REQUESTS_PER_HOUR || (recent?.latest && now - recent.latest < RESEND_MS)) {
    return { accepted: true };
  }
  const code = randomCode();
  const expiresAt = now + CODE_TTL_MS;
  const id = ulid(now);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO email_auth_challenges(id, tenant_id, email, code_hash, request_ip_hash,
      attempt_count, expires_at, consumed_at, created_at) VALUES(?,?,?,?,?,0,?,NULL,?)`
  ).bind(id, organization.tenant_id, email, await codeHash(env, organization.tenant_id, email, code), ipHash, expiresAt, now).run();
  try {
    await sender.send({ email, code, organization: organization.display_name, expiresAt });
  } catch {
    await env.OPEN_BRAIN_DB.prepare(
      "UPDATE email_auth_challenges SET consumed_at = ? WHERE id = ?"
    ).bind(Date.now(), id).run();
  }
  return { accepted: true };
}

async function ensureEmailUser(env: Env, tenantId: string, email: string) {
  const existing = await getUserByEmail(env, tenantId, email);
  if (existing) {
    if (existing.status === "suspended" || existing.status === "deprovisioned") {
      throw new HttpError(401, "unauthorized", "Login could not be completed");
    }
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE user_profiles SET email_verified=1, status='active', updated_at=?
       WHERE tenant_id=? AND principal=?`
    ).bind(Date.now(), tenantId, existing.principal).run();
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO user_identities(id, tenant_id, principal, provider_type, issuer, subject,
        external_id, created_at, updated_at) VALUES(?,?,?,'email','',?,NULL,?,?)
       ON CONFLICT(tenant_id, principal, provider_type, issuer)
       DO UPDATE SET subject=excluded.subject, updated_at=excluded.updated_at`
    ).bind(ulid(Date.now()), tenantId, existing.principal, email, Date.now(), Date.now()).run();
    return (await getUserByPrincipal(env, tenantId, existing.principal))!;
  }
  const now = Date.now();
  const principal = `user:${ulid(now).toLowerCase()}`;
  const displayName = email.split("@")[0].slice(0, 120);
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO user_profiles(tenant_id, principal, display_name, full_name, email,
        email_verified, company_name, organization_name, avatar_url, status,
        provision_source, full_name_source, created_at, updated_at)
       VALUES(?,?,?,NULL,?,1,NULL,NULL,NULL,'active','email','email',?,?)`
    ).bind(tenantId, principal, displayName, email, now, now),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO user_identities(id, tenant_id, principal, provider_type, issuer,
        subject, external_id, created_at, updated_at) VALUES(?,?,?,'email','',?,NULL,?,?)`
    ).bind(ulid(now + 1), tenantId, principal, email, now, now),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO principal_role_assignments(id, tenant_id, project_id, principal, role,
        created_by_principal, created_at, updated_at, source, source_ref)
       VALUES(?,?,NULL,?,'reader',?,?,?,'local','email-self-registration')`
    ).bind(ulid(now + 2), tenantId, principal, principal, now, now)
  ]);
  return (await getUserByPrincipal(env, tenantId, principal))!;
}

export async function verifyEmailCode(env: Env, raw: unknown) {
  if (env.EMAIL_AUTH_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Email authentication is disabled");
  const body = objectBody(raw);
  const slug = requiredString(body.organization_slug, "organization_slug", 80).toLowerCase();
  const email = normalizeEmail(body.email);
  const code = requiredString(body.code, "code", 6);
  if (!/^\d{6}$/u.test(code)) throw new HttpError(401, "unauthorized", "Login could not be completed");
  const organization = await findOrganizationBySlug(env, slug);
  if (!organization) throw new HttpError(401, "unauthorized", "Login could not be completed");
  const challenge = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, email, code_hash, attempt_count, expires_at, consumed_at, created_at
     FROM email_auth_challenges
     WHERE tenant_id=? AND email=? ORDER BY created_at DESC LIMIT 1`
  ).bind(organization.tenant_id, email).first<ChallengeRow>();
  const now = Date.now();
  const valid = challenge && !challenge.consumed_at && challenge.expires_at > now &&
    challenge.attempt_count < MAX_ATTEMPTS &&
    challenge.code_hash === await codeHash(env, organization.tenant_id, email, code);
  if (!valid) {
    if (challenge && !challenge.consumed_at) {
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE email_auth_challenges SET attempt_count=attempt_count+1,
          consumed_at=CASE WHEN attempt_count+1>=? THEN ? ELSE consumed_at END WHERE id=?`
      ).bind(MAX_ATTEMPTS, now, challenge.id).run();
    }
    throw new HttpError(401, "unauthorized", "Login could not be completed");
  }
  const consumed = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE email_auth_challenges SET consumed_at=?
     WHERE id=? AND consumed_at IS NULL AND expires_at>? AND attempt_count<?`
  ).bind(now, challenge.id, now, MAX_ATTEMPTS).run();
  if (Number(consumed.meta?.changes ?? 0) !== 1) {
    throw new HttpError(401, "unauthorized", "Login could not be completed");
  }
  const user = await ensureEmailUser(env, organization.tenant_id, email);
  const sessionToken = randomUrlToken();
  const csrfToken = randomUrlToken(24);
  const sessionId = ulid(now);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO auth_sessions(id, tenant_id, principal, token_hash, auth_source,
      csrf_hash, expires_at, revoked_at, created_at, last_seen_at)
     VALUES(?,?,?,?, 'email', ?, ?, NULL, ?, ?)`
  ).bind(sessionId, organization.tenant_id, user.principal, await sha256(sessionToken), await sha256(csrfToken), now + SESSION_TTL_MS, now, now).run();
  return {
    session_token: sessionToken,
    csrf_token: csrfToken,
    expires_at: now + SESSION_TTL_MS,
    user: privateUser(user)
  };
}

export async function authenticateSession(env: Env, token: string): Promise<ApiAuthContext | null> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, principal, csrf_hash, expires_at, auth_source
     FROM auth_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? LIMIT 1`
  ).bind(await sha256(token), Date.now()).first<SessionRow>();
  if (!row) return null;
  const user = await getUserByPrincipal(env, row.tenant_id, row.principal);
  if (!user || user.status !== "active") return null;
  const roles = await env.OPEN_BRAIN_DB.prepare(
    `SELECT role FROM principal_role_assignments
     WHERE tenant_id=? AND principal=? AND project_id IS NULL ORDER BY updated_at DESC`
  ).bind(row.tenant_id, row.principal).all<{ role: string }>();
  const defaultRole: OrgRole = roles.results.map((item) => item.role).find(isOrgRole) ?? "reader";
  await env.OPEN_BRAIN_DB.prepare("UPDATE auth_sessions SET last_seen_at=? WHERE id=?")
    .bind(Date.now(), row.id).run();
  return {
    principal: row.principal,
    allowedTenants: [row.tenant_id],
    source: "session",
    email: user.email,
    displayName: user.display_name,
    defaultRole,
    sessionId: row.id,
    csrfHash: row.csrf_hash
  };
}

export async function assertSessionCsrf(auth: ApiAuthContext, token: string | undefined) {
  if (auth.source !== "session") return;
  if (!token || !auth.csrfHash || await sha256(token) !== auth.csrfHash) {
    throw new HttpError(403, "csrf_failed", "A valid CSRF token is required");
  }
}

export async function logoutSession(env: Env, auth: ApiAuthContext) {
  if (auth.sessionId) {
    await env.OPEN_BRAIN_DB.prepare("UPDATE auth_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .bind(Date.now(), auth.sessionId).run();
  }
  return { logged_out: true };
}

export async function revokeAllSessions(env: Env, tenantId: string) {
  const result = await env.OPEN_BRAIN_DB.prepare(
    "UPDATE auth_sessions SET revoked_at=? WHERE tenant_id=? AND revoked_at IS NULL"
  ).bind(Date.now(), tenantId).run();
  return { tenant_id: tenantId, revoked_sessions: Number(result.meta?.changes ?? 0) };
}

export const SESSION_COOKIE = "__Host-orgbrain_session";
export const SESSION_COOKIE_MAX_AGE = Math.floor(SESSION_TTL_MS / 1000);
