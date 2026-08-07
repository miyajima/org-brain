import { describe, expect, it } from "vitest";
import {
  buildBusinessClassificationBackfillPlan,
  buildBusinessClassificationSql,
  parseBackfillCsv
} from "./business-category-backfill.mjs";

describe("business classification backfill", () => {
  it("parses CSV and validates tenant, active category, source, and work type", () => {
    const rows = parseBackfillCsv(
      "tenant_id,source_type,source_id,business_category_id,work_type\n" +
      "tenant-a,memory,memory-1,category-1,debug\n"
    );
    const plan = buildBusinessClassificationBackfillPlan(rows, {
      tenantId: "tenant-a",
      activeCategories: ["category-1"],
      memoryIds: ["memory-1"],
      decisionIds: []
    });
    expect(plan).toMatchObject({ valid: true, errors: [] });
    const sql = buildBusinessClassificationSql(plan);
    expect(sql).toContain("UPDATE memories SET business_category_id='category-1'");
    expect(sql).toContain("UPDATE memory_versions");
    expect(sql).toContain("UPDATE retrieval_units");
  });

  it("rejects cross-tenant and inactive-category rows before generating an apply plan", () => {
    const plan = buildBusinessClassificationBackfillPlan([{
      tenant_id: "tenant-b",
      source_type: "decision_memory",
      source_id: "decision-1",
      business_category_id: "inactive-category",
      work_type: "invalid"
    }], {
      tenantId: "tenant-a",
      activeCategories: [],
      memoryIds: [],
      decisionIds: ["decision-1"]
    });
    expect(plan.valid).toBe(false);
    expect(plan.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      "tenant_mismatch", "category_missing_or_inactive", "invalid_work_type"
    ]));
  });
});
