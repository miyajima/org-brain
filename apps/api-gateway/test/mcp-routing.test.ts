import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/types";

const handlerCalls = vi.hoisted(() => [] as Array<{
  request: Request;
  options: Record<string, unknown>;
}>);

vi.mock("agents/mcp/server", () => {
  return {
    createMcpHandler: (_factory: unknown, options: Record<string, unknown>) =>
      async (request: Request) => {
        handlerCalls.push({ request, options });
        return new Response("mcp handler reached", { status: 418 });
      }
  };
});

let mountMcp: typeof import("../src/mcp").mountMcp;
let assertMcpToolAllowed: typeof import("../src/mcp").assertMcpToolAllowed;

beforeAll(async () => {
  ({ mountMcp, assertMcpToolAllowed } = await import("../src/mcp"));
});

describe("MCP routing under Hono mount path stripping", () => {
  it("allows hook installations to call only capture-rationale", async () => {
    const props = {
      tenantId: "default",
      principal: "user:alice",
      allowedTenants: ["default"],
      defaultRole: "reader" as const,
      allowedTools: ["orgbrain_memories_capture_rationale"]
    };
    const request = (name: string) => new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } })
    });
    await expect(assertMcpToolAllowed(request("orgbrain_memories_capture_rationale"), props)).resolves.toBeUndefined();
    await expect(assertMcpToolAllowed(request("orgbrain_task_create"), props)).rejects.toMatchObject({ status: 403 });
  });

  it("returns 401 (not 404) for unauthenticated MCP request", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);

    const req = new Request("https://example.com/mcp");
    const env = {} as Env;

    const res = await app.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Missing MCP authentication");
  });

  it("mounted request reaches auth gate with correct headers", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);

    const req = new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "secret-1",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} })
    });

    const env = {
      MCP_AUTH_MODE: "dual",
      MCP_SERVICE_TOKENS_JSON: JSON.stringify({
        tokens: [
          {
            client_id: "token-1",
            client_secret: "secret-1",
            principal: "service:openclaw-orgbrain",
            tenants: ["default", "team-a"]
          }
        ]
      }),
      API_RATE_LIMITER: {
        async limit() {
          return { success: true };
        }
      }
    } as unknown as Env;

    const res = await app.fetch(req, env, {} as ExecutionContext);
    const text = await res.text();

    expect(res.status).toBe(418);
    expect(text).toContain("mcp handler reached");
    expect(handlerCalls.at(-1)?.options).toMatchObject({
      route: "/",
      legacy: "stateless",
      corsOptions: false,
      authContext: {
        props: {
          tenantId: "default",
          principal: "service:openclaw-orgbrain",
          allowedTenants: ["default", "team-a"]
        }
      }
    });
    expect(handlerCalls.at(-1)?.request.headers.get("mcp-session-id")).toBeNull();
    expect(handlerCalls.at(-1)?.request.headers.get("mcp-protocol-version")).toBe("2026-07-28");
  });

  it("fails closed before the MCP handler when rate limiting is unavailable", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);
    const req = new Request("https://example.com/mcp", {
      headers: {
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "secret-1"
      }
    });
    const env = {
      MCP_AUTH_MODE: "dual",
      MCP_SERVICE_TOKENS_JSON: JSON.stringify({
        tokens: [{
          client_id: "token-1",
          client_secret: "secret-1",
          principal: "service:test",
          tenants: ["default"]
        }]
      })
    } as Env;

    const res = await app.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("rate limiter is not configured");
  });
});
