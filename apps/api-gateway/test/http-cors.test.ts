import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("agents/mcp", () => {
  class MockMcpAgent {
    static serve(_path: string) {
      return {
        fetch() {
          return new Response("mcp handler reached", { status: 418 });
        }
      };
    }
  }

  return {
    McpAgent: MockMcpAgent
  };
});

describe("API CORS preflight", () => {
  it("answers browser preflight before API key auth", async () => {
    const { default: app } = await import("../src/index");

    const res = await app.fetch(
      new Request("https://example.com/api/context/enrich", {
        method: "OPTIONS",
        headers: {
          origin: "https://client.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-api-key"
        }
      }),
      { API_KEY: "secret" } as Env,
      {} as ExecutionContext
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("x-api-key");
  });

  it("still requires the API key for non-preflight requests", async () => {
    const { default: app } = await import("../src/index");

    const res = await app.fetch(
      new Request("https://example.com/api/context/enrich", {
        method: "POST",
        headers: {
          origin: "https://client.example",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          orgId: "default",
          task: { title: "production API auth check" }
        })
      }),
      { API_KEY: "secret" } as Env,
      {} as ExecutionContext
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
