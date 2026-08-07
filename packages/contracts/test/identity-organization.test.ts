import { describe, expect, it } from "vitest";
import {
  BUSINESS_WORK_TYPES,
  businessCategorySchema,
  organizationSchema,
  scimRoleMappingSchema,
  userPrivateProfileSchema,
  userSummarySchema
} from "../src/index";

describe("identity and organization contracts", () => {
  it("keeps full_name out of directory summaries", () => {
    const parsed = userSummarySchema.parse({
      principal: "user:01stable",
      display_name: "Miya",
      avatar_url: null,
      status: "active",
      full_name: "Must not leak"
    });
    expect(parsed).not.toHaveProperty("full_name");
    expect(userPrivateProfileSchema.parse({
      ...parsed,
      tenant_id: "tenant-a",
      full_name: "Miyajima Kazuhiro",
      email: "miya@example.com",
      email_verified: true,
      provision_source: "oidc",
      full_name_source: "oidc",
      created_at: 1,
      updated_at: 1
    }).full_name).toBe("Miyajima Kazuhiro");
  });

  it("normalizes organization and business category defaults", () => {
    expect(organizationSchema.parse({
      tenant_id: "tenant-a",
      slug: "tenant-a",
      display_name: "Tenant A"
    }).email_self_registration_enabled).toBe(false);
    expect(businessCategorySchema.parse({
      id: "cat-1",
      tenant_id: "tenant-a",
      slug: "sales",
      label: "Sales",
      created_at: 1,
      updated_at: 1
    }).is_active).toBe(true);
    expect(BUSINESS_WORK_TYPES).toHaveLength(8);
  });

  it("accepts only explicit fixed-role SCIM mappings", () => {
    expect(scimRoleMappingSchema.parse({
      group_id: "okta-group-1",
      role: "contributor",
      project_id: null
    }).role).toBe("contributor");
  });
});
