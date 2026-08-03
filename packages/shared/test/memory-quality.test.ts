import { describe, expect, it } from "vitest";
import { assessMemoryUsefulness, classifyMemoryQuality } from "../src/memory-quality";
import {
  assessMemoryUsefulness as assessMemoryUsefulnessRuntime,
  classifyMemoryQuality as classifyMemoryQualityRuntime
} from "../src/memory-quality-runtime.mjs";

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
    expect(assessed.expires_at).toBe(Date.parse("2026-06-23T00:00:00.000Z"));
    expect(assessed.expires_reason).toBe("temporary-artifact-or-uncommitted");
  });

  it("keeps typed Cloud and runtime-neutral Node assessments identical", () => {
    const input = {
      project_id: "consentside",
      summary:
        "consentside | command-result | # Reusable Memory - Source: codex - Event: agent-turn-complete ## Takeaway 原因はcron未設定でした。",
      content:
        "# Reusable Memory\n\n## Takeaway\n原因はcron未設定でした。対応として `wrangler deploy` を実行し、成功を確認しました。",
      tags: ["codex", "hook", "promoted", "diagnosis", "consentside"],
      created_at: Date.parse("2026-08-01T00:00:00.000Z")
    };

    expect(assessMemoryUsefulness(input)).toEqual(assessMemoryUsefulnessRuntime(input));
    expect(classifyMemoryQuality(input)).toEqual(classifyMemoryQualityRuntime(input));
  });

  it("exposes the richer low-signal suppression decision to Cloud callers", () => {
    const input = {
      project_id: "smart-block",
      summary: "smart-block | promoted-memory | 実施しました。",
      content: "実施しました。",
      tags: ["codex", "hook", "promoted", "smart-block"]
    };

    expect(classifyMemoryQuality(input)).toMatchObject({
      action: "delete",
      reason: "promoted-without-reuse-signal"
    });
    expect(assessMemoryUsefulness(input)).toMatchObject({
      risky_low_signal: true,
      suppression_candidate: true
    });
  });
});
