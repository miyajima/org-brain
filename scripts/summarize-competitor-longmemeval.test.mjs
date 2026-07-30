import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { summarizeCompetitorLongMemEval } from "./summarize-competitor-longmemeval.mjs";

test("summarizes GBrain and MemPalace row shapes with strict completeness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-competitor-summary-"));
  try {
    const dataset = join(directory, "dataset.json");
    const gbrain = join(directory, "gbrain.jsonl");
    const mempalace = join(directory, "mempalace.jsonl");
    const output = join(directory, "output");
    await writeFile(dataset, "[]\n");
    await writeFile(gbrain, `${JSON.stringify({
      question_id: "q1",
      question_type: "temporal-reasoning",
      hit_at_k: true,
      latency_ms: 12
    })}\n`);
    await writeFile(mempalace, `${JSON.stringify({
      question_id: "q2",
      question_type: "preference",
      retrieval_results: { metrics: { session: { "recall_any@5": 0 } } }
    })}\n`);

    const summary = await summarizeCompetitorLongMemEval({
      adapter: "fixture",
      revision: "abc123",
      dataset,
      inputs: [gbrain, mempalace],
      outputDirectory: output,
      expected: 2,
      executionProfile: "fixed test profile"
    });

    assert.equal(summary.questions, 2);
    assert.equal(summary.hits, 1);
    assert.equal(summary.recall_at_5, 50);
    assert.equal(summary.latency_ms.p95, 12);
    assert.equal(summary.execution_profile, "fixed test profile");
    assert.deepEqual(summary.failure_question_ids, ["q2"]);
    assert.match(await readFile(join(output, "rows.jsonl"), "utf8"), /"source_file"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing rows instead of publishing a partial score", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-competitor-summary-"));
  try {
    const dataset = join(directory, "dataset.json");
    const input = join(directory, "rows.jsonl");
    await writeFile(dataset, "[]\n");
    await writeFile(input, `${JSON.stringify({
      question_id: "q1",
      question_type: "temporal-reasoning",
      hit_at_k: true
    })}\n`);
    await assert.rejects(
      summarizeCompetitorLongMemEval({
        adapter: "fixture",
        revision: "abc123",
        dataset,
        inputs: [input],
        outputDirectory: join(directory, "output"),
        expected: 2
      }),
      /expected 2 rows, found 1/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
