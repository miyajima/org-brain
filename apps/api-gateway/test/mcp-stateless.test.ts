import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountMcp } from "../src/mcp";
import type { Env } from "../src/types";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": {
    name: "orgbrain-test-client",
    version: "1.0.0"
  }
};

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
    }
  } as unknown as Env;
}

function modernRequest(method: string, id: number) {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "cf-access-client-id": "token-1",
      "cf-access-client-secret": "secret-1",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { _meta: MODERN_META }
    })
  });
}

async function readJsonRpc(response: Response) {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new Error("MCP event stream returned no data event");
    return JSON.parse(data.slice("data: ".length)) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe("MCP 2026-07-28 stateless transport", () => {
  it("serves discovery and tool catalogs without a protocol session", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);
    const env = testEnv();
    const ctx = {} as ExecutionContext;

    const discovery = await app.fetch(modernRequest("server/discover", 1), env, ctx);
    const discoveryBody = await discovery.json() as {
      result?: {
        supportedVersions?: string[];
        ttlMs?: number;
        cacheScope?: string;
      };
    };

    expect(discovery.status).toBe(200);
    expect(discovery.headers.get("mcp-session-id")).toBeNull();
    expect(discoveryBody.result?.supportedVersions).toContain("2026-07-28");
    expect(discoveryBody.result).toMatchObject({
      ttlMs: 300_000,
      cacheScope: "private"
    });

    const tools = await app.fetch(modernRequest("tools/list", 2), env, ctx);
    const toolsBody = await tools.json() as {
      result?: {
        tools?: Array<{ name: string }>;
        ttlMs?: number;
        cacheScope?: string;
      };
    };

    expect(tools.status).toBe(200);
    expect(tools.headers.get("mcp-session-id")).toBeNull();
    expect(toolsBody).toHaveProperty("result");
    expect(toolsBody.result?.tools?.some((tool) => tool.name === "orgbrain_context_enrich")).toBe(true);
    expect(toolsBody.result).toMatchObject({
      ttlMs: 300_000,
      cacheScope: "private"
    });
  });

  it("keeps ordinary 2025 clients on the stateless compatibility lane", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);
    const env = testEnv();
    const ctx = {} as ExecutionContext;
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "cf-access-client-id": "token-1",
      "cf-access-client-secret": "secret-1"
    };

    const initialize = await app.fetch(new Request("https://example.com/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test-client", version: "1.0.0" }
        }
      })
    }), env, ctx);
    const initializeBody = await readJsonRpc(initialize) as {
      result?: { protocolVersion?: string };
    };

    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeNull();
    expect(initializeBody.result?.protocolVersion).toBe("2025-11-25");

    const tools = await app.fetch(new Request("https://example.com/mcp", {
      method: "POST",
      headers: { ...headers, "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    }), env, ctx);
    const toolsBody = await readJsonRpc(tools) as { result?: { tools?: Array<{ name: string }> } };

    expect(tools.status).toBe(200);
    expect(tools.headers.get("mcp-session-id")).toBeNull();
    expect(toolsBody.result?.tools?.some((tool) => tool.name === "orgbrain_context_enrich")).toBe(true);
  });
});
