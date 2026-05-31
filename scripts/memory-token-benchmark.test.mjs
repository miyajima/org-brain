import { describe, expect, it } from "vitest";
import {
  buildFullContextPrompt,
  buildTreatmentPrompt,
  buildTransientBenchmarkIndex,
  computeRecallAtK,
  computeTokenReduction,
  createBenchmarkChunks,
  estimateTokens,
  parseLongMemEvalDataset,
  retrieveFromTransientBenchmarkIndex,
  summarizeBenchmarkResults
} from "./lib/memory-token-benchmark-core.mjs";

describe("memory token benchmark helpers", () => {
  it("normalizes LongMemEval JSON arrays", () => {
    const raw = JSON.stringify([
      {
        question_id: "q-1",
        question_type: "single-session-user",
        question: "What date did Alex buy the notebook?",
        answer: "March 3",
        haystack_sessions: [
          { session_date: "2026/03/03", session_text: "user: I bought a notebook on March 3." }
        ]
      }
    ]);

    expect(parseLongMemEvalDataset(raw)).toEqual([
      {
        id: "q-1",
        category: "single-session-user",
        question: "What date did Alex buy the notebook?",
        answer: "March 3",
        historyText: "user: I bought a notebook on March 3."
      }
    ]);
  });

  it("normalizes JSONL with alternate field names", () => {
    const raw = [
      JSON.stringify({
        qid: "alt-1",
        type: "temporal-reasoning",
        query: "Which plan is newer?",
        gold_answer: "The May plan",
        messages: [
          { role: "user", content: "In April I chose plan A." },
          { role: "assistant", content: "Noted." },
          { role: "user", content: "In May I switched to plan B." }
        ]
      }),
      JSON.stringify({
        id: "alt-2",
        task: "multi-session",
        input: { question: "Where was the receipt stored?", history: "user: The receipt is in Dropbox." },
        output: { answer: "Dropbox" }
      })
    ].join("\n");

    const items = parseLongMemEvalDataset(raw);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "alt-1",
      category: "temporal-reasoning",
      question: "Which plan is newer?",
      answer: "The May plan"
    });
    expect(items[0].historyText).toContain("user: In April I chose plan A.");
    expect(items[1]).toMatchObject({
      id: "alt-2",
      category: "multi-session",
      question: "Where was the receipt stored?",
      answer: "Dropbox",
      historyText: "user: The receipt is in Dropbox."
    });
  });

  it("computes token estimates and reductions without clamping negative savings", () => {
    expect(estimateTokens("12345")).toBe(2);
    expect(computeTokenReduction(100, 40)).toEqual({
      full_context_tokens: 100,
      org_brain_context_tokens: 40,
      tokens_saved: 60,
      token_reduction_rate: 0.6
    });
    expect(computeTokenReduction(0, 10)).toEqual({
      full_context_tokens: 0,
      org_brain_context_tokens: 10,
      tokens_saved: -10,
      token_reduction_rate: 0
    });
    expect(computeTokenReduction(10, 12)).toEqual({
      full_context_tokens: 10,
      org_brain_context_tokens: 12,
      tokens_saved: -2,
      token_reduction_rate: -0.2
    });
  });

  it("builds baseline and treatment prompts from normalized items", () => {
    const item = {
      id: "q-1",
      category: "single",
      question: "What should happen?",
      answer: "Use memory",
      historyText: "user: Please use memory next time."
    };

    expect(buildFullContextPrompt(item)).toContain("Conversation history:");
    expect(buildFullContextPrompt(item)).toContain("user: Please use memory next time.");
    const treatment = buildTreatmentPrompt(item, [
      { kind: "memory", id: "mem-1", project_id: "org-brain", source: "codex", summary: "Use memory", content_preview: "A compact memory." }
    ]);
    expect(treatment).toContain("memory:mem-1 project=org-brain source=codex");
    expect(treatment).toContain("A compact memory.");
  });

  it("chunks LongMemEval history and retrieves relevant transient contexts", () => {
    const items = [
      {
        id: "q-1",
        category: "single",
        question: "Which notebook color did Mia buy?",
        answer: "blue",
        historyText: "user: Mia bought a blue notebook.\n\nuser: Alex bought a red pen."
      },
      {
        id: "q-2",
        category: "single",
        question: "Where is the receipt?",
        answer: "Dropbox",
        historyText: "user: The receipt is stored in Dropbox."
      }
    ];

    expect(createBenchmarkChunks(items[0], { chunkCharLimit: 40 })).toHaveLength(2);
    const index = buildTransientBenchmarkIndex(items, { chunkCharLimit: 80 });
    const retrieval = retrieveFromTransientBenchmarkIndex(index, items[0], { topK: 5 });
    expect(retrieval.returned_count).toBeGreaterThan(0);
    expect(retrieval.contexts[0].content_preview).toContain("blue notebook");
    expect(computeRecallAtK(items[0].answer, retrieval.contexts)).toBe(true);
  });

  it("summarizes accuracy, token reduction, categories, and fallbacks", () => {
    const summary = summarizeBenchmarkResults(
      [
        {
          category: "single",
          full_context_tokens: 100,
          org_brain_context_tokens: 30,
          tokens_saved: 70,
          retrieval_count: 2,
          retrieval_latency_ms: 10,
          fallback_used: false,
          recall_at_5: true,
          judge: { verdict: "pass", passed: true }
        },
        {
          category: "single",
          full_context_tokens: 80,
          org_brain_context_tokens: 40,
          tokens_saved: 40,
          retrieval_count: 0,
          retrieval_latency_ms: 5,
          fallback_used: true,
          recall_at_5: false,
          judge: { verdict: "fail", passed: false }
        },
        {
          category: "multi",
          full_context_tokens: 50,
          org_brain_context_tokens: 25,
          tokens_saved: 25,
          retrieval_count: 1,
          retrieval_latency_ms: 15,
          fallback_used: false,
          recall_at_5: null,
          judge: { verdict: "not_run", passed: null }
        }
      ],
      [{ id: "run-1", input_tokens_saved: 2036 }]
    );

    expect(summary).toMatchObject({
      item_count: 3,
      judged_count: 2,
      judge_pass_count: 1,
      accuracy: 0.5,
      recall_eligible_count: 2,
      recall_at_5_pass_count: 1,
      recall_at_5: 0.5,
      full_context_tokens: 230,
      org_brain_context_tokens: 95,
      tokens_saved: 135,
      retrieval_count: 3,
      retrieval_latency_ms: 30,
      fallback_count: 1
    });
    expect(summary.categories.find((category) => category.category === "single")).toMatchObject({
      item_count: 2,
      judged_count: 2,
      judge_pass_count: 1,
      fallback_count: 1,
      recall_eligible_count: 2,
      recall_at_5_pass_count: 1,
      recall_at_5: 0.5
    });
    expect(summary.existing_measurement_runs).toEqual([{ id: "run-1", input_tokens_saved: 2036 }]);
  });
});
