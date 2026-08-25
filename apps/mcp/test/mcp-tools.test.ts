import { describe, expect, it } from "vitest";

describe("Access MCP proxy", () => {
  it("forwards only signed Access and MCP protocol headers", async () => {
    const { buildMcpProxyRequest } = await import("../src/index");
    const request = buildMcpProxyRequest(new Request("https://mcp.example.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer opaque-oauth-token",
        "cf-access-client-id": "client-id",
        "cf-access-client-secret": "client-secret",
        "cf-access-jwt-assertion": "signed.assertion.jwt",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-session-id": "legacy-session-must-not-forward",
        "x-orgbrain-tenant": "default",
        "x-untrusted": "drop-me"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    }));

    expect(request.url).toBe("https://internal/mcp");
    expect(request.headers.get("cf-access-jwt-assertion")).toBe("signed.assertion.jwt");
    expect(request.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(request.headers.get("mcp-session-id")).toBeNull();
    expect(request.headers.get("x-orgbrain-hook-edge")).toBe("service-binding-v1");
    expect(request.headers.get("x-orgbrain-tenant")).toBe("default");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("cf-access-client-id")).toBeNull();
    expect(request.headers.get("cf-access-client-secret")).toBeNull();
    expect(request.headers.get("x-untrusted")).toBeNull();
  });
});
