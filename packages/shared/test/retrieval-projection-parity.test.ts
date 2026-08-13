import { describe, expect, it } from "vitest";
import {
  analyzeRetrievalIntent as analyzeCloudIntent,
  buildVerifiedLearningRetrievalUnits as buildCloudLearning,
  buildRetrievalUnits as buildCloudV3,
  buildRetrievalUnitsV4 as buildCloudV4,
  retrievalUnitLexicalSpecificity as cloudSpecificity
} from "../src/retrieval-units";
// The local CLI adapter is JavaScript by design and is part of the published CLI surface.
// @ts-expect-error JavaScript adapter has no declaration file.
import {
  analyzeRetrievalIntent as analyzeLocalIntent,
  buildVerifiedLearningRetrievalUnits as buildLocalLearning,
  buildRetrievalUnits as buildLocalV3,
  buildRetrievalUnitsV4 as buildLocalV4,
  retrievalUnitLexicalSpecificity as localSpecificity
} from "../../orgbrain-cli/src/lib/retrieval-units.mjs";

const records = [
  {
    id: "memory-a",
    tenant_id: "default",
    project_id: "orgbrain",
    kind: "preference",
    content: "User: I prefer PostgreSQL for durable task storage.",
    summary: "Storage preference",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    valid_from: null,
    valid_until: null,
    source_references: [{ type: "event", ref: "a", captured_at: 1_700_000_000_000 }]
  },
  {
    id: "memory-b",
    tenant_id: "default",
    project_id: "orgbrain",
    kind: "decision",
    content: "User: The API must never expose credentials.\nAssistant: Use redaction before persistence.",
    summary: "Credential handling policy",
    created_at: 1_700_100_000_000,
    updated_at: 1_700_100_000_000,
    valid_from: null,
    valid_until: null,
    source_references: [{ type: "event", ref: "b", captured_at: 1_700_100_000_000 }]
  },
  {
    id: "memory-c",
    tenant_id: "default",
    project_id: "orgbrain",
    kind: "event",
    content: "User: We migrated the retrieval index on 2026-07-30.",
    summary: "Retrieval migration",
    created_at: 1_701_000_000_000,
    updated_at: 1_701_000_000_000,
    valid_from: null,
    valid_until: null,
    source_references: [{ type: "event", ref: "c", captured_at: 1_701_000_000_000 }]
  }
];

function normalizedUnit(unit: Record<string, unknown>) {
  return {
    id: unit.id,
    memory_id: unit.memory_id,
    unit_type: unit.unit_type,
    speaker: unit.speaker,
    text: unit.text,
    event_at: unit.event_at,
    content_hash: unit.content_hash,
    metadata_json: unit.metadata_json,
    segment_id: unit.segment_id
  };
}

function topFive(
  units: Array<{ id: string; memory_id: string; text: string }>,
  query: string,
  specificity: (units: Array<{ id: string; text: string }>, query: string) => Map<string, number>
) {
  const scores = specificity(units, query);
  const byMemory = new Map<string, number>();
  for (const unit of units) {
    byMemory.set(unit.memory_id, Math.max(byMemory.get(unit.memory_id) ?? 0, scores.get(unit.id) ?? 0));
  }
  return [...byMemory.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([id]) => id);
}

describe("SQLite and D1 retrieval projection parity", () => {
  it("produces identical v3/v4 unit IDs, metadata, intent, and top-5 ordering", async () => {
    const cloudV3 = (await Promise.all(records.map((record) => buildCloudV3(record)))).flat();
    const localV3 = records.flatMap((record) => buildLocalV3(record));
    const cloudV4 = (await Promise.all(records.map((record) => buildCloudV4(record)))).flat();
    const localV4 = records.flatMap((record) => buildLocalV4(record));

    expect(cloudV3.map(normalizedUnit)).toEqual(localV3.map(normalizedUnit));
    expect(cloudV4.map(normalizedUnit)).toEqual(localV4.map(normalizedUnit));
    expect(analyzeCloudIntent("What credential policy did you recommend most recently?"))
      .toEqual(analyzeLocalIntent("What credential policy did you recommend most recently?"));
    expect(topFive(cloudV4, "credential redaction policy", cloudSpecificity))
      .toEqual(topFive(localV4, "credential redaction policy", localSpecificity));
  });

  it("produces identical verified-learning projections in Local SQLite and Cloud D1 adapters", async () => {
    const record = {
      id: "learning-a",
      tenant_id: "default",
      project_id: "orgbrain",
      kind: "pitfall",
      content: "Verify command results from the current turn.",
      summary: "Current-turn command verification",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      valid_from: null,
      valid_until: 1_900_000_000_000,
      verified_at: 1_700_000_000_500,
      capture_origin: "observed",
      verification_state: "verified",
      source_references: [{ type: "event", ref: "learning-a", captured_at: 1_700_000_000_000 }],
      learning_json: JSON.stringify({
        schema_version: 1,
        lesson_type: "failure",
        kind: "pitfall",
        trigger: "A final response claims a command succeeded",
        conclusion: "Only a same-turn command result can attest command success",
        rationale: "Final-answer prose is not an execution result",
        reuse_rule: "Require an observed exit code or a valid signed command attestation",
        outcome: "False command evidence was rejected",
        applicability: { target_files: ["packages/orgbrain-cli/src/lib/memory-learning-transcript.mjs"], components: ["memory-learning"] },
        evidence_selectors: [{ type: "command", ref: "vitest memory-evidence-verifier" }],
        gaps: []
      })
    };
    const now = 1_800_000_000_000;
    const cloud = await buildCloudLearning(record, now);
    const local = buildLocalLearning(record, now);

    expect(cloud).toHaveLength(5);
    expect(cloud.map(normalizedUnit)).toEqual(local.map(normalizedUnit));
    expect(cloud.map((unit) => unit.unit_type)).toEqual(["atomic", "profile", "ledger", "timeline", "segment"]);
  });

});
