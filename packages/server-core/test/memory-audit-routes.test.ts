import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/errors.js";
import { registerMemoryRoutes } from "../src/memory-routes.js";

function appWith(overrides: Record<string, unknown> = {}) {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: Record<string, unknown> }>();
  const assertPermission = vi.fn(async () => undefined);
  const getMemoryQualityAudit = vi.fn(async () => ({ contract: "memory-quality-audit/v1", read_only: true }));
  const getMemoryQualityAuditDetail = vi.fn(async () => ({ contract: "memory-quality-audit/v1", read_only: true }));
  registerMemoryRoutes(app, {
    assertApiTenantAccess: (_context: unknown, tenant?: string | null) => tenant || "default",
    getApiAuthContext: () => ({ principal: "user:reader", defaultRole: "reader" }),
    getApiPrincipal: () => "user:reader",
    jsonOk: (_context: unknown, data: unknown, status = 200) => Response.json({ ok: true, data }, { status }),
    tenantFromBody: () => "default",
    assertPermission,
    isTenantAdmin: vi.fn(async () => false),
    getMemoryQualityAudit,
    getMemoryQualityAuditDetail,
    ...overrides
  } as any);
  app.onError((error) => {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "internal_error";
    return Response.json({ ok: false, error: { code } }, { status });
  });
  return { app, assertPermission, getMemoryQualityAudit, getMemoryQualityAuditDetail };
}

describe("memory quality audit routes", () => {
  it("uses project read authorization and forwards no body content", async () => {
    const fixture = appWith();
    const response = await fixture.app.request("/v1/memory-quality/audit?tenant_id=tenant-a&project_id=project-a");

    expect(response.status).toBe(200);
    expect(fixture.assertPermission).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ tenantId: "tenant-a", projectId: "project-a", permission: "read" })
    );
    expect(fixture.getMemoryQualityAudit).toHaveBeenCalledWith(
      undefined,
      "tenant-a",
      { scope: "project", projectId: "project-a", principal: "user:reader" }
    );
  });

  it("rejects tenant audit without tenant admin or memory:audit", async () => {
    const fixture = appWith({
      assertPermission: vi.fn(async (_env: unknown, input: { permission: string }) => {
        if (input.permission === "memory:audit") throw new HttpError(403, "forbidden", "denied");
      })
    });
    const response = await fixture.app.request("/v1/memory-quality/audit?tenant_id=tenant-a&scope=tenant");

    expect(response.status).toBe(403);
    expect(fixture.getMemoryQualityAudit).not.toHaveBeenCalled();
  });

  it("keeps per-memory audit details tenant-admin only", async () => {
    const fixture = appWith();
    const response = await fixture.app.request("/v1/admin/memory-quality/audit/memories/memory-a?tenant_id=tenant-a");

    expect(response.status).toBe(403);
    expect(fixture.getMemoryQualityAuditDetail).not.toHaveBeenCalled();
  });
});
