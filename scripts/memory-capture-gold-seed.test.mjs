import { describe, expect, it } from "vitest";
import { DEFAULT_GOLD_DATASET } from "./derive-memory-hook-profile.mjs";
import { buildGoldCapturePlan, parseArgs } from "./memory-capture-gold-seed.mjs";

describe("gold memory capture seed", () => {
  it("builds a stable, bounded, 100-quality capture plan through the real hook path", async () => {
    const options = {
      fixture: DEFAULT_GOLD_DATASET,
      tenantId: "default",
      projectId: "org-brain",
      exampleIds: new Set()
    };
    const first = await buildGoldCapturePlan(options);
    const second = await buildGoldCapturePlan(options);
    expect(first.plan_hash).toBe(second.plan_hash);
    expect(first.summary).toEqual({
      accepted_examples: 6,
      candidate_count: 6,
      batch_count: 2,
      quality_scores: [100, 100, 100, 100, 100, 100],
      kinds: { decision: 1, constraint: 1, pitfall: 1, preference: 1, fact: 2 }
    });
    expect(first.core.profile_id).toBe("strict-gold-v1");
    expect(first.core).toMatchObject({ capture_origin: "synthetic", verification_state: "unverified" });
    expect(first.core.batches.every((batch) => batch.items.length <= 3)).toBe(true);
    expect(first.core.batches.flatMap((batch) => batch.items).every((item) =>
      item.rationale && item.reuse_rule && item.evidence.length > 0 && item.summary !== item.content
      && item.capture_origin === "synthetic" && item.verification.state === "unverified"
    )).toBe(true);
    expect(first.core.batches.flatMap((batch) => batch.items).some((item) =>
      item.evidence.some((evidence) => evidence.evidence_type === "doc")
    )).toBe(true);
    expect(JSON.stringify(first.core)).not.toContain("## Conclusion");
  });

  it("can select one example without rewriting existing gold memories", async () => {
    const plan = await buildGoldCapturePlan({
      fixture: DEFAULT_GOLD_DATASET,
      tenantId: "default",
      projectId: "org-brain",
      exampleIds: new Set(["accepted-fact-stateless-mcp"])
    });
    expect(plan.summary).toMatchObject({ accepted_examples: 1, candidate_count: 1, batch_count: 1 });
    expect(plan.core.example_ids).toEqual(["accepted-fact-stateless-mcp"]);
    expect(plan.records[0]).toMatchObject({ kind: "fact", qualityScore: 100 });
  });

  it("is dry-run by default and requires an explicit private report path", () => {
    expect(() => parseArgs([])).toThrow("output_required");
    expect(parseArgs(["--output", "/tmp/gold-plan.json"])).toMatchObject({
      apply: false,
      tenantId: "default",
      projectId: "org-brain-memory-fixtures"
    });
  });
});
