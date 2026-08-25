import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/types";

const mocks = vi.hoisted(() => ({
  enrichContext: vi.fn(),
  handlerFetch: vi.fn(),
  handlerFactoryCalls: 0
}));

vi.mock("agents/mcp/server", () => ({
  createMcpHandler: () => {
    mocks.handlerFactoryCalls += 1;
    return { fetch: mocks.handlerFetch };
  }
}));

vi.mock("../src/context-engine-service", async () => {
  const actual = await vi.importActual<typeof import("../src/context-engine-service")>("../src/context-engine-service");
  return { ...actual, enrichContext: mocks.enrichContext };
});

import { mountMcp } from "../src/mcp";

function testEnv(): Env {
  return {
    MCP_AUTH_MODE: "dual",
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
    }
  } as unknown as Env;
}

function contextRequest(options: { authenticated?: boolean; origin?: string } = {}) {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(options.authenticated === false ? {} : {
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "secret-1"
      }),
      ...(options.origin ? { origin: options.origin } : {}),
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "orgbrain_context_enrich"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "orgbrain_context_enrich",
        arguments: { task: { title: "Resume the existing chat" } },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" }
        }
      }
    })
  });
}

describe("MCP context_enrich standard handler path", () => {
  beforeEach(() => {
    mocks.enrichContext.mockReset();
    mocks.handlerFetch.mockReset();
    mocks.handlerFetch.mockResolvedValue(new Response("standard MCP handler reached", { status: 418 }));
    mocks.handlerFactoryCalls = 0;
  });

  it("routes context enrichment through the SDK handler without a raw fast path", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);
    const response = await app.fetch(contextRequest(), testEnv(), {} as ExecutionContext);

    expect(response.status).toBe(418);
    expect(await response.text()).toContain("standard MCP handler reached");
    expect(mocks.handlerFactoryCalls).toBe(1);
    expect(mocks.handlerFetch).toHaveBeenCalledOnce();
    expect(mocks.enrichContext).not.toHaveBeenCalled();
  });

  it("keeps authentication ahead of SDK dispatch", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);
    const response = await app.fetch(contextRequest({ authenticated: false }), testEnv(), {} as ExecutionContext);

    expect(response.status).toBe(401);
    expect(mocks.handlerFactoryCalls).toBe(0);
    expect(mocks.handlerFetch).not.toHaveBeenCalled();
  });

  it("rejects an untrusted Origin before SDK dispatch", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);
    const response = await app.fetch(contextRequest({ origin: "https://evil.example" }), testEnv(), {} as ExecutionContext);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mocks.handlerFetch).not.toHaveBeenCalled();
  });

  it("keeps SDK failures visible instead of returning fabricated context", async () => {
    mocks.handlerFetch.mockRejectedValueOnce(new Error("context backend unavailable"));
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);
    const response = await app.fetch(contextRequest(), testEnv(), {} as ExecutionContext);

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("context backend unavailable");
    expect(mocks.enrichContext).not.toHaveBeenCalled();
  });
});
