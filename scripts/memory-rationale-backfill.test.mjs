import { describe, expect, it } from "vitest";
import { buildApplySql, buildBackfillPlan, inferEvidence, inferRationale, isHighValue } from "./memory-rationale-backfill.mjs";

describe("memory rationale backfill", () => {
  it("targets active high-value memories without existing rationales", () => {
    const rows = [
      {
        id: "mem-1",
        project_id: "org-brain",
        lifecycle_state: "active",
        tags_json: JSON.stringify(["project-fact", "curated-memory"]),
        content: "## Decision\nUse `wrangler whoami` first.\n## Reason\nCloudflare auth expires.\n## Evidence\napps/api-gateway/wrangler.jsonc",
        summary: "org-brain | project-fact | use wrangler whoami first",
        rationale_id: null
      },
      {
        id: "mem-2",
        project_id: "org-brain",
        lifecycle_state: "active",
        tags_json: JSON.stringify(["curated-memory"]),
        content: "already has rationale",
        summary: "existing",
        rationale_id: "rat-2"
      },
      {
        id: "mem-3",
        project_id: "org-brain",
        lifecycle_state: "active",
        tags_json: JSON.stringify(["agent-turn-complete"]),
        content: "raw",
        summary: "raw",
        rationale_id: null
      }
    ];

    const plan = buildBackfillPlan(rows, "default", 1234);
    expect(plan.targetRows.map((row) => row.id)).toEqual(["mem-1"]);
    expect(plan.skippedExisting).toBe(1);
    expect(plan.rationaleRows[0]?.confirmation_state).toBe("inferred_unconfirmed");
    expect(plan.evidenceRows.length).toBeGreaterThan(0);
    expect(buildApplySql(plan).join("\n")).toContain("INSERT INTO decision_rationales");
  });

  it("extracts rationale and concrete evidence from project-fact content", () => {
    const row = {
      id: "mem-1",
      tags_json: JSON.stringify(["project-fact"]),
      lifecycle_state: "active",
      summary: "org-brain | policy | use wrangler whoami first",
      content: "## Decision\nUse `wrangler whoami` first.\n## Reason\nAuth expires.\n## Evidence\napps/api-gateway/wrangler.jsonc\nthread:abc"
    };

    expect(isHighValue(row)).toBe(true);
    expect(inferRationale(row).decision_type).toBe("policy");
    expect(inferEvidence(row).map((item) => item.evidence_type)).toEqual(expect.arrayContaining(["command", "file", "thread"]));
  });
});
