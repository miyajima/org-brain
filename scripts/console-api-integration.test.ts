import { domainCapabilities } from "../apps/api-gateway/src/domain-routes";
import { createRequire } from "node:module";
const { Hono } = createRequire(new URL("../apps/api-gateway/package.json", import.meta.url))("hono");
import { apiKeyAuth, getApiAuthContext } from "../apps/api-gateway/src/auth";
import { ALL as consoleProxy } from "../apps/console/src/pages/api/[...path]";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "../packages/shared/src/index";
import { createImprovementAction, listImprovementActions, updateImprovementAction, createRetrospective } from "../apps/api-gateway/src/knowledge-measurement-service";
import gateway from "../apps/api-gateway/src/index";
import { createServerApi } from "../apps/console/src/lib/server-api";
import type { Env } from "../apps/api-gateway/src/types";
const runtime = (globalThis as unknown as { process: { getBuiltinModule(name: string): any } }).process;
const { DatabaseSync } = runtime.getBuiltinModule('node:sqlite');
const { readFileSync, readdirSync } = runtime.getBuiltinModule('node:fs');

function fixture() {
  const sql = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name: string) => name.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(file, directory), 'utf8'));
  const database = { prepare(query: string) {
    let args: any[] = [];
    return { bind(...values: any[]) { args = values; return this; },
      async first() { return sql.prepare(query).get(...args) ?? null; },
      async all() { return { results: sql.prepare(query).all(...args) }; },
      async run() { const result = sql.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; }
    };
  }, async batch(statements: any[]) { sql.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  return { sql, env: { OPEN_BRAIN_DB: database } as unknown as Env };
}



describe("Console SSR against the real gateway and migrated database", () => {
  it("preserves a session, enforces CSRF/Origin and closes a retrospective exactly once", async () => {
    const { sql, env } = fixture();
    Object.assign(env, { API_RATE_LIMIT_FAIL_OPEN: "true", SESSION_ALLOWED_ORIGIN: "https://console.test", RETROSPECTIVE_MODE: "on" });
    sql.exec(`INSERT INTO user_profiles(tenant_id,principal,display_name,created_at,updated_at) VALUES('default','alice','Alice',1,1);
      INSERT INTO principal_role_assignments(id,tenant_id,principal,role,created_by_principal,created_at,updated_at) VALUES('admin','default','alice','tenant_admin','alice',1,1);
      INSERT INTO decision_memories(id,tenant_id,title,decision,rationale,created_at,updated_at) VALUES('decision','default','Choice','Use tested contracts','Compatibility',1,1);`);
    sql.prepare(`INSERT INTO auth_sessions(id,tenant_id,principal,token_hash,auth_source,csrf_hash,expires_at,created_at,last_seen_at) VALUES('s','default','alice',?,'email',?,?,1,1)`).run(await sha256("session"), await sha256("csrf"), Date.now()+60000);
    const created = await createRetrospective(env, "default", "alice", { title: "Test" });
    const retrospectiveId = (created as any).id;
    const items = sql.prepare("SELECT id FROM retrospective_items WHERE session_id=?").all(retrospectiveId);
    const pending: Promise<unknown>[] = [];
    const context = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input)); url.pathname = url.pathname.replace(/^\/api/, "");
      return gateway.fetch(new Request(url, init), env, context);
    };
    const cookie = "__Host-orgbrain_session=session";
    const api = createServerApi(new Request("https://console.test/retrospectives/retro/admin", { method: "POST", headers: { cookie, origin: "https://console.test" } }), transport);
    try {
      const identity = await api("/api/v1/auth/me?tenant_id=default");
      expect(identity.status).toBe(200);
      const path = `/api/v1/retrospectives/${retrospectiveId}/close`;
      const body = JSON.stringify({ tenant_id: "default", items: items.map((item: any) => ({ item_id: item.id, decision: "deferred" })), acknowledge_unanswered: true });
      const init = { method: "POST", body, headers: { "content-type": "application/json", "x-csrf-token": "csrf", "x-idempotency-key": "close-1" } };
      const noCsrf = await api(path, { ...init, headers: { ...init.headers, "x-csrf-token": "wrong" } });
      expect(noCsrf.status).toBe(403);
      const wrongOrigin = await transport(new URL(path, "https://console.test"), { ...init, headers: { ...init.headers, cookie, origin: "https://evil.test" } });
      expect(wrongOrigin.status).toBe(403);
      const wrongKey = await api(path, { ...init, headers: { "content-type": "application/json", "x-csrf-token": "csrf", "idempotency-key": "close-1" } });
      expect(wrongKey.status).toBe(400);
      const first = await api(path, init);
      expect(await first.clone().text()).not.toContain('"ok":false');
      expect(first.status).toBe(200);
      const second = await api(path, init);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(await first.json());
      expect(sql.prepare("SELECT status FROM retrospective_sessions WHERE id=?").get(retrospectiveId).status).toBe("closed");
      const external = createServerApi(new Request("https://console.test/retrospectives", { method: "POST", headers: { cookie, origin: "https://evil.test" } }), transport);
      expect((await external(path, init)).status).toBe(403);
      const read = createServerApi(new Request("https://console.test/memories", { headers: { cookie } }), transport);
      expect((await read("/api/v1/memories/profile", { method: "POST", body: JSON.stringify({ tenant_id: "default" }), headers: { "content-type": "application/json" } })).status).toBe(200);
      expect((await read("/api/v1/decision-memories/search", { method: "POST", body: JSON.stringify({ tenant_id: "default" }), headers: { "content-type": "application/json" } })).status).toBe(200);
    } finally { await Promise.allSettled(pending); sql.close(); }
  });
});

