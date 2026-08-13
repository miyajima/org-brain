import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { evaluateRetrievalGold } from "../src/retrieval-gold-eval.mjs";

describe("v4 gold retrieval gate", () => {
  it("requires at least 20 questions, Recall@5 >= 0.90, MRR >= 0.75, and no empty known theme", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/memory-retrieval-gold-v4.json", import.meta.url),
      "utf8"
    ));
    const report = evaluateRetrievalGold(fixture.questions.map((question: any) => ({
      ...question,
      returned_ids: [question.expected_ids[0]]
    })));
    expect(report).toMatchObject({
      question_count: 20,
      recall_at_5: 1,
      mrr: 1,
      empty_result_count: 0,
      passed: true
    });
  });

  it("fails a known-theme empty result", () => {
    const report = evaluateRetrievalGold(Array.from({ length: 20 }, (_, index) => ({
      id: `q${index}`,
      expected_ids: [`m${index}`],
      returned_ids: index === 0 ? [] : [`m${index}`]
    })));
    expect(report.passed).toBe(false);
    expect(report.empty_result_count).toBe(1);
  });
});
