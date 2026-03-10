import { describe, expect, it } from "vitest";
import { authorizeMcpRequest } from "../src/mcp-security";

describe("authorizeMcpRequest", () => {
  it("rejects when auth headers are missing", () => {
    const req = new Request("https://example.com/mcp");
    expect(() => authorizeMcpRequest(req, {})).toThrow(/Missing MCP authentication/);
  });

  it("accepts a valid service token and resolves tenant from inline grants", () => {
    const req = new Request("https://example.com/mcp", {
      headers: {
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "secret-1"
      }
    });

    const result = authorizeMcpRequest(req, {
      MCP_SERVICE_TOKENS_JSON: JSON.stringify({
        tokens: [
          {
            client_id: "token-1",
            client_secret: "secret-1",
            principal: "service:openclaw-orgbrain",
            tenants: ["default", "team-a"]
          }
        ]
      })
    });

    expect(result).toMatchObject({
      principal: "service:openclaw-orgbrain",
      tenantId: "default"
    });
  });

  it("rejects when service token tenant is not in the allowed list", () => {
    const req = new Request("https://example.com/mcp", {
      headers: {
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "secret-1",
        "x-orgbrain-tenant": "team-b"
      }
    });

    expect(() =>
      authorizeMcpRequest(req, {
        MCP_SERVICE_TOKENS_JSON: JSON.stringify({
          tokens: [
            {
              client_id: "token-1",
              client_secret: "secret-1",
              principal: "service:openclaw-orgbrain",
              tenants: ["default", "team-a"]
            }
          ]
        })
      })
    ).toThrow(/not allowed/);
  });

  it("rejects an invalid service token", () => {
    const req = new Request("https://example.com/mcp", {
      headers: {
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "wrong-secret"
      }
    });

    expect(() =>
      authorizeMcpRequest(req, {
        MCP_SERVICE_TOKENS_JSON: JSON.stringify({
          tokens: [
            {
              client_id: "token-1",
              client_secret: "secret-1",
              tenants: ["default"]
            }
          ]
        })
      })
    ).toThrow(/Invalid service token/);
  });
});
