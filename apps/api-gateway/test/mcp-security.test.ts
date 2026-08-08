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

  it("accepts an additional service token without replacing the primary token set", () => {
    const primaryHeaders = {
      "cf-access-client-id": "primary-token",
      "cf-access-client-secret": "primary-secret"
    };
    const additionalHeaders = {
      "cf-access-client-id": "additional-token",
      "cf-access-client-secret": "additional-secret"
    };
    const env = {
      MCP_SERVICE_TOKENS_JSON: JSON.stringify({
        tokens: [
          {
            client_id: "primary-token",
            client_secret: "primary-secret",
            tenants: ["default"]
          }
        ]
      }),
      MCP_SERVICE_TOKENS_ADDITIONAL_JSON: JSON.stringify({
        tokens: [
          {
            client_id: "additional-token",
            client_secret: "additional-secret",
            principal: "service:codex-orgbrain",
            tenants: ["default"]
          }
        ]
      })
    };

    expect(authorizeMcpRequest(new Request("https://example.com/mcp", { headers: primaryHeaders }), env)).toMatchObject({
      principal: "service:primary-token"
    });
    expect(
      authorizeMcpRequest(new Request("https://example.com/mcp", { headers: additionalHeaders }), env)
    ).toMatchObject({
      principal: "service:codex-orgbrain"
    });
  });

  it("accepts an independently managed machine service-token slot", () => {
    const request = new Request("https://example.com/mcp", {
      headers: {
        "cf-access-client-id": "codex-mac",
        "cf-access-client-secret": "machine-secret"
      }
    });

    expect(authorizeMcpRequest(request, {
      MCP_SERVICE_TOKENS_JSON: JSON.stringify({
        tokens: [{ client_id: "primary", client_secret: "primary-secret", tenants: ["default"] }]
      }),
      MCP_SERVICE_TOKENS_MACHINE_JSON: JSON.stringify({
        tokens: [{
          client_id: "codex-mac",
          client_secret: "machine-secret",
          principal: "service:codex-mac",
          tenants: ["default"]
        }]
      })
    })).toMatchObject({
      principal: "service:codex-mac",
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
