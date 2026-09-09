import test from "node:test";
import assert from "node:assert/strict";
import { coverageCandidateFingerprint } from "../packages/shared/src/memory-extraction-coverage-runtime.mjs";
import { evaluateCoverageDataset, coverageFreezeManifest } from "./memory-extraction-coverage-evaluate.mjs";

const candidate = { lesson_type: "decision", support_span_ids: ["s1"], fields: [{ name: "decision", values: ["APIを使う。"] }] };
const judgment = { fingerprint: coverageCandidateFingerprint(candidate), correct: true, gold_ids: ["g1"], safety: {} };

test("rejects unseen pass evidence before merging and checks freeze against real inputs", async () => {
  const packet = { schema: "learning-extraction-proposal/v2", snippets: [{ span_id: "s1", role: "user", text: "APIを使う。" }], events: [] };
  const dataset = { schema: "memory-extraction-coverage-evaluation/v1", cases: [{
    id: "c", session_id: "s", split: "tune", category: "decision", labels_source: "human", provider: "openai", model: "gpt-5.6-sol", reasoning_effort: "medium",
    packet, gold: [{ id: "g1" }], variants: Object.fromEntries(["A", "B", "C"].map((v) => [v, { passes: [{ status: "succeeded", packet: { ...packet, snippets: [] }, candidates: [candidate], usage: { input_tokens: 1, output_tokens: 1 } }], judgments: [] }]))
  }] };
  dataset.freeze = coverageFreezeManifest(dataset);
  const report = await evaluateCoverageDataset(dataset, { split: "tune" });
  assert.equal(report.metrics.C.candidate_count, 0);
  assert.equal(report.integrity.freeze_complete, true);
  dataset.cases[0].packet.snippets[0].text = "changed";
  assert.equal((await evaluateCoverageDataset(dataset, { split: "tune" })).integrity.freeze_complete, false);
});

test("legacy A final verification uses its own sent packet", async () => {
  const fullPacket = { schema: "learning-extraction-proposal/v2", snippets: [], events: [] };
  const legacyPacket = { ...fullPacket, snippets: [{ span_id: "s1", role: "user", text: "APIを使う。" }] };
  const dataset = { schema: "memory-extraction-coverage-evaluation/v1", cases: [{
    id: "a-packet", session_id: "a-session", split: "tune", category: "decision", labels_source: "human", provider: "openai", model: "gpt-5.6-sol", reasoning_effort: "medium",
    packet: fullPacket, gold: [{ id: "g1" }], variants: {
      A: { passes: [{ status: "succeeded", packet: legacyPacket, candidates: [candidate], usage: { input_tokens: 1, output_tokens: 1 } }], judgments: [judgment] },
      B: { passes: [], judgments: [] }, C: { passes: [], judgments: [] }
    }
  }] };
  dataset.freeze = coverageFreezeManifest(dataset);
  const report = await evaluateCoverageDataset(dataset, { split: "tune" });
  assert.equal(report.metrics.A.candidate_count, 1);
});

test("missing safety judgments and unknown gold IDs cannot complete evaluation", async () => {
  const dataset = { schema: "memory-extraction-coverage-evaluation/v1", cases: [{
    id: "c", session_id: "s", split: "tune", category: "decision", labels_source: "human",
    packet: { snippets: [{ span_id: "s1", role: "user", text: "APIを使う。" }], events: [] }, gold: [{ id: "g1" }],
    variants: Object.fromEntries(["A", "B", "C"].map((v) => [v, { passes: [{ status: "succeeded", candidates: [candidate], usage: { input_tokens: 1, output_tokens: 1 } }], judgments: [{ ...judgment, gold_ids: ["fabricated"] }] }]))
  }] };
  const report = await evaluateCoverageDataset(dataset, { split: "tune" });
  assert.equal(report.integrity.human_labels_complete, false);
  assert.equal(report.metrics.C.matched_gold_count, 0);
});

test("coverage evaluation stays incomplete without the sealed fixed split", async () => {
  const report = await evaluateCoverageDataset({
    schema: "memory-extraction-coverage-evaluation/v1",
    freeze: { prompt: "p", verifier: "v", model: "m" },
    cases: [{
      id: "case-1", split: "fixed", category: "decision", labels_source: "human",
      packet: { snippets: [{ span_id: "s1", role: "user", text: "APIを使う。" }], events: [] },
      gold: [{ id: "g1", tags: ["condition"] }],
      variants: Object.fromEntries(["A", "B", "C"].map((variant) => [variant, {
        passes: [{ status: "succeeded", usage: { input_tokens: 100, output_tokens: 10 }, candidates: [candidate] }],
        judgments: [judgment]
      }]))
    }]
  }, { split: "fixed" });
  assert.equal(report.status, "evaluation_incomplete");
  assert.equal(report.metrics.C.precision, 1);
  assert.equal(report.metrics.C.recall, 1);
  assert.equal(report.counts.valid, false);
  assert.match(report.freeze_hashes.dataset, /^sha256:[a-f0-9]{64}$/u);
});

test("usage unknown cannot satisfy the cost gate", async () => {
  const variants = Object.fromEntries(["A", "B", "C"].map((variant) => [variant, {
    passes: [{ status: "succeeded", usage: variant === "C" ? null : { input_tokens: 10, output_tokens: 2 }, candidates: [] }], judgments: []
  }]));
  const report = await evaluateCoverageDataset({ schema: "memory-extraction-coverage-evaluation/v1", cases: [{ id: "case", split: "tune", category: "non_persistent", labels_source: "human", packet: { snippets: [], events: [] }, gold: [], variants }] }, { split: "tune" });
  assert.equal(report.metrics.C.average_measured_tokens, null);
  assert.equal(report.gates.average_tokens_within_1_5x, false);
  assert.equal(report.status, "evaluation_incomplete");
});

test("missing passes and provider/model substitutions keep evaluation incomplete", async () => {
  const cases = Array.from({ length: 75 }, (_, index) => {
    const category = index < 15 ? "decision" : index < 30 ? "failure" : index < 45 ? "success" : "non_persistent";
    return {
      id: `case-${index}`,
      session_id: `session-${index}`,
      split: "tune",
      category,
      labels_source: "human",
      provider: "openai",
      model: "fixed-model",
      packet: { snippets: [], events: [] },
      gold: [],
      variants: {
        A: { passes: [{ status: "succeeded", provider: "openai", model: "fixed-model", usage: { input_tokens: 1, output_tokens: 1 }, candidates: [] }], judgments: [] },
        B: { passes: [{ status: "succeeded", provider: "openai", model: "substitute", usage: { input_tokens: 1, output_tokens: 1 }, candidates: [] }], judgments: [] },
        C: { passes: [], judgments: [] }
      }
    };
  });
  const report = await evaluateCoverageDataset({
    schema: "memory-extraction-coverage-evaluation/v1",
    freeze: { code: "c", prompt: "p", verifier: "v", execution_policy: "e", model_configuration: "m", data: "d", labels: "l" },
    cases
  }, { split: "tune" });
  assert.equal(report.counts.valid, true);
  assert.equal(report.integrity.variant_shape_complete, false);
  assert.equal(report.status, "evaluation_incomplete");
});
