import { describe, expect, it } from "vitest";
import { ADMIN_LOCALES, adminCommonCopy, scopedAdminHref } from "./admin-ui";

describe("admin UI contract", () => {
  it("keeps every common copy key in all supported locales", () => {
    const baseline = Object.keys(adminCommonCopy.en).sort();
    for (const locale of ADMIN_LOCALES) expect(Object.keys(adminCommonCopy[locale]).sort()).toEqual(baseline);
  });

  it("preserves tenant, project, and language in admin links", () => {
    const params = new URLSearchParams("tenant_id=tenant-a&project_id=project-a&lang=ja&query=discarded");
    expect(scopedAdminHref("/operations", params)).toBe("/operations?tenant_id=tenant-a&project_id=project-a&lang=ja");
    expect(scopedAdminHref("/operations", params, { project_id: null })).toBe("/operations?tenant_id=tenant-a&lang=ja");
  });
});
