import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { apiKeyAuth, assertApiTenantAccess } from "../src/auth";
import type { Env } from "../src/types";

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", apiKeyAuth);
  app.get("/tenant", (c) => c.json({ tenant: assertApiTenantAccess(c, c.req.query("tenant_id")) }));
  app.onError((error, c) => {
    const maybeStatus = (error as unknown as { status?: unknown }).status;
    const status = typeof maybeStatus === "number" ? maybeStatus : 500;
    return c.json({ error: error instanceof Error ? error.message : String(error) }, status as 500);
  });
  return app;
}

describe("api tenant auth", () => {
  it("allows default tenant without an explicit policy", async () => {
    const app = buildApp();
    const response = await app.fetch(
      new Request("https://example.test/tenant?tenant_id=default", { headers: { "x-api-key": "secret" } }),
      { API_KEY: "secret" } as Env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenant: "default" });
  });

  it("rejects non-default tenant without an explicit policy", async () => {
    const app = buildApp();
    const response = await app.fetch(
      new Request("https://example.test/tenant?tenant_id=team-a", { headers: { "x-api-key": "secret" } }),
      { API_KEY: "secret" } as Env
    );

    expect(response.status).toBe(403);
  });

  it("allows configured API keys only for granted tenants", async () => {
    const app = buildApp();
    const env = {
      API_KEY: "default-secret",
      API_TENANT_POLICY_JSON: JSON.stringify({
        keys: [{ api_key: "team-secret", principal: "service:test", tenants: ["team-a"] }]
      })
    } as Env;

    const allowed = await app.fetch(
      new Request("https://example.test/tenant?tenant_id=team-a", { headers: { "x-api-key": "team-secret" } }),
      env
    );
    const denied = await app.fetch(
      new Request("https://example.test/tenant?tenant_id=team-b", { headers: { "x-api-key": "team-secret" } }),
      env
    );

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
  });
});
