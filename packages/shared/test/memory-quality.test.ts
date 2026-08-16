import { describe, expect, it } from "vitest";
import { assessMemoryUsefulness, assessMemoryUsefulnessV1, classifyMemoryQuality } from "../src/memory-quality";
import {
  assessMemoryUsefulness as assessMemoryUsefulnessRuntime,
  classifyMemoryQuality as classifyMemoryQualityRuntime
} from "../src/memory-quality-runtime.mjs";

describe("memory quality assessment", () => {
  it("requires every usefulness dimension plus observed verified AI consensus for active routing", () => {
    const assessed = assessMemoryUsefulnessV1({
      summary: "Use the reviewed importer plan.",
      rationale: "A content-addressed plan makes replays deterministic.",
      reuse_rule: "Reuse the reviewed plan for the same workspace import boundary.",
      capture_origin: "observed",
      verification_state: "verified",
      verified_at: 1_786_464_000_000,
      valid_until: 1_800_000_000_000,
      now: 1_786_464_000_000,
      ai_certification: "ai_consensus_certified",
      judge_consensus: { judgments: [
        { model_family: "family-a", verdict: "pass" },
        { model_family: "family-b", verdict: "pass" },
        { model_family: "family-a", verdict: "pass" }
      ] },
      evidence: [{ type: "file", ref: "src/importer.mjs" }],
      learning: {
        lesson_type: "decision",
        decision_type: "implementation",
        question: "Which importer plan should be used?",
        decision: "Use the reviewed importer plan.",
        rationale: "A content-addressed plan makes replays deterministic.",
        alternatives: [{ alternative: "Raw import" }],
        reuse_rule: "Reuse the reviewed plan for the same workspace import boundary.",
        applicability: { target_files: ["src/importer.mjs"], components: ["codex-session-import"] },
        evidence_selectors: [{ type: "file", ref: "src/importer.mjs" }]
      }
    });

    expect(assessed.route).toBe("active");
    expect(Object.values(assessed.quality_dimensions).every((score) => score >= 95)).toBe(true);
    expect(assessed.hard_violations).toEqual([]);
  });

  it("excludes sensitive or expired learning and quarantines uncertified durable learning", () => {
    const base = {
      summary: "Use the reviewed importer plan.",
      rationale: "A content-addressed plan makes replays deterministic.",
      reuse_rule: "Reuse the reviewed plan for the same workspace import boundary.",
      learning: { conclusion: "Use the reviewed importer plan." }
    };
    expect(assessMemoryUsefulnessV1(base).route).toBe("quarantine");
    const excluded = assessMemoryUsefulnessV1({
      ...base,
      summary: "Use api_key=fixture-secret-value for imports."
    });
    expect(excluded.route).toBe("excluded");
    expect(excluded.hard_violations).toContain("credential_detected");
  });

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
