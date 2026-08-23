import { describe, expect, it } from "vitest";
import { mcpAuthContextSchema, orgRoleSchema, principalContextSchema } from "../src/index.js";

describe("shared auth contracts", () => {
  it("denies unknown roles at the schema boundary", () => {
    expect(orgRoleSchema.safeParse("catalog_manager").success).toBe(false);
  });

  it("parses tenant-bound principal and MCP contexts", () => {
    const principal = principalContextSchema.parse({
      principal: "user:1",
      tenant_id: "tenant-1",
      role: "reader",
      permissions: ["read"],
      auth_source: "oidc"
    });
    expect(principal.scopes).toEqual([]);
    expect(mcpAuthContextSchema.parse({
      ...principal,
      auth_source: "oauth-access-token",
      client_id: "chatgpt",
      scopes: ["orgbrain:read"],
      token_id: "jti-1",
      expires_at: Date.now() + 60_000
    }).allowed_tools).toBeNull();
  });
});
