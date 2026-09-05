import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AI_PREFILL_CONTRACT,
  prefillEvaluationBundle,
  validateBatchDrafts
} from "./memory-extraction-ai-draft-batch.mjs";

function bundle() {
  const text = "SQLiteを標準保存先として採用しました。";
  return {
    contract: "orgbrain-memory-extraction-evaluation/v1",
    set_id: "prefill-test",
    frozen_at: "2026-09-03T00:00:00.000Z",
    guideline_version: "test",
    cases: [{
      id: "case-1",
      phase: "calibration",
      cohort: "decision",
      source_hash: "sha256:old",
      turns: [
        { id: "s1", role: "assistant", content: text },
        { id: "s2", role: "assistant", content: `${text}\n<oai-mem-citation><citation_entries>MEMORY.md:1-2</citation_entries></oai-mem-citation>` }
      ]
    }]
  };
}

function response(items) {
  return {
    data: {
      drafts: items.map((item) => {
        const quote = "SQLiteを標準保存先として採用しました。";
        return {
          case_id: item.id,
          source_hash: item.source_hash,
          outcome: "candidate",
          usefulness: "durable_memory",
          lesson_types: ["decision"],
          support_spans: [{ turn_id: "s1", quote, start: 0, end: quote.length }],
          exclusion_reason: "",
          confidence: "high",
          rationale: "標準保存先を定めた再利用可能な決定です。"
        };
      })
    },
    usage: { total_tokens: 100 },
    runtime_evidence: "test"
  };
}

test("deduplicates, checkpoints, and embeds validated Sol high drafts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orgbrain-prefill-test-"));
  const checkpointPath = path.join(directory, "checkpoint.json");
  let calls = 0;
  const first = await prefillEvaluationBundle(bundle(), {
    checkpointPath,
    generatedAt: "2026-09-04T00:00:00.000Z",
    evaluateBatch: async (items) => {
      calls += 1;
      assert.equal(items[0].turns.length, 1);
      return response(items);
    }
  });
  assert.equal(calls, 1);
  assert.equal(first.bundle.ai_prefill.contract, AI_PREFILL_CONTRACT);
  assert.deepEqual(first.bundle.ai_prefill.runs, [{ model: "gpt-5.6-sol", reasoning_effort: "high", completed_cases: 1 }]);
  assert.deepEqual(first.bundle.cases[0].turn_aliases, { s2: "s1" });
  assert.equal(first.bundle.cases[0].turns.length, 1);
  assert.equal(first.bundle.cases[0].ai_draft.outcome, "candidate");
  assert.equal(fs.statSync(checkpointPath).mode & 0o777, 0o600);

  const resumed = await prefillEvaluationBundle(bundle(), {
    checkpointPath,
    generatedAt: "2026-09-04T00:00:00.000Z",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    evaluateBatch: async () => {
      calls += 1;
      throw new Error("checkpoint was not reused");
    }
  });
  assert.equal(calls, 1);
  assert.equal(resumed.bundle.cases[0].ai_draft.source_hash, first.bundle.cases[0].source_hash);
  assert.deepEqual(resumed.bundle.ai_prefill.runs, [{ model: "gpt-5.6-sol", reasoning_effort: "high", completed_cases: 1 }]);
});

test("records Luna max on newly generated drafts", async () => {
  const result = await prefillEvaluationBundle(bundle(), {
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    evaluateBatch: async (items) => response(items)
  });
  assert.equal(result.bundle.cases[0].ai_draft.model, "gpt-5.6-luna");
  assert.equal(result.bundle.cases[0].ai_draft.reasoning_effort, "max");
  assert.deepEqual(result.bundle.ai_prefill.runs, [{ model: "gpt-5.6-luna", reasoning_effort: "max", completed_cases: 1 }]);
});

test("evaluates independent batches with bounded concurrency", async () => {
  const input = bundle();
  input.cases = Array.from({ length: 4 }, (_, index) => ({
    ...input.cases[0],
    id: `case-${index + 1}`
  }));
  let active = 0;
  let maximum = 0;
  const result = await prefillEvaluationBundle(input, {
    batchSize: 1,
    concurrency: 2,
    evaluateBatch: async (items) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return response(items);
    }
  });
  assert.equal(maximum, 2);
  assert.equal(result.bundle.ai_prefill.completed_cases, 4);
});

test("rejects missing or foreign batch results", () => {
  const item = { id: "case-1", source_hash: "sha256:test", turns: [{ id: "s1", role: "assistant", content: "test" }] };
  assert.throws(() => validateBatchDrafts({ drafts: [] }, [item]), /count_mismatch/);
  assert.throws(() => validateBatchDrafts({ drafts: [{ case_id: "other", source_hash: "sha256:test" }] }, [item]), /identity_mismatch/);
});

test("restores requested order when complete case identities are returned out of order", () => {
  const input = bundle();
  const cases = [
    { ...input.cases[0], id: "case-1", source_hash: "sha256:1", turns: [{ id: "s1", role: "assistant", content: "SQLiteを標準保存先として採用しました。" }] },
    { ...input.cases[0], id: "case-2", source_hash: "sha256:2", turns: [{ id: "s1", role: "assistant", content: "SQLiteを標準保存先として採用しました。" }] }
  ];
  const drafts = response(cases).data.drafts.reverse();
  const result = validateBatchDrafts({ drafts }, cases);
  assert.deepEqual(result.map((item) => item.source_hash), ["sha256:1", "sha256:2"]);
});

test("rebinds a known unique case id to the frozen source hash", () => {
  const input = bundle();
  const cases = [{ ...input.cases[0], id: "case-1", source_hash: "sha256:frozen", turns: [{ id: "s1", role: "assistant", content: "SQLiteを標準保存先として採用しました。" }] }];
  const drafts = response(cases).data.drafts;
  drafts[0].source_hash = "sha256:model-copy-error";
  const [result] = validateBatchDrafts({ drafts }, cases);
  assert.equal(result.source_hash, "sha256:frozen");
});

test("repairs offsets only when the quoted text exists in the specified turn", () => {
  const text = "前半。採用しました。後半。";
  const item = { id: "case-1", source_hash: "sha256:test", turns: [{ id: "s1", role: "assistant", content: text }] };
  const base = {
    case_id: item.id,
    source_hash: item.source_hash,
    outcome: "candidate",
    usefulness: "durable_memory",
    lesson_types: ["decision"],
    exclusion_reason: "",
    confidence: "high",
    rationale: "再利用可能な決定です。"
  };
  const [draft] = validateBatchDrafts({ drafts: [{
    ...base,
    support_spans: [{ turn_id: "s1", quote: "採用しました。", start: 0, end: 1 }]
  }] }, [item]);
  assert.equal(draft.support_spans[0].start, text.indexOf("採用しました。"));
  assert.throws(() => validateBatchDrafts({ drafts: [{
    ...base,
    support_spans: [{ turn_id: "s1", quote: "存在しない引用", start: 0, end: 1 }]
  }] }, [item]), /support_span_mismatch/);
});
