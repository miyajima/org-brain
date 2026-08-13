import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { prepareMemoryRecordsV2 } from "../packages/orgbrain-cli/src/hook-memory-bridge.mjs";
import { MEMORY_CAPTURE_HOOK_PROFILE } from "../packages/shared/src/memory-capture-profile.generated.mjs";
import { extractDurableMemoryDrafts } from "../packages/shared/src/memory-capture-v2-runtime.mjs";
import {
  DEFAULT_GOLD_DATASET,
  DEFAULT_PROFILE_OUTPUT,
  buildMemoryCaptureProfile
} from "./derive-memory-hook-profile.mjs";

async function loadGoldDataset() {
  return JSON.parse(await readFile(DEFAULT_GOLD_DATASET, "utf8"));
}

describe("data-derived memory hook profile", () => {
  it("keeps the generated hook profile in sync with the gold dataset", async () => {
    const built = await buildMemoryCaptureProfile({ fixture: DEFAULT_GOLD_DATASET });
    expect(built.profile).toEqual(MEMORY_CAPTURE_HOOK_PROFILE);
    expect(await readFile(DEFAULT_PROFILE_OUTPUT, "utf8")).toBe(built.rendered);
    expect(built.profile).toMatchObject({
      profile_id: "strict-gold-v1",
      required_fields: ["rationale", "reuse_rule", "evidence"],
      minimum_evidence_by_kind: {
        decision: 2,
        constraint: 2,
        pitfall: 2,
        preference: 1,
        fact: 1
      },
      ttl_days_by_kind: {
        decision: 180,
        constraint: 180,
        pitfall: 180,
        preference: 180,
        fact: 90
      }
    });
  });

  it("reproduces every accepted gold candidate with separated high-quality fields", async () => {
    const dataset = await loadGoldDataset();
    for (const example of dataset.examples.filter((item) => item.expected.accept)) {
      const result = extractDurableMemoryDrafts(example.input, {
        capture_profile: MEMORY_CAPTURE_HOOK_PROFILE,
        max_candidates: MEMORY_CAPTURE_HOOK_PROFILE.max_candidates
      });
      expect(result.drafts, example.id).toHaveLength(example.expected.candidates.length);
      for (const [index, expected] of example.expected.candidates.entries()) {
        const draft = result.drafts[index];
        expect(draft, example.id).toMatchObject({
          kind: expected.kind,
          content: expected.content,
          rationale: expected.rationale,
          reuse_rule: expected.reuse_rule,
          quality_score: 100,
          capture_profile_id: "strict-gold-v1"
        });
        expect(draft.summary, example.id).not.toBe(draft.content);
        expect(draft.evidence, example.id).toEqual(expect.arrayContaining(expected.evidence));
        expect(draft.valid_until - draft.valid_from, example.id).toBe(
          expected.ttl_days * 24 * 60 * 60 * 1000
        );
      }
    }
  });

  it("rejects every negative gold example for its declared reason", async () => {
    const dataset = await loadGoldDataset();
    for (const example of dataset.examples.filter((item) => !item.expected.accept)) {
      const result = extractDurableMemoryDrafts(example.input, {
        capture_profile: MEMORY_CAPTURE_HOOK_PROFILE,
        max_candidates: MEMORY_CAPTURE_HOOK_PROFILE.max_candidates
      });
      expect(result.drafts, example.id).toEqual([]);
      expect(result.excluded.map((item) => item.reason), example.id).toContain(example.expected.reason);
    }
  });

  it("makes the hook use the generated profile and exposes only hashes and scores in its report", async () => {
    const dataset = await loadGoldDataset();
    const example = dataset.examples.find((item) => item.id === "accepted-decision-canonical-api-url");
    const result = await prepareMemoryRecordsV2({
      sourceName: "codex",
      externalKey: example.input.event_id,
      createdAt: example.input.occurred_at,
      cwd: "/workspace/org-brain",
      projectId: "org-brain",
      projectIdExplicit: true,
      businessCategoryId: null,
      workType: example.work_type,
      assistantText: example.input.text,
      eventType: "Stop",
      metadata: {}
    }, {
      tenantId: "default",
      projectId: "org-brain",
      businessCategoryId: null,
      workType: example.work_type,
      workspaceRoot: "/workspace/org-brain",
      sensitiveMemory: { mode: "deny", allowed_principals: [] }
    }, "default");

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      kind: "decision",
      workType: "implementation",
      qualityScore: 100,
      captureProfileId: "strict-gold-v1"
    });
    expect(result.report).toMatchObject({
      capture_profile_id: "strict-gold-v1",
      capture_profile_source_hash: MEMORY_CAPTURE_HOOK_PROFILE.source_dataset_sha256,
      quality_scores: [100],
      candidate_count: 1
    });
    expect(result.report).not.toHaveProperty("content");
    expect(result.report).not.toHaveProperty("rationale");
  });
});
