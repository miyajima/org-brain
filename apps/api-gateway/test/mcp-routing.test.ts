import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/types";

vi.mock("agents/mcp", () => {
  class MockMcpAgent {
    static serve(_path: string) {
      return {
        fetch(_request: Request, _env: unknown, _ctx: unknown) {
          return new Response("mcp handler reached", { status: 418 });
        }
      };
    }
  }

  return {
    McpAgent: MockMcpAgent
  };
});

let mountMcp: typeof import("../src/mcp").mountMcp;

beforeAll(async () => {
  ({ mountMcp } = await import("../src/mcp"));
});

describe("MCP routing under Hono mount path stripping", () => {
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
      headers: {
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "secret-1"
      }
    });

    const env = {
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
      },
      MCP_OBJECT: {
        newUniqueId() {
          return {
            toString() {
              return "stub-session";
            }
          };
        },
        idFromName(name: string) {
          return {
            toString() {
              return name;
            }
          };
        }
      }
    } as unknown as Env;

    const res = await app.fetch(req, env, {} as ExecutionContext);
    const text = await res.text();

    expect(res.status).toBe(418);
    expect(text).toContain("mcp handler reached");
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
