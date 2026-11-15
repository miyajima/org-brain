import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError, registerOperationsRoutes, type OperationsPort } from "../src/index.js";

type Env = { Bindings: Record<string, unknown>; Variables: Record<string, unknown> };
const paths = ["/v1/retention-queue/cancel", "/v1/retrieval-index/rebuild", "/v1/retrieval-index/v3/backfill", "/v1/retrieval-index/v4/backfill", "/v1/retrieval-index/v4/decisions/backfill", "/v1/ops/tasks/id/replay"];

describe("operations request bodies", () => {
  it.each(paths.flatMap((path) => [null, "invalid", 42, []].map((body) => ({ path, body }))))("rejects a non-object body at $path after tenant access", async ({ path, body }) => {
    const operation = vi.fn();
    const access = vi.fn(() => "tenant");
    const app = new Hono<Env>();
    const ports: Partial<OperationsPort<Env>> = {
      assertApiTenantAccess: access,
      tenantFromBody: () => "tenant",
      getApiPrincipal: () => "user",
      cancelRetentionQueue: operation,
      rebuildSemanticIndex: operation,
      backfillV3RetrievalUnits: operation,
      backfillV4RetrievalUnits: operation,
      backfillDecisionRetrievalUnits: operation,
      replayFailedTask: operation
    };
    registerOperationsRoutes(app, ports as OperationsPort<Env>);
    app.onError((error) => Response.json({ error: error.message }, { status: error instanceof HttpError ? error.status : 500 }));
    const request = () => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await request()).status).toBe(400);
    expect(access).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    access.mockImplementation(() => { throw new HttpError(403, "forbidden", "denied"); });
    expect((await request()).status).toBe(403);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(paths.slice(2, 5))("passes numeric-string and null limits through for %s", async (path) => {
    const operation = vi.fn(async () => ({}));
    const app = new Hono<Env>();
    const ports: Partial<OperationsPort<Env>> = {
      assertApiTenantAccess: () => "tenant", tenantFromBody: () => "tenant",
      jsonOk: (_context, data) => Response.json(data),
      backfillV3RetrievalUnits: operation, backfillV4RetrievalUnits: operation, backfillDecisionRetrievalUnits: operation
    };
    registerOperationsRoutes(app, ports as OperationsPort<Env>);
    app.onError((error) => Response.json({ error: error.message }, { status: error instanceof HttpError ? error.status : 500 }));
    const request = (body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, {});
    for (const limit of ["12", null]) {
      expect((await request({ limit, project_id: "project", cursor: null })).status).toBe(200);
      expect(operation).toHaveBeenLastCalledWith(expect.anything(), { tenantId: "tenant", projectId: "project", cursor: null, limit });
    }
    operation.mockClear();
    expect((await request({ project_id: 42 })).status).toBe(400);
    expect((await request({ cursor: [] })).status).toBe(400);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([42, {}])("rejects a malformed replay tenant after access without executing", async (tenantId) => {
    const replay = vi.fn();
    const access = vi.fn(() => "default");
    const app = new Hono<Env>();
    const ports: Partial<OperationsPort<Env>> = { assertApiTenantAccess: access, replayFailedTask: replay };
    registerOperationsRoutes(app, ports as OperationsPort<Env>);
    app.onError((error) => Response.json({ error: error.message }, { status: error instanceof HttpError ? error.status : 500 }));
    const response = await app.request("/v1/ops/tasks/id/replay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant_id: tenantId }) });
    expect(response.status).toBe(400);
    expect(access).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(replay).not.toHaveBeenCalled();
  });
});