function base64UrlEncode(input: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signedAccessJwt(claims: Record<string, unknown>) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const kid = "test-access-key";
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return {
    token: `${header}.${payload}.${base64UrlEncode(signature)}`,
    jwks: JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] })
  };
}


it("preserves signed Access identity through SSR and the real Console proxy, failing closed for invalid JWT", async () => {
  const { token, jwks } = await signedAccessJwt({ sub: "alice", email: "alice@example.test", aud: "console-test", iss: "https://team.cloudflareaccess.com", exp: Math.floor(Date.now()/1000)+600 });
  const app = new Hono(); app.use("*", apiKeyAuth);
  app.get("/v1/principal", (c) => c.json(getApiAuthContext(c)));
  const env = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "console-test", ACCESS_JWKS_JSON: jwks,
    ACCESS_TENANT_POLICY_JSON: JSON.stringify({ default_tenants: ["default"] }), API_KEY: "service-key" } as Env;
  for (const [key, value] of Object.entries({ ...env, ACCESS_JWT_REQUIRED: "false", API_BASE_URL: "https://gateway.test", INTERNAL_API_KEY: "service-key" })) vi.stubEnv(key, String(value));
  const transport = vi.fn(async (url: string, init: RequestInit) => app.fetch(new Request(url, init), env));
  vi.stubGlobal("fetch", transport);
  try {
    for (const jwt of [token, `${token.slice(0, -8)}invalid!`]) {
      const incoming = new Request("https://console.test/page", { headers: { "cf-access-jwt-assertion": jwt } });
      const api = createServerApi(incoming, (async (input: RequestInfo | URL, init?: RequestInit) => consoleProxy({ request: new Request(String(input), init), params: { path: "v1/principal" } } as any)) as typeof fetch);
      const response = await api("/api/v1/principal");
      expect(response.status).toBe(jwt === token ? 200 : 401);
      if (jwt === token) expect(await response.json()).toMatchObject({ principal: "user:alice", source: "access-jwt" });
    }
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1].redirect).toBe("manual");
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

it("separates feature availability from administrative and owner actions", async () => {
  const { sql, env } = fixture();
  env.IMPROVEMENT_ACTIONS_MODE = "on";
  try {
    expect(domainCapabilities(env, "default", false).improvement_actions).toMatchObject({ enabled: true, writable: true, allowed_actions: [] });
    expect(domainCapabilities(env, "default", true).improvement_actions).toMatchObject({ allowed_actions: ["create", "update", "manage"] });
    const action = await createImprovementAction(env, "default", "admin", { title: "Fix regression", owner_principal: "owner" });
    const owner = (await listImprovementActions(env, "default", { principal: "owner" }))[0];
    expect(owner.allowed_actions).toEqual(["in_progress"]);
    expect(await listImprovementActions(env, "default", { principal: "reader" })).toEqual([]);
    await expect(updateImprovementAction(env, "default", action.id, "owner", false, { status: "cancelled" })).rejects.toMatchObject({ status: 403 });
    await updateImprovementAction(env, "default", action.id, "owner", false, { status: "in_progress" });
    expect((await listImprovementActions(env, "default", { principal: "owner" }))[0].allowed_actions).toEqual(["awaiting_verification"]);
    expect((await listImprovementActions(env, "default", { principal: "admin", includeAll: true }))[0].allowed_actions).toEqual(["awaiting_verification", "completed", "cancelled"]);
    env.IMPROVEMENT_ACTIONS_MODE = "preview";
    expect((await listImprovementActions(env, "default", { principal: "owner" }))[0].allowed_actions).toEqual([]);
    expect(domainCapabilities(env, "default", true).improvement_actions).toMatchObject({ enabled: true, writable: false, allowed_actions: [] });
  } finally { sql.close(); }
});
