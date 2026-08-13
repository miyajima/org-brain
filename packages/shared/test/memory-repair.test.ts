import { describe, expect, it } from "vitest";
import {
  planDecisionClassificationRepairRows,
  planMemoryRepairRows
} from "../src/memory-repair";

const NOW = Date.parse("2026-08-12T00:00:00.000Z");

describe("memory repair planner", () => {
  it("derives atomic memories before suppressing a large hook transcript", async () => {
    const plan = await planMemoryRepairRows([{
      id: "legacy-hook",
      project_id: "org-brain",
      source: "codex",
      tags_json: JSON.stringify(["hook", "promoted"]),
      content: [
        "## Conclusion",
        "- We decided to use ORGBRAIN_API_URL as the canonical variable because all adapters share it.",
        "- The hook must send one batch request because discovery adds avoidable latency.",
        "",
        "## Evidence",
        "- packages/orgbrain-cli/src/hook-memory-bridge.mjs",
        "- `pnpm test` passed",
        "",
        "## Gaps",
        "- Production canary is not complete.",
        "x".repeat(900)
      ].join("\n"),
      summary: "Legacy hook transcript",
      created_at: NOW - 1_000
    }], { tenant_id: "default", now: NOW });

    expect(plan.actions.some((action: any) => action.type === "derive")).toBe(true);
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "suppress", memory_id: "legacy-hook", reason_code: "derived_atomic" })
    ]));
    expect(plan.actions.filter((action: any) => action.type === "derive")).toHaveLength(2);
  });

  it("reports credential rotation without retaining the detected value", async () => {
    const secret = "api_key=secret-value-that-must-never-appear";
    const plan = await planMemoryRepairRows([{
      id: "credential-memory",
      project_id: "org-brain",
      source: "codex",
      content: `The decision is invalid because ${secret}`,
      created_at: NOW
    }], { tenant_id: "default", now: NOW });

    expect(plan.credential_rotation_required).toEqual([
      { memory_id: "credential-memory", reason_code: "rotation_required" }
    ]);
    expect(JSON.stringify(plan.credential_rotation_required)).not.toContain(secret);
    expect(plan.actions).toContainEqual(expect.objectContaining({
      type: "suppress",
      memory_id: "credential-memory",
      reason_code: "credential_detected"
    }));
  });

  it("screens credentials from persisted metadata, not only the memory body", async () => {
    const secret = "token=secret-value-hidden-in-evidence";
    const plan = await planMemoryRepairRows([{
      id: "credential-evidence",
      project_id: "org-brain",
      source: "manual",
      kind: "fact",
      content: "ORGBRAIN_API_URL is the canonical variable.",
      evidence_json: JSON.stringify([{ type: "command", ref: secret }]),
      created_at: NOW
    }], { tenant_id: "default", now: NOW });

    expect(plan.credential_rotation_required).toEqual([
      { memory_id: "credential-evidence", reason_code: "rotation_required" }
    ]);
    expect(plan.actions).toContainEqual(expect.objectContaining({
      type: "suppress",
      memory_id: "credential-evidence",
      reason_code: "credential_detected"
    }));
    expect(JSON.stringify(plan.credential_rotation_required)).not.toContain(secret);
  });

  it("scans suppressed rows without reactivating them and still reports credential rotation", async () => {
    const plan = await planMemoryRepairRows([{
      id: "already-suppressed",
      project_id: "org-brain",
      source: "manual",
      lifecycle_state: "suppressed",
      content: "Historical token=secret-value-inside-suppressed-row",
      created_at: NOW
    }], { tenant_id: "default", now: NOW });

    expect(plan.scanned_count).toBe(1);
    expect(plan.actions).toEqual([]);
    expect(plan.categories).toEqual([]);
    expect(plan.credential_rotation_required).toEqual([
      { memory_id: "already-suppressed", reason_code: "rotation_required" }
    ]);
  });

  it("normalizes paths and directives in all persisted metadata", async () => {
    const root = "/Users/alice/projects/org-brain";
    const plan = await planMemoryRepairRows([{
      id: "metadata-paths",
      project_id: "org-brain",
      source: "manual",
      kind: "fact",
      content: "ORGBRAIN_API_URL is the canonical variable.",
      summary: `See ${root}/docs/SPEC.md`,
      rationale: `Defined by ${root}/AGENTS.md`,
      reuse_rule: `When editing ${root}/src/index.ts, apply this rule.`,
      evidence_json: JSON.stringify([{ type: "file", ref: `${root}/docs/SPEC.md` }]),
      source_refs_json: JSON.stringify([{ type: "file", ref: "/Users/bob/private/notes.md" }]),
      conflicts_json: JSON.stringify(["::code-comment{secret}", `${root}/src/index.ts`]),
      created_at: NOW
    }], { tenant_id: "default", now: NOW, workspace_root: root });

    const update = plan.actions.find((action: any) => action.type === "update") as any;
    expect(update.summary).toBe("See docs/SPEC.md");
    expect(update.rationale).toBe("Defined by AGENTS.md");
    expect(update.reuse_rule).toBe("When editing src/index.ts, apply this rule.");
    expect(update.evidence).toEqual([{ type: "file", ref: "docs/SPEC.md" }]);
    expect(update.source_references).toEqual([{ type: "file", ref: "[external-path]" }]);
    expect(update.conflicts).toEqual(["", "src/index.ts"]);
    expect(JSON.stringify(update)).not.toContain("/Users/");
    expect(JSON.stringify(update)).not.toContain("::code-comment");
  });

  it("suppresses default-deny sensitive data and transient completion rows", async () => {
    const plan = await planMemoryRepairRows([
      {
        id: "pii-memory",
        project_id: "org-brain",
        source: "manual",
        kind: "fact",
        content: "The support contact is alice@example.com.",
        created_at: NOW
      },
      {
        id: "completion-memory",
        project_id: "org-brain",
        source: "codex",
        kind: "fact",
        content: "実装完了しました。commit と push も成功しました。",
        created_at: NOW
      }
    ], { tenant_id: "default", now: NOW });

    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "suppress",
        memory_id: "pii-memory",
        reason_code: "sensitive_memory_denied"
      }),
      expect.objectContaining({
        type: "suppress",
        memory_id: "completion-memory",
        reason_code: "transient"
      })
    ]));
  });

  it("keeps only the strongest active candidate for one canonical key", async () => {
    const rows = [
      {
        id: "weak",
        project_id: "org-brain",
        source: "manual",
        kind: "fact",
        content: "ORGBRAIN_API_URL is the canonical variable.",
        summary: "Canonical API variable",
        confidence_score: 0.5,
        utility_score: 0.5,
        created_at: NOW - 1000
      },
      {
        id: "strong",
        project_id: "org-brain",
        source: "manual",
        kind: "fact",
        content: "ORGBRAIN_API_URL is the canonical variable.",
        summary: "Canonical API variable",
        confidence_score: 0.95,
        utility_score: 0.9,
        evidence_json: JSON.stringify([{ type: "file", ref: "AGENTS.md" }]),
        created_at: NOW
      }
    ];
    const plan = await planMemoryRepairRows(rows, { tenant_id: "default", now: NOW });

    expect(plan.actions).toContainEqual(expect.objectContaining({
      type: "update",
      memory_id: "strong"
    }));
    expect(plan.actions).toContainEqual(expect.objectContaining({
      type: "suppress",
      memory_id: "weak",
      reason_code: "duplicate_canonical_key",
      winner_memory_id: "strong"
    }));
    expect(plan.actions).not.toContainEqual(expect.objectContaining({ type: "update", memory_id: "weak" }));
  });

  it("classifies every active decision from explicit project metadata", async () => {
    const plan = await planDecisionClassificationRepairRows([
      {
        id: "decision-unclassified",
        project_id: "org-brain",
        business_category_id: null,
        work_type: null,
        status: "active"
      },
      {
        id: "decision-explicit",
        project_id: "org-brain",
        business_category_id: "bc_explicit",
        work_type: "review",
        status: "active"
      },
      {
        id: "decision-deprecated",
        project_id: "org-brain",
        status: "deprecated"
      }
    ], { tenant_id: "default" });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        decision_memory_id: "decision-unclassified",
        business_category_id: expect.stringMatching(/^bc_prj_/),
        work_type: "other"
      })
    ]);
    expect(plan.stats).toEqual({ update_count: 1, unclassified_after_plan: 0 });
  });
});
