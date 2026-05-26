import { describe, expect, it } from "vitest";
import { buildQualityBackfillPlan } from "./memory-quality-backfill.mjs";

describe("memory quality backfill planning", () => {
  it("plans summary, score, and expiry updates without deleting rows", () => {
    const plan = buildQualityBackfillPlan([
      {
        id: "m1",
        tenant_id: "default",
        project_id: "omopay",
        source: "codex",
        summary: "omopay | promoted-memory | 通りました。",
        content:
          "# Reusable Memory\n\n## Takeaway\n`tests/stripe-connect-verification.spec.ts` を追加し、PASS (2) FAIL (0) でした。\n\n## Evidence\nStripe hosted onboarding と Checkout 遷移を確認しました。",
        tags_json: JSON.stringify(["codex", "hook", "promoted", "command-result", "omopay"]),
        created_at: 1000,
        utility_score: null,
        confidence_score: null,
        expires_at: null
      },
      {
        id: "m2",
        tenant_id: "default",
        project_id: "missing-project-for-quality-backfill-test",
        source: "codex",
        summary: "missing-project-for-quality-backfill-test | promoted-memory | Railsは http://127.0.0.1:3001 で起動中です。",
        content: "Railsは http://127.0.0.1:3001 で起動中です。完了したらログインしたと送ってください。",
        tags_json: JSON.stringify(["codex", "hook", "promoted", "command-result", "missing-project-for-quality-backfill-test"]),
        created_at: 2000,
        utility_score: null,
        confidence_score: null,
        expires_at: null
      }
    ]);

    expect(plan.stats.inspected_count).toBe(2);
    expect(plan.stats.update_count).toBe(2);
    expect(plan.stats.update_summary_count).toBeGreaterThanOrEqual(1);
    expect(plan.stats.set_scores_count).toBe(2);
    expect(plan.stats.set_expiry_count).toBe(1);
    expect(plan.stats.risky_low_signal_count).toBe(1);
    expect(plan.stats.short_summary_candidate_count).toBeGreaterThanOrEqual(1);
    expect(plan.stats.suppression_candidate_count).toBeGreaterThanOrEqual(1);
    expect(plan.stats.artifact_expiry_candidate_count).toBe(0);
    expect(plan.stats.project_mapping_warning_count).toBeGreaterThanOrEqual(1);
    expect(plan.stats.project_mapping_warning_samples.map((item) => item.id)).toContain("m2");
    expect(plan.updates[0]?.assessment.summary).not.toContain("通りました");
  });
});
