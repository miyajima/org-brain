import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/types";

const mocks = vi.hoisted(() => ({
  enrichContext: vi.fn(),
  handlerFactoryCalls: 0
}));

vi.mock("agents/mcp/server", () => ({
  createMcpHandler: () => {
    mocks.handlerFactoryCalls += 1;
    return async () => new Response("standard MCP handler reached", { status: 418 });
  }
}));

vi.mock("../src/context-engine-service", async () => {
  const actual = await vi.importActual<typeof import("../src/context-engine-service")>("../src/context-engine-service");
  return { ...actual, enrichContext: mocks.enrichContext };
});

import { mountMcp } from "../src/mcp";

function testEnv(): Env {
  return {
    MCP_SERVICE_TOKENS_JSON: JSON.stringify({
      tokens: [{
        client_id: "token-1",
        client_secret: "secret-1",
        principal: "service:test",
        tenants: ["default"]
      }]
    }),
    API_RATE_LIMITER: {
      async limit() {
        return { success: true };
      }
    },
    OPEN_BRAIN_DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: [] };
          }
        };
      }
    }
  } as unknown as Env;
}

function contextRequest(
  args: Record<string, unknown>,
  id = 1,
  authenticated = true,
  options: { url?: string; headers?: Record<string, string> } = {}
) {
  return new Request(options.url ?? "https://example.com/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(authenticated
        ? {
            "cf-access-client-id": "token-1",
            "cf-access-client-secret": "secret-1"
          }
        : {}),
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      ...options.headers
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "orgbrain_context_enrich",
        arguments: args
      }
    })
  });
}

async function readContextResult(response: Response) {
  const body = await response.json() as {
    result?: { content?: Array<{ text?: string }> };
  };
  const text = body.result?.content?.[0]?.text;
  if (!text) throw new Error("MCP response did not contain a text result");
  return JSON.parse(text) as Record<string, any>;
}

