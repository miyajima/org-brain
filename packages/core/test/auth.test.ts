import { describe, expect, it } from "vitest";
import { effectivePermissions, isOrgRole, roleAllows } from "../src/index.js";

describe("shared authorization", () => {
  it("maps roles and scopes with an intersection", () => {
    expect(isOrgRole("reader")).toBe(true);
    expect(isOrgRole("catalog_manager")).toBe(false);
    expect(roleAllows("reader", "write")).toBe(false);
    expect(effectivePermissions("tenant_admin", ["orgbrain:read", "orgbrain:write"]))
      .toEqual(["read", "write"]);
  });
});
