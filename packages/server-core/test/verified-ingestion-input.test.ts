import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError, registerAssetAgentRoutes, type AssetAgentPort } from "../src/index.js";

type Env = { Bindings: Record<string, unknown>; Variables: Record<string, unknown> };

describe("verified ingestion project scope", () => {
  it.each([42, {}])("rejects a non-string project before permission lookup", async (projectId) => {
    const access = vi.fn(() => "tenant");
    const authorize = vi.fn(async (_env: object, input: { projectId?: string | null }) => ({ allowed: Boolean(input.projectId?.trim()) }));
    const ingest = vi.fn();
    const app = new Hono<Env>();
    const ports: Partial<AssetAgentPort<Env>> = {
      tenantFromBody: () => "tenant", assertApiTenantAccess: access,
      getApiPrincipal: () => "user", getApiAuthContext: () => ({ principal: "user", defaultRole: "reader" }),
      authorizePermission: authorize, ingestVerifiedKnowledgeBundle: ingest
    };
    registerAssetAgentRoutes(app, ports as AssetAgentPort<Env>);
    app.onError((error) => Response.json({ error: error.message }, { status: error instanceof HttpError ? error.status : 500 }));
    const request = () => app.request("/v1/memory-ingestions/verified", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId }) }, {});
    expect((await request()).status).toBe(400);
    expect(access).toHaveBeenCalledOnce();
    expect(authorize).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    access.mockImplementation(() => { throw new HttpError(403, "forbidden", "denied"); });
    expect((await request()).status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
});
