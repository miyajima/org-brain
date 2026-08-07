import { describe, expect, it } from "vitest";
import { validateBusinessClassification } from "../src/business-category-service";
import type { Env } from "../src/types";

class CategoryStatement {
  private args: unknown[] = [];
  constructor(private readonly categories: Array<Record<string, unknown>>) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() {
    return (this.categories.find((row) =>
      row.tenant_id === this.args[0] && row.id === this.args[1] && row.is_active === 1
    ) ?? null) as T | null;
  }
}

function env(categories: Array<Record<string, unknown>>) {
  return {
    OPEN_BRAIN_DB: { prepare: () => new CategoryStatement(categories) }
  } as unknown as Env;
}

describe("business classification validation", () => {
  it("accepts only active categories owned by the tenant", async () => {
    const runtime = env([
      { id: "active-a", tenant_id: "tenant-a", is_active: 1 },
      { id: "inactive-a", tenant_id: "tenant-a", is_active: 0 },
      { id: "active-b", tenant_id: "tenant-b", is_active: 1 }
    ]);
    await expect(validateBusinessClassification(runtime, "tenant-a", "active-a", "debug", { required: true }))
      .resolves.toMatchObject({ business_category_id: "active-a", work_type: "debug" });
    await expect(validateBusinessClassification(runtime, "tenant-a", "active-b", "debug"))
      .rejects.toMatchObject({ code: "invalid_business_category" });
    await expect(validateBusinessClassification(runtime, "tenant-a", "inactive-a", "debug"))
      .rejects.toMatchObject({ code: "invalid_business_category" });
  });

  it("warns during observation and rejects missing or unsupported classifications in required mode", async () => {
    const runtime = env([]);
    await expect(validateBusinessClassification(runtime, "tenant-a", null, null))
      .resolves.toMatchObject({
        classification_warning: ["business_category_unclassified", "work_type_unclassified"]
      });
    await expect(validateBusinessClassification(runtime, "tenant-a", null, "debug", { required: true }))
      .rejects.toMatchObject({ code: "business_category_required" });
    await expect(validateBusinessClassification(runtime, "tenant-a", null, "coding"))
      .rejects.toMatchObject({ code: "invalid_work_type" });
  });
});
