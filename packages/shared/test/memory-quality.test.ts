import { describe, expect, it } from "vitest";
import { assessMemoryUsefulness } from "../src/memory-quality";

describe("memory quality assessment", () => {
  it("rewrites low-signal completion summaries into project/category/action titles", () => {
    const assessed = assessMemoryUsefulness({
      project_id: "org-brain",
      summary: "実施しました",
      content: "Takeaway: apps/api-gateway/src/memory-service.ts now stores score metadata. Verification: `pnpm test` passed.",
      tags: ["policy"],
      created_at: Date.parse("2026-05-24T00:00:00.000Z")
    });

    expect(assessed.summary).toContain("org-brain | policy |");
    expect(assessed.summary).toContain("apps/api-gateway/src/memory-service.ts");
    expect(assessed.utility_score).toBeGreaterThan(0.6);
    expect(assessed.confidence_score).toBeGreaterThan(0.7);
    expect(assessed.expires_at).toBeNull();
  });

  it("expires temporary artifact paths instead of making them durable", () => {
    const createdAt = Date.parse("2026-05-24T00:00:00.000Z");
    const assessed = assessMemoryUsefulness({
      project_id: "harness-todo-webapp-new-20260524",
      summary: "通りました",
      content: "Artifact path: /tmp/harness-todo-webapp-new-run-4/log.json",
      tags: ["artifact"],
      created_at: createdAt
    });

    expect(assessed.summary).toContain("harness-todo-webapp-new-20260524 | artifact |");
    expect(assessed.expires_at).toBe(Date.parse("2026-06-07T00:00:00.000Z"));
    expect(assessed.expires_reason).toBe("temporary-artifact-or-runtime-state");
  });
});
