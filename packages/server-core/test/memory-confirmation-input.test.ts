import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError, registerMemoryRoutes, type MemoryPort } from "../src/index.js";

type Env = { Bindings: Record<string, unknown>; Variables: Record<string, unknown> };

describe("memory confirmation request bodies", () => {
  it.each(["confirm", "confirmation-status", "confirmation-cancel", "conversation-stage", "conversation-revise", "feedback/id/review", "relations/id/review"].flatMap((path) =>
    [null, "invalid", 42, []].map((body) => ({ path, body }))
  ))("rejects non-object body for $path before invoking an operation", async ({ path, body }) => {
    const operation = vi.fn();
    const app = new Hono<Env>();
    const ports: Partial<MemoryPort<Env>> = {
      assertApiTenantAccess: () => "tenant",
      tenantFromBody: () => "tenant",
      getApiAuthContext: () => ({ principal: "user", defaultRole: "reader" }),
      getApiPrincipal: () => "user",
      cancelMemoryConfirmation: operation,
      stageConversationMemories: operation,
      reviewMemoryFeedback: operation,
      reviewMemoryRelation: operation,
      guardMemoryConfirmation: operation,
      confirmProposedMemory: operation,
      getMemoryConfirmationStatus: operation,
      jsonOk: (_context, data, status = 200) => Response.json(data, { status })
    };
    registerMemoryRoutes(app, ports as MemoryPort<Env>);
    app.onError((error) => Response.json({ error: error.message }, { status: error instanceof HttpError ? error.status : 500 }));
    const response = await app.request(`/v1/memories/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(operation).not.toHaveBeenCalled();
  });
});

describe("retrieval generation request body", () => {
  it.each([null, "invalid", 42, []])("rejects a non-object body after authorization", async (body) => {
    const transition = vi.fn();
    const authorize = vi.fn();
    const app = new Hono<Env>();
    const ports: Partial<MemoryPort<Env>> = {
      assertApiTenantAccess: () => "tenant",
      tenantFromBody: () => "tenant",
      getApiAuthContext: () => ({ principal: "user", defaultRole: "reader" }),
      assertRetrievalOperator: authorize,
      transitionRetrievalGeneration: transition
    };
    registerMemoryRoutes(app, ports as MemoryPort<Env>);
    app.onError((error) => Response.json({ error: error.message }, { status: error instanceof HttpError ? error.status : 500 }));
    const request = () => app.request("/v1/retrieval-generations/id", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await request()).status).toBe(400);
    expect(authorize).toHaveBeenCalledOnce();
    expect(transition).not.toHaveBeenCalled();
    authorize.mockImplementation(() => { throw new HttpError(403, "forbidden", "denied"); });
    expect((await request()).status).toBe(403);
    expect(transition).not.toHaveBeenCalled();
  });
});