describe("MCP context_enrich fast path", () => {
  beforeEach(() => {
    mocks.enrichContext.mockReset();
    mocks.handlerFactoryCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles an authenticated no-Origin context call without initializing the full MCP tool catalog", async () => {
    mocks.enrichContext.mockResolvedValue({ decisionContext: [{ id: "dm-1" }] });
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);

    const response = await app.fetch(contextRequest({
      project_id: "project-1",
      user_id: "body-user",
      task: { title: "Resume the existing chat" }
    }), testEnv(), {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(mocks.handlerFactoryCalls).toBe(0);
    expect(mocks.enrichContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenant_id: "default",
        user_id: "body-user",
        agent_id: "service:test",
        project_id: "project-1"
      }),
      { principal: "service:test", bestEffortUsage: true }
    );
    await expect(readContextResult(response)).resolves.toMatchObject({
      decisionContext: [{ id: "dm-1" }]
    });
  });

  it("accepts a matching workers.dev Origin and Host without initializing the full MCP tool catalog", async () => {
    const workerHost = "open-brain-api-gateway.example.workers.dev";
    mocks.enrichContext.mockResolvedValue({ decisionContext: [{ id: "dm-workers" }] });
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);

    const response = await app.fetch(contextRequest({
      project_id: "project-1",
      task: { title: "Resume the existing chat" }
    }, 1, true, {
      url: `https://${workerHost}/mcp`,
      headers: {
        host: workerHost,
        origin: `https://${workerHost}`
      }
    }), testEnv(), {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(mocks.handlerFactoryCalls).toBe(0);
    await expect(readContextResult(response)).resolves.toMatchObject({
      decisionContext: [{ id: "dm-workers" }]
    });
  });

  it("returns a degraded context result when context enrichment is temporarily unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.enrichContext.mockRejectedValue(new Error("database unavailable"));
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);

    const response = await app.fetch(contextRequest({
      task: { title: "Resume the existing chat" }
    }), testEnv(), {} as ExecutionContext);
    const result = await readContextResult(response);

    expect(response.status).toBe(200);
    expect(mocks.handlerFactoryCalls).toBe(0);
    expect(result).toMatchObject({
      decisionContext: [],
      constraints: [],
      knownPitfalls: [],
      conflicts: [],
      confidence: 0,
      requiresHumanReview: true,
      meta: {
        degraded: true,
        degraded_reason: "context_unavailable"
      }
    });
    expect(JSON.stringify(result)).not.toContain("database unavailable");
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith({
      event: "orgbrain.mcp.context_enrich.degraded",
      tenant_id: "default",
      project_id: null,
      error_code: "unknown"
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("database unavailable");
  });

  it.each([
    ["hostile", "https://evil.example"],
    ["opaque", "null"],
    ["malformed", "not-an-origin"],
    ["non-http", "ftp://example.com"]
  ])("rejects a custom-domain %s Origin before the fast path", async (_label, origin) => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);

    const response = await app.fetch(contextRequest({
      task: { title: "Resume the existing chat" }
    }, 1, true, { headers: { origin } }), testEnv(), {} as ExecutionContext);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
      id: null
    });
    expect(mocks.enrichContext).not.toHaveBeenCalled();
    expect(mocks.handlerFactoryCalls).toBe(0);
  });

  it("rejects a workers.dev Host mismatch before the fast path", async () => {
    const workerHost = "open-brain-api-gateway.example.workers.dev";
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);

    const response = await app.fetch(contextRequest({
      task: { title: "Resume the existing chat" }
    }, 1, true, {
      url: `https://${workerHost}/mcp`,
      headers: { host: "other-worker.example.workers.dev" }
    }), testEnv(), {} as ExecutionContext);

    expect(response.status).toBe(403);
    expect(mocks.enrichContext).not.toHaveBeenCalled();
    expect(mocks.handlerFactoryCalls).toBe(0);
  });

  it("keeps authentication and non-target requests on their existing paths", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);

    const unauthenticated = await app.fetch(
      contextRequest({ task: { title: "Resume the existing chat" } }, 1, false),
      testEnv(),
      {} as ExecutionContext
    );
    expect(unauthenticated.status).toBe(401);
    expect(mocks.enrichContext).not.toHaveBeenCalled();

    const discovery = await app.fetch(new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "secret-1"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server/discover", params: {} })
    }), testEnv(), {} as ExecutionContext);

    expect(discovery.status).toBe(418);
    expect(mocks.handlerFactoryCalls).toBe(1);
    expect(mocks.enrichContext).not.toHaveBeenCalled();
  });

  it("applies the same boundary validation to non-target MCP requests", async () => {
    const workerHost = "open-brain-api-gateway.example.workers.dev";
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);

    const response = await app.fetch(new Request(`https://${workerHost}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "secret-1",
        host: workerHost,
        origin: "https://evil.example"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server/discover", params: {} })
    }), testEnv(), {} as ExecutionContext);

    expect(response.status).toBe(403);
    expect(mocks.handlerFactoryCalls).toBe(0);
  });

  it("falls through for invalid context arguments so standard MCP validation is preserved", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);

    const response = await app.fetch(contextRequest({
      max_tokens: 100,
      task: { title: "Resume the existing chat" }
    }), testEnv(), {} as ExecutionContext);

    expect(response.status).toBe(418);
    expect(mocks.handlerFactoryCalls).toBe(1);
    expect(mocks.enrichContext).not.toHaveBeenCalled();
  });

  it("keeps JSON-RPC batches on the standard MCP transport", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);
    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "secret-1"
      },
      body: JSON.stringify([{
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "orgbrain_context_enrich",
          arguments: { task: { title: "Resume the existing chat" } }
        }
      }])
    });

    const response = await app.fetch(request, testEnv(), {} as ExecutionContext);

    expect(response.status).toBe(418);
    expect(mocks.handlerFactoryCalls).toBe(1);
    expect(mocks.enrichContext).not.toHaveBeenCalled();
  });
});
