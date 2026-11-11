import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerMemoryRoutes } from "../src/memory-routes.js";

type Delivery = { waitUntil: (promise: Promise<unknown>) => void };

function appWith() {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: Record<string, unknown> }>();
  const sharedKnowledgeForSearch = vi.fn(async (..._args: unknown[]) => ({ shared_knowledge: [] }));
  registerMemoryRoutes(app, {
    assertApiTenantAccess: (_context: unknown, tenant?: string | null) => tenant || "default",
    getApiAuthContext: () => ({ principal: "user:reader", defaultRole: "reader" }),
    getApiPrincipal: () => "user:reader",
    jsonOk: (_context: unknown, data: unknown, status = 200) => Response.json({ ok: true, data }, { status }),
    tenantFromBody: () => "default",
    isTenantAdmin: async () => false,
    searchMemories: async () => ({ tenant_id: "default", results: [] }),
    sharedKnowledgeForSearch
  } as any);
  const search = (executionCtx?: ExecutionContext) => app.request("/v1/memories/search", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "release checklist" })
  }, {}, executionCtx);
  return { search, sharedKnowledgeForSearch };
}

describe("shared knowledge delivery on memory search", () => {
  it("hands the request's execution context to the port so the delivery write outlives the response", async () => {
    const { search, sharedKnowledgeForSearch } = appWith();
    const queued: Promise<unknown>[] = [];
    const response = await search({ waitUntil: (promise: Promise<unknown>) => { queued.push(promise); }, passThroughOnException() {} } as ExecutionContext);
    expect(response.status).toBe(200);
    const delivery = sharedKnowledgeForSearch.mock.calls[0]![3] as Delivery;
    const pending = Promise.resolve();
    delivery.waitUntil(pending);
    expect(queued).toEqual([pending]);
  });

  it("reports a missing execution context by throwing, which lets the adapter await the write instead", async () => {
    const { search, sharedKnowledgeForSearch } = appWith();
    expect((await search()).status).toBe(200);
    const delivery = sharedKnowledgeForSearch.mock.calls[0]![3] as Delivery;
    expect(() => delivery.waitUntil(Promise.resolve())).toThrow();
  });
});
