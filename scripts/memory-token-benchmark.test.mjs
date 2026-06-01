import { describe, expect, it } from "vitest";
import {
  applyTreatmentTokenBudget,
  buildEvidenceCardsForItem,
  buildFullContextPrompt,
  buildPublicComparisonReport,
  buildTreatmentPrompt,
  buildTransientBenchmarkIndex,
  computeAnswerTextHitAtK,
  computeEvidenceCoverageAtK,
  computeEvidenceRecallAtK,
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
      expect.objectContaining({
        id: "q-1",
        category: "single-session-user",
        question: "What date did Alex buy the notebook?",
        answer: "March 3",
        historyText: "user: I bought a notebook on March 3.",
        question_date: "",
        answer_session_ids: [],
        haystack_session_ids: [],
        haystack_dates: []
      })
    ]);
    expect(parseLongMemEvalDataset(raw)[0].historySessions).toEqual([
      expect.objectContaining({
        session_id: "q-1:session:1",
        session_index: 0,
        content: "user: I bought a notebook on March 3."
      })
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

  it("preserves LongMemEval session metadata without indexing answer session ids", () => {
    const raw = JSON.stringify([
      {
        question_id: "meta-1",
        question_type: "temporal-reasoning",
        question_date: "2023/01/03 (Tue) 10:00",
        question: "Which museum did I visit first?",
        answer: "MoMA",
        answer_session_ids: ["answer-session"],
        haystack_session_ids: ["answer-session", "distractor-session"],
        haystack_dates: ["2023/01/01 (Sun) 09:00", "2023/01/02 (Mon) 09:00"],
        haystack_sessions: [
          [{ role: "user", content: "I visited MoMA today." }],
          [{ role: "user", content: "I visited the park today." }]
        ]
      }
    ]);

    const [item] = parseLongMemEvalDataset(raw);
    expect(item).toMatchObject({
      question_date: "2023/01/03 (Tue) 10:00",
      answer_session_ids: ["answer-session"],
      haystack_session_ids: ["answer-session", "distractor-session"],
      haystack_dates: ["2023/01/01 (Sun) 09:00", "2023/01/02 (Mon) 09:00"]
    });
    const index = buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v2" });
    expect(index.chunks[0]).toMatchObject({
      session_id: "answer-session",
      session_date: "2023/01/01 (Sun) 09:00"
    });
    expect(index.chunks.map((chunk) => chunk.search_text).join("\n")).not.toContain("answer-session");
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
    const index = buildTransientBenchmarkIndex(items, { chunkCharLimit: 80, transientStrategy: "bm25_lite_v1" });
    const retrieval = retrieveFromTransientBenchmarkIndex(index, items[0], { topK: 5, transientStrategy: "bm25_lite_v1" });
    expect(retrieval.returned_count).toBeGreaterThan(0);
    expect(retrieval.contexts[0].content_preview).toContain("blue notebook");
    expect(computeRecallAtK(items[0].answer, retrieval.contexts)).toBe(true);
  });

  it("retrieves temporal evidence from distinct session-aware chunks", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "temporal-1",
        question_type: "temporal-reasoning",
        question: "Which happened first: visiting MoMA or seeing the Ancient Civilizations exhibit?",
        answer: "Visiting MoMA happened first.",
        answer_session_ids: ["moma-session", "met-session"],
        haystack_session_ids: ["recipe-session", "moma-session", "met-session"],
        haystack_dates: ["2023/01/01", "2023/01/08", "2023/01/15"],
        haystack_sessions: [
          [{ role: "user", content: "I cooked dinner." }],
          [{ role: "user", content: "I visited the Museum of Modern Art MoMA." }],
          [{ role: "user", content: "I saw the Ancient Civilizations exhibit at the Metropolitan Museum of Art." }]
        ]
      }
    ]));

    const index = buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v2" });
    const retrieval = retrieveFromTransientBenchmarkIndex(index, item, { transientStrategy: "longmemeval_session_v2", topK: 5 });
    expect(retrieval.contexts.map((context) => context.session_id)).toEqual(expect.arrayContaining(["moma-session", "met-session"]));
    expect(computeEvidenceRecallAtK(item, retrieval.contexts)).toBe(true);
    expect(computeEvidenceCoverageAtK(item, retrieval.contexts)).toBe(1);
  });

  it("diversifies multi-session evidence instead of returning one repeated session", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "multi-1",
        question_type: "multi-session",
        question: "How many model kits have I worked on or bought?",
        answer: "Three model kits.",
        answer_session_ids: ["kit-a", "kit-b", "kit-c"],
        haystack_session_ids: ["kit-a", "paint", "kit-b", "unrelated", "kit-c"],
        haystack_dates: ["2023/01/01", "2023/01/02", "2023/01/03", "2023/01/04", "2023/01/05"],
        haystack_sessions: [
          [{ role: "user", content: "I bought a Revell F-15 model kit." }],
          [{ role: "user", content: "I need advice on paint brushes." }],
          [{ role: "user", content: "I worked on a Tamiya Spitfire model kit." }],
          [{ role: "user", content: "What is the capital of France?" }],
          [{ role: "user", content: "I bought a German Tiger tank model kit." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v2" }),
      item,
      { transientStrategy: "longmemeval_session_v2", topK: 5 }
    );
    expect(new Set(retrieval.contexts.map((context) => context.session_id)).size).toBeGreaterThanOrEqual(3);
    expect(computeEvidenceCoverageAtK(item, retrieval.contexts)).toBe(1);
  });

  it("separates preference evidence recall from literal answer text hits", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "pref-1",
        question_type: "single-session-preference",
        question: "Can you recommend resources where I can learn more about video editing?",
        answer: "The user prefers Adobe Premiere Pro resources about advanced settings.",
        answer_session_ids: ["premiere-session"],
        haystack_session_ids: ["generic-session", "premiere-session"],
        haystack_dates: ["2023/05/20", "2023/05/21"],
        haystack_sessions: [
          [{ role: "assistant", content: "General video editing courses are available." }],
          [{ role: "user", content: "I currently use Adobe Premiere Pro and want to understand advanced settings." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v2" }),
      item,
      { transientStrategy: "longmemeval_session_v2", topK: 5 }
    );
    expect(retrieval.contexts.map((context) => context.session_id)).toContain("premiere-session");
    expect(computeEvidenceRecallAtK(item, retrieval.contexts)).toBe(true);
    expect(computeAnswerTextHitAtK(item.answer, retrieval.contexts)).toBe(false);
  });

  it("builds v3 evidence cards without using answer session ids as scoring input", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "card-1",
        question_type: "single-session-preference",
        question: "Can you recommend resources for medical image analysis?",
        answer: "Deep learning for medical image analysis.",
        answer_session_ids: ["gold-secret-session"],
        haystack_session_ids: ["medical-session", "generic-session"],
        haystack_dates: ["2023/05/21", "2023/05/22"],
        haystack_sessions: [
          [{ role: "user", content: "I work in deep learning for medical image analysis and want advanced research updates." }],
          [{ role: "assistant", content: "General AI conferences are popular." }]
        ]
      }
    ]));

    const cards = buildEvidenceCardsForItem(item);
    expect(cards[0]).toMatchObject({
      session_id: "medical-session",
      date: "2023/05/21",
      speaker: "user"
    });
    const renderedPrompt = buildTreatmentPrompt(item, [
      {
        kind: "memory",
        id: "card",
        source: "transient-evidence-card-index",
        content_preview: "placeholder",
        evidence_card: cards[0],
        session_id: cards[0].session_id
      }
    ], { answererProfile: "specialist_router_v1" });
    expect(renderedPrompt).not.toContain("gold-secret-session");
    expect(renderedPrompt).not.toContain("session_id=medical-session");
    expect(renderedPrompt).toContain("medical image analysis");
  });

  it("retrieves v3 temporal evidence with date-normalized cards", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "temporal-v3",
        question_type: "temporal-reasoning",
        question_date: "2023/06/24 (Sat) 12:00",
        question: "I mentioned participating in a sports event two weeks ago. What was the event?",
        answer: "Midsummer 5K Run.",
        answer_session_ids: ["run-session"],
        haystack_session_ids: ["bike-session", "run-session", "soccer-session"],
        haystack_dates: ["2023/06/02", "2023/06/10", "2023/06/17"],
        haystack_sessions: [
          [{ role: "user", content: "I completed the Spring Sprint Triathlon today." }],
          [{ role: "user", content: "I finished a 5K run at the Midsummer 5K Run today." }],
          [{ role: "user", content: "I participate in the annual charity soccer tournament today." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    expect(retrieval.contexts[0].session_id).toBe("run-session");
    expect(computeEvidenceRecallAtK(item, retrieval.contexts)).toBe(true);
  });

  it("keeps v3 multi-session cards diverse and compact", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "multi-v3",
        question_type: "multi-session",
        question: "How many times did I bake something in the past two weeks?",
        answer: "Three.",
        answer_session_ids: ["bread", "cake", "wings"],
        haystack_session_ids: ["bread", "generic", "cake", "wings"],
        haystack_dates: ["2023/05/20", "2023/05/21", "2023/05/25", "2023/05/28"],
        haystack_sessions: [
          [{ role: "user", content: "I tried a sourdough bread recipe on Tuesday." }],
          [{ role: "assistant", content: "Baking can be fun for many people." }],
          [{ role: "user", content: "I baked a chocolate cake for my sister." }],
          [{ role: "user", content: "I am baking chicken wings tonight." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    expect([...new Set(retrieval.contexts.map((context) => context.session_id))]).toEqual(expect.arrayContaining(["bread", "cake", "wings"]));
    const budgeted = applyTreatmentTokenBudget(item, retrieval.contexts, { tokenBudget: 260, answererProfile: "specialist_router_v1" });
    expect(estimateTokens(buildTreatmentPrompt(item, budgeted, { answererProfile: "specialist_router_v1" }))).toBeLessThanOrEqual(260);
  });

  it("builds public comparison reports with leaderboard targets", () => {
    const report = buildPublicComparisonReport({
      accuracy: 0.86,
      evidence_recall_at_5: 0.982,
      recall_at_5: 0.982,
      token_reduction_rate: 0.992,
      fallback_rate: 0
    }, { profile: "org_brain_repro_v3" });
    expect(report.leaderboard_targets).toMatchObject({
      profile: "org_brain_repro_v3",
      accuracy: 0.86
    });
    expect(report.rows[0]).toMatchObject({
      system: "Org Brain current run",
      profile: "org_brain_repro_v3"
    });
    expect(report.comparison_rank_estimate.target_pass).toMatchObject({
      accuracy: true,
      evidence_recall_at_5: true,
      token_reduction_rate: true,
      fallback_rate: true
    });
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
          evidence_recall_at_5: true,
          evidence_coverage_at_5: 1,
          answer_text_hit_at_5: true,
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
          evidence_recall_at_5: false,
          evidence_coverage_at_5: 0,
          answer_text_hit_at_5: false,
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
          evidence_recall_at_5: null,
          evidence_coverage_at_5: null,
          answer_text_hit_at_5: null,
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
      evidence_recall_at_5: 0.5,
      answer_text_hit_at_5: 0.5,
      evidence_coverage_at_5: 0.5,
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
