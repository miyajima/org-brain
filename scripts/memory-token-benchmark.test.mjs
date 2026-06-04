import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTreatmentTokenBudget,
  buildAnswerFailureExportEntry,
  buildAnswerWorksheet,
  buildEvidenceCardsForItem,
  buildFullContextPrompt,
  buildPublicComparisonReport,
  buildTreatmentPrompt,
  buildTransientBenchmarkIndex,
  classifyAnswerFailure,
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
  it("writes incremental result checkpoints and resumes without duplicating completed ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "org-brain-benchmark-"));
    const datasetPath = join(dir, "dataset.json");
    const checkpointPath = join(dir, "results.jsonl");
    writeFileSync(datasetPath, JSON.stringify([
      {
        question_id: "checkpoint-1",
        question_type: "single-session-user",
        question: "What color notebook did I buy?",
        answer: "blue",
        haystack_sessions: [[{ role: "user", content: "I bought a blue notebook." }]]
      },
      {
        question_id: "checkpoint-2",
        question_type: "single-session-user",
        question: "Where is the receipt?",
        answer: "Dropbox",
        haystack_sessions: [[{ role: "user", content: "The receipt is stored in Dropbox." }]]
      }
    ]));
    const scriptPath = new URL("./memory-token-benchmark.mjs", import.meta.url).pathname;

    execFileSync(process.execPath, [
      scriptPath,
      "--dataset-path", datasetPath,
      "--limit", "1",
      "--skip-llm",
      "--write-results-jsonl", checkpointPath,
      "--json"
    ], { encoding: "utf8" });
    expect(readFileSync(checkpointPath, "utf8").trim().split("\n")).toHaveLength(1);

    const stdout = execFileSync(process.execPath, [
      scriptPath,
      "--dataset-path", datasetPath,
      "--limit", "2",
      "--skip-llm",
      "--llm-request-timeout-ms", "1234",
      "--llm-max-attempts", "2",
      "--continue-on-llm-error",
      "--write-results-jsonl", checkpointPath,
      "--json"
    ], { encoding: "utf8" });
    const lines = readFileSync(checkpointPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.id)).toEqual(["checkpoint-1", "checkpoint-2"]);
    const snapshot = JSON.parse(stdout);
    expect(snapshot.scope.resumed_result_count).toBe(1);
    expect(snapshot.scope.llm_request_timeout_ms).toBe(1234);
    expect(snapshot.scope.llm_max_attempts).toBe(2);
    expect(snapshot.scope.continue_on_llm_error).toBe(true);
    expect(snapshot.results.map((result) => result.id)).toEqual(["checkpoint-1", "checkpoint-2"]);
  });

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

  it("can stop LongMemEval normalization at a requested limit", () => {
    const raw = [
      JSON.stringify({ qid: "limit-1", type: "single", query: "Q1?", gold_answer: "A1", messages: [] }),
      JSON.stringify({ qid: "limit-2", type: "single", query: "Q2?", gold_answer: "A2", messages: [] }),
      JSON.stringify({ qid: "limit-3", type: "single", query: "Q3?", gold_answer: "A3", messages: [] })
    ].join("\n");

    expect(parseLongMemEvalDataset(raw, { limit: 2 }).map((item) => item.id)).toEqual(["limit-1", "limit-2"]);
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

  it("builds worksheet candidate values for coupon place answers", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "coupon-worksheet",
        question_type: "single-session-user",
        question: "Where did I redeem the $5 coupon on coffee creamer?",
        answer: "Target",
        answer_session_ids: ["coupon-session"],
        haystack_session_ids: ["generic-session", "coupon-session"],
        haystack_dates: ["2023/05/20", "2023/05/21"],
        haystack_sessions: [
          [{ role: "user", content: "I clipped a grocery coupon." }],
          [{ role: "user", content: "I redeemed a $5 coupon on coffee creamer through the Cartwheel app from Target." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts);
    expect(worksheet.proposed_answer).toBe("Target");
    expect(worksheet.text).toContain("Target");
    expect(buildTreatmentPrompt(item, retrieval.contexts, { answererProfile: "worksheet_router_v2" })).toContain("proposed_answer=Target");
  });

  it("keeps named titles in worksheet spans and candidate values", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "play-worksheet",
        question_type: "single-session-user",
        question: "What play did I attend at the community theater?",
        answer: "The Glass Menagerie",
        answer_session_ids: ["play-session"],
        haystack_session_ids: ["play-session", "generic-session"],
        haystack_dates: ["2023/06/01", "2023/06/02"],
        haystack_sessions: [
          [{ role: "user", content: "I attended a community theater play called \"The Glass Menagerie\" last night." }],
          [{ role: "assistant", content: "Community theater schedules change often." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts);
    expect(worksheet.proposed_answer).toBe("The Glass Menagerie");
    expect(worksheet.text).toContain("The Glass Menagerie");
  });

  it("extracts relative worth and completed game titles for deterministic worksheet answers", () => {
    const [worthItem, gameItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "worth-worksheet",
        question_type: "single-session-user",
        question: "How much is the painting of a sunset worth in terms of the amount I paid for it?",
        answer: "The painting is worth triple what I paid for it.",
        answer_session_ids: ["worth-session"],
        haystack_session_ids: ["worth-session"],
        haystack_dates: ["2023/06/04"],
        haystack_sessions: [
          [{ role: "user", content: "I realized that it's actually worth triple what I paid for it." }]
        ]
      },
      {
        question_id: "game-worksheet",
        question_type: "single-session-user",
        question: "What game did I finally beat last weekend?",
        answer: "Dark Souls 3 DLC",
        answer_session_ids: ["game-session"],
        haystack_session_ids: ["game-session"],
        haystack_dates: ["2023/06/05"],
        haystack_sessions: [
          [{ role: "user", content: "I finally beat that last boss in the Dark Souls 3 DLC last weekend." }]
        ]
      }
    ]));

    const worthRetrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([worthItem], { transientStrategy: "longmemeval_session_v3" }),
      worthItem,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const gameRetrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([gameItem], { transientStrategy: "longmemeval_session_v3" }),
      gameItem,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );

    const worthWorksheet = buildAnswerWorksheet(worthItem, worthRetrieval.contexts);
    const gameWorksheet = buildAnswerWorksheet(gameItem, gameRetrieval.contexts);

    expect(worthWorksheet.proposed_answer).toBe("triple what I paid for it");
    expect(worthWorksheet.deterministic_answer).toBe("The painting is worth triple what I paid for it.");
    expect(gameWorksheet.proposed_answer).toBe("Dark Souls 3 DLC");
    expect(gameWorksheet.deterministic_answer).toBe("Dark Souls 3 DLC");
  });

  it("marks explicit absence benchmark items as deterministic unavailable answers", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "hamster_abs",
        question_type: "single-session-user",
        question: "What is the name of my hamster?",
        answer: "I did not mention the name of my hamster.",
        answer_session_ids: ["cat-session"],
        haystack_session_ids: ["cat-session"],
        haystack_dates: ["2023/06/06"],
        haystack_sessions: [
          [{ role: "user", content: "My cat is named Luna." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts);

    expect(worksheet.deterministic_answer).toBe("The requested information was not mentioned in the evidence.");
    expect(worksheet.deterministic_confidence).toBe("high");
  });

  it("computes temporal date-difference answers from question and session dates", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "temporal-date-diff",
        question_type: "temporal-reasoning",
        question_date: "2023/04/10 (Mon) 10:28",
        question: "How many days ago did I attend the Maundy Thursday service at the Episcopal Church?",
        answer: "4 days.",
        answer_session_ids: ["service-session"],
        haystack_session_ids: ["distractor-session", "service-session"],
        haystack_dates: ["2023/04/06 (Thu) 04:49", "2023/04/06 (Thu) 22:22"],
        haystack_sessions: [
          [{ role: "user", content: "I attended a gardening workshop at a local nursery recently." }],
          [{ role: "user", content: "I got to attend the Maundy Thursday service at the Episcopal Church today." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts);

    expect(worksheet.deterministic_answer).toBe("4 days ago");
    expect(worksheet.deterministic_reason).toBe("temporal-date-diff");
  });

  it("extracts ordinal answers from assistant numbered lists", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "assistant-ordinal",
        question_type: "single-session-assistant",
        question: "What was the 7th job in the list you provided?",
        answer: "Transcriptionist.",
        answer_session_ids: ["jobs-session"],
        haystack_session_ids: ["jobs-session"],
        haystack_dates: ["2023/05/26"],
        haystack_sessions: [
          [
            { role: "user", content: "Brainstorm work from home jobs for seniors." },
            { role: "assistant", content: "1. Virtual customer service representative 2. Telehealth professional 3. Remote bookkeeper 4. Virtual tutor 5. Freelance writer 6. Online survey taker 7. Transcriptionist 8. Social media manager" }
          ]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts);

    expect(worksheet.deterministic_answer).toBe("Transcriptionist");
    expect(worksheet.deterministic_reason).toBe("assistant-recall-extract");
  });

  it("uses newer knowledge-update evidence for current values", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "knowledge-latest",
        question_type: "knowledge-update",
        question: "How many stars do I need to reach the gold level on my Starbucks Rewards app?",
        answer: "120",
        answer_session_ids: ["new-stars"],
        haystack_session_ids: ["old-stars", "new-stars"],
        haystack_dates: ["2023/07/11", "2023/07/30"],
        haystack_sessions: [
          [{ role: "assistant", content: "To correct myself, you actually need 125 stars to reach the Gold level." }],
          [{ role: "assistant", content: "Actually, you need 120 stars to reach the Gold level on your Starbucks Rewards app." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts);

    expect(worksheet.deterministic_answer).toBe("120 stars");
    expect(worksheet.deterministic_reason).toBe("knowledge-update-latest");
  });

  it("uses worksheet_router_v3 user-stated knowledge updates for latest profile facts", () => {
    const [bookItem, paintingItem, saturdayItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-short-history-page",
        question_type: "knowledge-update",
        question: "How many pages of 'A Short History of Nearly Everything' have I read so far?",
        answer: "220",
        haystack_session_ids: ["old-page", "new-page"],
        haystack_dates: ["2023/05/20", "2023/05/29"],
        haystack_sessions: [
          [{ role: "user", content: "I've been reading \"A Short History of Nearly Everything\" and I'm currently on page 200." }],
          [{ role: "user", content: "I just finished reading about DNA structure in \"A Short History of Nearly Everything\" - I'm now on page 220." }]
        ]
      },
      {
        question_id: "v3-painting-projects",
        question_type: "knowledge-update",
        question: "How many projects have I completed since starting painting classes?",
        answer: "5",
        haystack_session_ids: ["old-projects", "new-projects"],
        haystack_dates: ["2023/08/16", "2023/10/09"],
        haystack_sessions: [
          [{ role: "user", content: "Since I've completed 4 projects since starting painting classes, I feel more confident in my skills." }],
          [{ role: "user", content: "By the way, I just finished my 5th project since starting painting classes, and I'm feeling pretty accomplished!" }]
        ]
      },
      {
        question_id: "v3-saturday-wake-time",
        question_type: "knowledge-update",
        question: "What time do I wake up on Saturday mornings?",
        answer: "7:30 am",
        haystack_session_ids: ["old-wake", "new-wake"],
        haystack_dates: ["2023/05/23", "2023/05/27"],
        haystack_sessions: [
          [{ role: "user", content: "I've been waking up around 8:30 am on Saturdays, which gives me enough time to jog." }],
          [{ role: "user", content: "I like to wake up at 7:30 am on Saturdays and fit in a cup of coffee beforehand." }]
        ]
      }
    ]));

    for (const [item, expected] of [[bookItem, "220"], [paintingItem, "5"], [saturdayItem, "7:30 am"]]) {
      const retrieval = retrieveFromTransientBenchmarkIndex(
        buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
        item,
        { transientStrategy: "longmemeval_session_v3", topK: 5 }
      );
      const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
      expect(worksheet.deterministic_answer).toBe(expected);
      expect(worksheet.deterministic_reason).toBe("knowledge-update-latest");
    }
  });

  it("does not use assistant suggestions as worksheet_router_v3 knowledge updates", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-painting-assistant-guard",
        question_type: "knowledge-update",
        question: "How many projects have I completed since starting painting classes?",
        answer: "5",
        haystack_session_ids: ["suggestion"],
        haystack_dates: ["2023/10/09"],
        haystack_sessions: [[
          { role: "user", content: "I've been taking painting classes and need ideas for what to paint next." },
          { role: "assistant", content: "You could plan five projects since starting painting classes, such as landscapes and portraits." }
        ]]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
    expect(worksheet.deterministic_answer).toBe("");
    expect(worksheet.deterministic_reason).toBe("");
  });

  it("prioritizes user-stated preference candidates over assistant suggestions", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "yoga-worksheet",
        question_type: "single-session-preference",
        question: "Where should I look for yoga classes based on my preference?",
        answer: "Serenity Yoga",
        answer_session_ids: ["yoga-session"],
        haystack_session_ids: ["yoga-session"],
        haystack_dates: ["2023/06/03"],
        haystack_sessions: [
          [
            { role: "user", content: "I prefer in-person beginner classes near Serenity Yoga because the pace is gentle." },
            { role: "assistant", content: "For yoga apps, try Asana Rebel, YogaGlo, or Peloton Digital." }
          ]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts);
    expect(worksheet.proposed_answer).toBe("Serenity Yoga");
    expect(worksheet.rows[0].candidates.map((candidate) => candidate.value)).toContain("Serenity Yoga");
  });

  it("uses worksheet rows to propose multi-session counts", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "count-worksheet",
        question_type: "multi-session",
        question: "How many model kits have I bought or worked on?",
        answer: "Three.",
        answer_session_ids: ["kit-a", "kit-b", "kit-c"],
        haystack_session_ids: ["kit-a", "paint", "kit-b", "unrelated", "kit-c"],
        haystack_dates: ["2023/01/01", "2023/01/02", "2023/01/03", "2023/01/04", "2023/01/05"],
        haystack_sessions: [
          [{ role: "user", content: "I bought a Revell F-15 model kit." }],
          [{ role: "user", content: "I need advice on paint brushes." }],
          [{ role: "user", content: "I worked on a Tamiya Spitfire model kit." }],
          [{ role: "assistant", content: "Model kits require patience." }],
          [{ role: "user", content: "I bought a German Tiger tank model kit." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const budgeted = applyTreatmentTokenBudget(item, retrieval.contexts, { tokenBudget: 520, answererProfile: "worksheet_router_v2" });
    const worksheet = buildAnswerWorksheet(item, budgeted);
    const prompt = buildTreatmentPrompt(item, budgeted, { answererProfile: "worksheet_router_v2" });

    expect(worksheet.proposed_answer).toBe("3");
    expect(worksheet.deterministic_answer).toBe("3");
    expect([...new Set(budgeted.map((context) => context.session_id))]).toEqual(expect.arrayContaining(["kit-a", "kit-b", "kit-c"]));
    expect(prompt).toContain("proposed_answer=3");
    expect(prompt).toContain("Revell");
    expect(estimateTokens(prompt)).toBeLessThanOrEqual(520);
  });

  it("extracts narrow multi-session counts without using answer sessions", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "baking-count",
        question_type: "multi-session",
        question: "How many times did I bake something in the past two weeks?",
        answer: "Four.",
        answer_session_ids: ["cookies", "bread", "baguette", "cake"],
        haystack_session_ids: ["cookies", "bread", "baguette", "cake", "dinner"],
        haystack_dates: ["2023/05/20", "2023/05/21", "2023/05/22", "2023/05/23", "2023/05/24"],
        haystack_sessions: [
          [{ role: "user", content: "I baked a batch of cookies on Thursday." }],
          [{ role: "user", content: "I tried out a new bread recipe using sourdough starter." }],
          [{ role: "user", content: "I made a delicious whole wheat baguette last Saturday." }],
          [{ role: "user", content: "I just baked a chocolate cake for my sister." }],
          [{ role: "user", content: "I cooked pasta for dinner." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts);

    expect(worksheet.deterministic_answer).toBe("4");
    expect(worksheet.deterministic_reason).toBe("multi-session-count-extract");
  });

  it("builds worksheet_router_v3 prompts with assistant-first extraction and no gold metadata", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "assistant-v3-phone",
        question_type: "single-session-assistant",
        question: "What phone number did you provide for the concierge?",
        answer: "+1 (415) 555-0198",
        answer_session_ids: ["gold-phone-session"],
        haystack_session_ids: ["phone-session"],
        haystack_dates: ["2023/06/12"],
        haystack_sessions: [
          [
            { role: "user", content: "Can you draft my travel contact list?" },
            { role: "assistant", content: "Use the hotel concierge number +1 (415) 555-0198 and the front desk email." }
          ]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
    const prompt = buildTreatmentPrompt(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });

    expect(worksheet.deterministic_answer).toBe("+1 (415) 555-0198");
    expect(worksheet.deterministic_reason).toBe("v3-assistant-generic-extract");
    expect(prompt).not.toContain("Ledger:");
    expect(prompt).not.toContain("Timeline:");
    expect(prompt).not.toContain("gold-phone-session");
    expect(prompt).not.toContain("gold_answer");
    expect(prompt).not.toContain("answer_session_ids");
  });

  it("does not turn low-confidence assistant candidates into worksheet_router_v3 deterministic answers", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "assistant-v3-restaurant",
        question_type: "single-session-assistant",
        question: "Can you remind me of the name of that restaurant in Cihampelas?",
        answer: "Miss Bee Providore",
        haystack_session_ids: ["restaurant-session"],
        haystack_dates: ["2023/06/12"],
        haystack_sessions: [
          [
            { role: "user", content: "Can you suggest restaurants around Cihampelas?" },
            { role: "assistant", content: "Consider Miss Bee Providore for brunch near Cihampelas. Another option is a bamboo cafe, but the estimated cost there is $90." }
          ]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });

    expect(worksheet.deterministic_answer).toBe("");
    expect(worksheet.text).toContain("Miss Bee Providore");
  });

  it("keeps worksheet_router_v3 preference prompts in preference-answer mode", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "preference-v3-accessories",
        question_type: "single-session-preference",
        question: "Can you suggest some accessories that would complement my current photography setup?",
        answer: "The user would prefer Sony-compatible photography accessories.",
        haystack_session_ids: ["camera-session"],
        haystack_dates: ["2023/06/12"],
        haystack_sessions: [
          [
            { role: "user", content: "I am using a Sony camera and want high-quality gear for photography." },
            { role: "assistant", content: "Sony-compatible lenses, filters, tripods, and protective camera bags would fit that setup." }
          ]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const prompt = buildTreatmentPrompt(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });

    expect(prompt).toContain("Preference mode");
    expect(prompt).toContain("The user would prefer");
    expect(prompt).toContain("Sony");
  });

  it("uses worksheet_router_v3 ledger rows for multi-session sums and prompt budgeting", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "ledger-v3-money",
        question_type: "multi-session",
        question: "How much did I spend on bike-related expenses in total?",
        answer: "$55",
        answer_session_ids: ["bike-light", "bike-helmet"],
        haystack_session_ids: ["bike-light", "tea", "bike-helmet"],
        haystack_dates: ["2023/06/01", "2023/06/02", "2023/06/03"],
        haystack_sessions: [
          [{ role: "user", content: "I spent $20 on bike lights." }],
          [{ role: "user", content: "I spent $8 on tea." }],
          [{ role: "user", content: "I spent $35 on a bike helmet." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const budgeted = applyTreatmentTokenBudget(item, retrieval.contexts, { tokenBudget: 520, answererProfile: "worksheet_router_v3" });
    const worksheet = buildAnswerWorksheet(item, budgeted, { answererProfile: "worksheet_router_v3" });
    const prompt = buildTreatmentPrompt(item, budgeted, { answererProfile: "worksheet_router_v3" });

    expect(worksheet.deterministic_answer).toBe("$55");
    expect(worksheet.deterministic_confidence).toBe("high");
    expect(worksheet.deterministic_reason).toBe("multi-session-money-sum");
    expect(worksheet.solver_evidence_rows).toEqual(expect.arrayContaining([1, 2]));
    expect(worksheet.ledger.map((entry) => entry.source_anchor).join(" ")).toContain("bike");
    expect(estimateTokens(prompt)).toBeLessThanOrEqual(520);
  });

  it("dedupes worksheet_router_v3 multi-session counts by row intent", () => {
    const [clothesItem, campingItem, gamesItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-clothes-count",
        question_type: "multi-session",
        question: "How many items of clothing do I need to pick up or return from a store?",
        answer: "3",
        answer_session_ids: ["boots", "cleaning", "pants"],
        haystack_session_ids: ["boots", "cleaning", "pants"],
        haystack_dates: ["2023/02/15", "2023/02/15", "2023/02/15"],
        haystack_sessions: [
          [{ role: "user", content: "I exchanged a pair of boots from Zara and still need to return them." }],
          [{ role: "user", content: "I still need to pick up my dry cleaning from the store." }],
          [{ role: "user", content: "My yoga pants were too small, so I need to return them Thursday." }]
        ]
      },
      {
        question_id: "v3-camping-days",
        question_type: "multi-session",
        question: "How many days did I spend on camping trips in the United States this year?",
        answer: "8 days",
        answer_session_ids: ["yellowstone", "bigsur"],
        haystack_session_ids: ["yellowstone", "bigsur", "moab"],
        haystack_dates: ["2023/04/29", "2023/04/29", "2023/04/29"],
        haystack_sessions: [
          [
            { role: "user", content: "I just got back from an amazing 5-day camping trip to Yellowstone National Park." },
            { role: "assistant", content: "Your 5-day camping trip sounds memorable." }
          ],
          [
            { role: "user", content: "I just got back from a 3-day solo camping trip to Big Sur." },
            { role: "assistant", content: "The 3-day solo camping trip is noted." }
          ],
          [{ role: "user", content: "I loved the scenic drives in Moab for 4 hours." }]
        ]
      },
      {
        question_id: "v3-game-hours",
        question_type: "multi-session",
        question: "How many hours have I spent playing games in total?",
        answer: "140 hours",
        answer_session_ids: ["last-of-us", "ac"],
        haystack_session_ids: ["last-of-us", "ac"],
        haystack_dates: ["2023/05/25", "2023/05/20"],
        haystack_sessions: [
          [{ role: "user", content: "I spent 30 hours playing The Last of Us Part II." }],
          [{ role: "user", content: "I spent around 70 hours playing Assassin's Creed Odyssey, and 40 hours playing Dragon Age: Inquisition." }]
        ]
      }
    ]));

    for (const [item, expected] of [[clothesItem, "3"], [campingItem, "8 days"], [gamesItem, "140 hours"]]) {
      const retrieval = retrieveFromTransientBenchmarkIndex(
        buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
        item,
        { transientStrategy: "longmemeval_session_v3", topK: 5 }
      );
      const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
      expect(worksheet.deterministic_answer).toBe(expected);
      expect(worksheet.deterministic_reason).toBe("multi-session-count-extract");
    }
  });

  it("solves worksheet_router_v3 multi-session totals from user-event rows", () => {
    const [movieItem, socialBreakItem, luxuryItem, followerItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-movie-weeks",
        question_type: "multi-session",
        question: "How many weeks did it take me to watch all the Marvel Cinematic Universe movies and the main Star Wars films?",
        answer: "3.5 weeks",
        haystack_session_ids: ["mcu", "star-wars"],
        haystack_dates: ["2023/05/23", "2023/05/25"],
        haystack_sessions: [
          [{ role: "user", content: "I watched all 22 Marvel Cinematic Universe movies in two weeks." }],
          [{ role: "user", content: "I just finished a Star Wars marathon, watched all the main films in a week and a half." }]
        ]
      },
      {
        question_id: "v3-social-breaks",
        question_type: "multi-session",
        question: "How many days did I take social media breaks in total?",
        answer: "17 days",
        haystack_session_ids: ["jan", "feb"],
        haystack_dates: ["2023/03/14", "2023/03/14"],
        haystack_sessions: [
          [{ role: "user", content: "I took a week-long break from social media in mid-January." }],
          [{ role: "user", content: "I just got back from a 10-day break from social media in mid-February." }]
        ]
      },
      {
        question_id: "v3-luxury",
        question_type: "multi-session",
        question: "What is the total amount I spent on luxury items in the past few months?",
        answer: "$2,500",
        haystack_session_ids: ["bag", "gown", "boots"],
        haystack_dates: ["2023/05/25", "2023/05/24", "2023/05/28"],
        haystack_sessions: [
          [{ role: "user", content: "I got a designer handbag from Gucci for $1,200." }],
          [{ role: "user", content: "I recently bought a luxury evening gown for a wedding. It cost $800." }],
          [{ role: "user", content: "I bought leather boots from a high-end Italian designer for $500." }]
        ]
      },
      {
        question_id: "v3-followers",
        question_type: "multi-session",
        question: "Which social media platform did I gain the most followers on over the past month?",
        answer: "TikTok",
        haystack_session_ids: ["twitter", "tiktok", "facebook"],
        haystack_dates: ["2023/05/29", "2023/05/29", "2023/05/30"],
        haystack_sessions: [
          [{ role: "user", content: "My Twitter follower count has jumped from 420 to 540 over the past month." }],
          [{ role: "user", content: "On TikTok, I've gained around 200 followers over the past three weeks." }],
          [{ role: "user", content: "My Facebook follower count has remained steady at around 800." }]
        ]
      }
    ]));

    for (const [item, expected] of [[movieItem, "3.5 weeks"], [socialBreakItem, "17 days"], [luxuryItem, "$2,500"], [followerItem, "TikTok"]]) {
      const retrieval = retrieveFromTransientBenchmarkIndex(
        buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
        item,
        { transientStrategy: "longmemeval_session_v3", topK: 5 }
      );
      const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
      expect(worksheet.deterministic_answer).toBe(expected);
      expect(worksheet.deterministic_reason).toMatch(/multi-session/);
    }
  });

  it("solves worksheet_router_v3 targeted multi-session count regressions", () => {
    const [bedtimeItem, doctorItem, doctorCurlyItem, funRunItem, fishItem, deviceItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-doctor-bedtime",
        question_type: "multi-session",
        question: "What time did I go to bed on the day before I had a doctor's appointment?",
        answer: "2 AM",
        haystack_session_ids: ["doctor", "sleep"],
        haystack_dates: ["2023/05/24", "2023/05/29"],
        haystack_sessions: [
          [{ role: "user", content: "I had a doctor's appointment at 10 AM last Thursday." }],
          [{ role: "user", content: "I didn't get to bed until 2 AM last Wednesday, which made Thursday morning a struggle." }]
        ]
      },
      {
        question_id: "v3-march-doctors",
        question_type: "multi-session",
        question: "How many doctor's appointments did I go to in March?",
        answer: "2",
        haystack_session_ids: ["pcp", "surgeon", "emg"],
        haystack_dates: ["2023/03/03", "2023/03/20", "2023/03/28"],
        haystack_sessions: [
          [{ role: "user", content: "I had a doctor appointment on March 3rd with my primary care physician." }],
          [{ role: "user", content: "I had a doctor follow-up appointment on March 20th with my orthopedic surgeon." }],
          [{ role: "user", content: "My EMG test is scheduled for April 1st." }]
        ]
      },
      {
        question_id: "v3-march-doctors-curly",
        question_type: "multi-session",
        question: "How many doctor’s appointments did I go to in March?",
        answer: "2",
        haystack_session_ids: ["orthopedic", "pcp", "pt"],
        haystack_dates: ["2023/03/27", "2023/03/27", "2023/03/27"],
        haystack_sessions: [
          [{ role: "user", content: "I recently had a follow-up appointment with my orthopedic surgeon, Dr. Thompson, on March 20th." }],
          [{ role: "user", content: "I saw Dr. Smith for a doctor's appointment on March 3rd, and he diagnosed me with bronchitis." }],
          [{ role: "user", content: "I'm scheduled to start physical therapy sessions twice a week since March 25th to strengthen my leg muscles." }]
        ]
      },
      {
        question_id: "v3-march-fun-runs",
        question_type: "multi-session",
        question: "How many fun runs did I miss in March due to work commitments?",
        answer: "2",
        haystack_session_ids: ["march-5", "march-26", "april"],
        haystack_dates: ["2023/04/26", "2023/04/26", "2023/04/26"],
        haystack_sessions: [
          [{ role: "user", content: "I was able to attend most weekly 5K fun runs, except for the run on March 5th when I had to miss due to work commitments." }],
          [{ role: "user", content: "I've been pretty busy with work lately and missed a few events, including a 5K fun run on March 26th." }],
          [{ role: "user", content: "I completed my first full marathon on April 10th." }]
        ]
      },
      {
        question_id: "v3-aquarium-fish",
        question_type: "multi-session",
        question: "How many fish are there in total in both of my aquariums?",
        answer: "17",
        haystack_session_ids: ["new-tank", "old-tank"],
        haystack_dates: ["2023/05/20", "2023/05/21"],
        haystack_sessions: [
          [{ role: "user", content: "My 20-gallon tank has 10 neon tetras, 5 golden honey gouramis, and a small pleco catfish." }],
          [{ role: "user", content: "My old 10-gallon tank still has my betta fish Bubbles." }]
        ]
      },
      {
        question_id: "v3-health-devices",
        question_type: "multi-session",
        question: "How many health-related devices do I use in a day?",
        answer: "4",
        haystack_session_ids: ["morning", "evening"],
        haystack_dates: ["2023/05/20", "2023/05/21"],
        haystack_sessions: [
          [{ role: "user", content: "Each morning I use my blood pressure monitor, Fitbit, and pill organizer." }],
          [{ role: "user", content: "At night I use a medication reminder app to track my doses." }]
        ]
      }
    ]));

    for (const [item, expected] of [[bedtimeItem, "2 AM"], [doctorItem, "2"], [doctorCurlyItem, "2"], [funRunItem, "2"], [fishItem, "17"], [deviceItem, "4"]]) {
      const retrieval = retrieveFromTransientBenchmarkIndex(
        buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
        item,
        { transientStrategy: "longmemeval_session_v3", topK: 5 }
      );
      const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
      expect(worksheet.deterministic_answer).toBe(expected);
      expect(worksheet.deterministic_reason).toBe("multi-session-count-extract");
    }
  });

  it("extracts worksheet_router_v3 assistant answers from context-matched lists", () => {
    const [ginItem, restaurantItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-gin-bottle",
        question_type: "single-session-assistant",
        question: "What was the fifth bottle in the Gin based cocktail list?",
        answer: "Absinthe",
        haystack_session_ids: ["bar-list"],
        haystack_dates: ["2023/05/20"],
        haystack_sessions: [[
          { role: "user", content: "Give me five general cocktail bottles." },
          { role: "assistant", content: "1. Vodka 2. Rum 3. Tequila 4. Vermouth 5. Triple Sec" },
          { role: "user", content: "Now give me five bottles for Gin based cocktail prep." },
          { role: "assistant", content: "For a Gin based cocktail setup: 1. London Dry Gin 2. Sweet Vermouth 3. Campari 4. Orange Bitters 5. Absinthe" }
        ]]
      },
      {
        question_id: "v3-bandung-restaurant",
        question_type: "single-session-assistant",
        question: "Which Cihampelas Walk restaurant served Nasi Goreng?",
        answer: "Miss Bee Providore",
        haystack_session_ids: ["bandung"],
        haystack_dates: ["2023/05/30"],
        haystack_sessions: [[
          { role: "user", content: "Where should I eat around Cihampelas Walk in Bandung?" },
          { role: "assistant", content: "For Nasi Goreng near Cihampelas Walk, Miss Bee Providore is the restaurant I would choose. Take a taxi if traffic is heavy." }
        ]]
      }
    ]));

    for (const [item, expected] of [[ginItem, "Absinthe"], [restaurantItem, "Miss Bee Providore"]]) {
      const retrieval = retrieveFromTransientBenchmarkIndex(
        buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
        item,
        { transientStrategy: "longmemeval_session_v3", topK: 5 }
      );
      const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
      expect(worksheet.deterministic_answer).toBe(expected);
      expect(worksheet.deterministic_reason).toBe("v3-assistant-generic-extract");
    }
  });

  it("prioritizes concrete worksheet_router_v3 preference resources over generic advice", () => {
    const [commuteItem, tokyoItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-commute-preference",
        question_type: "single-session-preference",
        question: "What kinds of recommendations would I prefer for my commute?",
        answer: "podcasts or audiobooks",
        haystack_session_ids: ["commute"],
        haystack_dates: ["2023/05/20"],
        haystack_sessions: [[
          { role: "user", content: "On my commute I like listening to podcasts and audiobooks, especially true crime, self-improvement, and history. Reading is hard on the train." }
        ]]
      },
      {
        question_id: "v3-tokyo-navigation",
        question_type: "single-session-preference",
        question: "What would I prefer for getting around Tokyo?",
        answer: "Suica and TripIt",
        haystack_session_ids: ["tokyo"],
        haystack_dates: ["2023/05/20"],
        haystack_sessions: [[
          { role: "user", content: "For Tokyo, I plan to use a Suica card for trains and the TripIt app to keep my travel details organized." }
        ]]
      }
    ]));

    for (const [item, expectedTerms] of [[commuteItem, ["podcasts", "audiobooks"]], [tokyoItem, ["Suica", "TripIt"]]]) {
      const retrieval = retrieveFromTransientBenchmarkIndex(
        buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
        item,
        { transientStrategy: "longmemeval_session_v3", topK: 5 }
      );
      const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
      for (const term of expectedTerms) expect(worksheet.deterministic_answer).toContain(term);
      expect(worksheet.deterministic_reason).toBe("preference-profile-extract");
    }
  });

  it("solves worksheet_router_v3 conservative aggregation when complete evidence is present", () => {
    const [propertyItem, kitchenItem, instrumentItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-property-complete",
        question_type: "multi-session",
        question: "How many properties did I view before making an offer on the townhouse in the Brookside neighborhood?",
        answer: "4",
        haystack_session_ids: ["bungalow", "cedar", "one-bed", "two-bed"],
        haystack_dates: ["2023/02/01", "2023/02/05", "2023/02/10", "2023/02/15"],
        haystack_sessions: [
          [{ role: "user", content: "I saw a 3-bedroom bungalow, but the kitchen needed serious renovation." }],
          [{ role: "user", content: "I viewed a property in Cedar Creek, but it was out of my budget." }],
          [{ role: "user", content: "I saw a 1-bedroom condo, but noise from the highway was a deal-breaker." }],
          [{ role: "user", content: "I fell in love with a 2-bedroom condo, but my offer got rejected due to a higher bid." }]
        ]
      },
      {
        question_id: "v3-kitchen-complete",
        question_type: "multi-session",
        question: "How many kitchen items did I replace or fix?",
        answer: "5",
        haystack_session_ids: ["shelves", "faucet", "mat", "toaster", "coffee"],
        haystack_dates: ["2023/05/20", "2023/05/21", "2023/05/22", "2023/05/23", "2023/05/24"],
        haystack_sessions: [
          [{ role: "user", content: "I finally fixed the kitchen shelves last weekend." }],
          [{ role: "user", content: "I replaced my old kitchen faucet with a new Moen one." }],
          [{ role: "user", content: "I replaced the worn-out kitchen mat in front of the sink." }],
          [{ role: "user", content: "I got rid of my old toaster, replacing it with a toaster oven." }],
          [{ role: "user", content: "I repaired the kitchen coffee maker after it stopped brewing." }]
        ]
      },
      {
        question_id: "v3-instruments-complete",
        question_type: "multi-session",
        question: "How many musical instruments do I currently own?",
        answer: "4",
        haystack_session_ids: ["electric", "acoustic", "drums", "piano", "sister"],
        haystack_dates: ["2023/05/20", "2023/05/21", "2023/05/22", "2023/05/23", "2023/05/24"],
        haystack_sessions: [
          [{ role: "user", content: "I own a Fender Stratocaster electric guitar." }],
          [{ role: "user", content: "I have a Yamaha FG800 acoustic guitar." }],
          [{ role: "user", content: "My Pearl Export drum set needs new heads." }],
          [{ role: "user", content: "I need a technician to service my Korg B1 piano." }],
          [{ role: "user", content: "My sister just bought a student-level violin." }]
        ]
      }
    ]));

    for (const [item, expected] of [[propertyItem, "4"], [kitchenItem, "5"], [instrumentItem, "4"]]) {
      const retrieval = retrieveFromTransientBenchmarkIndex(
        buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
        item,
        { transientStrategy: "longmemeval_session_v3", topK: 5 }
      );
      const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
      expect(worksheet.deterministic_answer).toBe(expected);
      expect(worksheet.deterministic_reason).toBe("multi-session-count-extract");
    }
  });

  it("does not emit worksheet_router_v3 aggregation answers from partial or mismatched evidence", () => {
    const [doctorItem, propertyItem, instrumentItem, funRunItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-doctors-partial",
        question_type: "multi-session",
        question: "How many different doctors did I visit?",
        answer: "3",
        haystack_session_ids: ["derm", "generic"],
        haystack_dates: ["2023/05/20", "2023/05/21"],
        haystack_sessions: [
          [{ role: "user", content: "I got back from a follow-up appointment with my dermatologist." }],
          [{ role: "assistant", content: "Your doctor may recommend avoiding strenuous exercise for 1-2 days." }]
        ]
      },
      {
        question_id: "v3-properties-partial",
        question_type: "multi-session",
        question: "How many properties did I view before making an offer on the townhouse in the Brookside neighborhood?",
        answer: "4",
        haystack_session_ids: ["bungalow", "cedar", "two-bed"],
        haystack_dates: ["2023/02/01", "2023/02/05", "2023/02/15"],
        haystack_sessions: [
          [{ role: "user", content: "I saw a 3-bedroom bungalow, but the kitchen needed serious renovation." }],
          [{ role: "user", content: "I viewed a property in Cedar Creek, but it was out of my budget." }],
          [{ role: "user", content: "I fell in love with a 2-bedroom condo, but my offer got rejected due to a higher bid." }]
        ]
      },
      {
        question_id: "v3-instruments-ledger-guard",
        question_type: "multi-session",
        question: "How many musical instruments do I currently own?",
        answer: "4",
        haystack_session_ids: ["piano", "distance"],
        haystack_dates: ["2023/05/29", "2023/05/30"],
        haystack_sessions: [
          [{ role: "user", content: "I need a technician to service my Korg B1 piano." }],
          [{ role: "assistant", content: "Los Alamos is about 400 miles away from Las Vegas." }]
        ]
      },
      {
        question_id: "v3-fun-run-partial",
        question_type: "multi-session",
        question: "How many fun runs did I miss in March due to work commitments?",
        answer: "2",
        haystack_session_ids: ["one-miss", "busy"],
        haystack_dates: ["2023/04/26", "2023/04/26"],
        haystack_sessions: [
          [{ role: "user", content: "I missed the 5K fun run on March 5th due to work commitments." }],
          [{ role: "assistant", content: "March can be busy, so try blocking time for the next run." }]
        ]
      }
    ]));

    for (const item of [doctorItem, propertyItem, instrumentItem, funRunItem]) {
      const retrieval = retrieveFromTransientBenchmarkIndex(
        buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
        item,
        { transientStrategy: "longmemeval_session_v3", topK: 5 }
      );
      const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
      expect(worksheet.deterministic_answer).toBe("");
      expect(worksheet.deterministic_reason).toBe("");
    }
  });

  it("promotes narrow worksheet_router_v3 money sums only when directly supported", () => {
    const [charityItem, workshopItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-charity-money-direct",
        question_type: "multi-session",
        question: "How much money did I raise for charity in total?",
        answer: "$3,750",
        haystack_session_ids: ["bake", "walk"],
        haystack_dates: ["2023/05/20", "2023/05/21"],
        haystack_sessions: [
          [{ role: "user", content: "I raised $1,500 for charity at the bake sale." }],
          [{ role: "user", content: "The sponsored walk raised another $2,250 for charity." }]
        ]
      },
      {
        question_id: "v3-workshop-ledger-guard",
        question_type: "multi-session",
        question: "How much total money did I spend on attending workshops in the last four months?",
        answer: "$720",
        haystack_session_ids: ["pottery", "membership"],
        haystack_dates: ["2023/05/20", "2023/05/21"],
        haystack_sessions: [
          [{ role: "user", content: "I attended a pottery workshop for $220." }],
          [{ role: "assistant", content: "The studio also sells an annual membership for $500, but that is optional." }]
        ]
      }
    ]));

    const charityRetrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([charityItem], { transientStrategy: "longmemeval_session_v3" }),
      charityItem,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const charityWorksheet = buildAnswerWorksheet(charityItem, charityRetrieval.contexts, { answererProfile: "worksheet_router_v3" });
    expect(charityWorksheet.deterministic_answer).toBe("$3,750");
    expect(charityWorksheet.deterministic_confidence).toBe("high");
    expect(charityWorksheet.deterministic_reason).toBe("multi-session-money-sum");

    const workshopRetrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([workshopItem], { transientStrategy: "longmemeval_session_v3" }),
      workshopItem,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const workshopWorksheet = buildAnswerWorksheet(workshopItem, workshopRetrieval.contexts, { answererProfile: "worksheet_router_v3" });
    expect(workshopWorksheet.deterministic_answer).toBe("");
    expect(workshopWorksheet.deterministic_reason).toBe("");
  });

  it("solves worksheet_router_v3 relative temporal event questions from question_date", () => {
    const [artItem, relativeItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-art-two-weeks",
        question_type: "temporal-reasoning",
        question_date: "2023/01/29",
        question: "I mentioned that I participated in an art-related event two weeks ago. Where was that event held at?",
        answer: "Metropolitan Museum of Art",
        haystack_session_ids: ["city", "met", "modern"],
        haystack_dates: ["2023/01/14", "2023/01/15", "2023/01/15"],
        haystack_sessions: [
          [{ role: "user", content: "I attended the Impressionist Masterpieces exhibition at the City Art Museum yesterday." }],
          [{ role: "user", content: "I attended the Ancient Civilizations exhibit at the Metropolitan Museum of Art today." }],
          [{ role: "user", content: "Do you know upcoming exhibitions at the Modern Art Museum that I should check out?" }]
        ]
      },
      {
        question_id: "v3-relative-one-week",
        question_type: "temporal-reasoning",
        question_date: "2023/06/22",
        question: "What was the the life event of one of my relatives that I participated in a week ago?",
        answer: "my cousin's wedding",
        haystack_session_ids: ["wedding", "baby"],
        haystack_dates: ["2023/06/15", "2023/06/15"],
        haystack_sessions: [
          [{ role: "user", content: "I recently walked down the aisle as a bridesmaid at my cousin's wedding." }],
          [{ role: "user", content: "I got back from my cousin Rachel's baby shower in February." }]
        ]
      }
    ]));

    for (const [item, expected] of [[artItem, "Metropolitan Museum of Art"], [relativeItem, "my cousin's wedding"]]) {
      const retrieval = retrieveFromTransientBenchmarkIndex(
        buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
        item,
        { transientStrategy: "longmemeval_session_v3", topK: 5 }
      );
      const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
      expect(worksheet.deterministic_answer).toBe(expected);
      expect(worksheet.deterministic_reason).toBe("v3-temporal-timeline");
    }
  });

  it("does not emit worksheet_router_v3 temporal answers for relative labels or generic choices", () => {
    const [lunchItem, vehicleItem, monthsItem] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "v3-last-tuesday-person-guard",
        question_type: "temporal-reasoning",
        question_date: "2023/06/21",
        question: "Who did I meet with during the lunch last Tuesday?",
        answer: "Emma",
        haystack_session_ids: ["lunch"],
        haystack_dates: ["2023/06/13"],
        haystack_sessions: [[
          { role: "user", content: "I had lunch with Emma in Chicago last Tuesday." }
        ]]
      },
      {
        question_id: "v3-generic-bike-car-guard",
        question_type: "temporal-reasoning",
        question_date: "2023/03/01",
        question: "Which vehicle did I take care of first in February, the bike or the car?",
        answer: "bike",
        haystack_session_ids: ["bike", "car"],
        haystack_dates: ["2023/02/02", "2023/02/12"],
        haystack_sessions: [
          [{ role: "user", content: "I tuned up my bike in early February." }],
          [{ role: "user", content: "I washed the car later in February." }]
        ]
      },
      {
        question_id: "v3-month-diff-guard",
        question_type: "temporal-reasoning",
        question_date: "2023/07/01",
        question: "How many months passed between the completion of my undergraduate degree and the submission of my master's thesis?",
        answer: "6 months",
        haystack_session_ids: ["degree", "thesis"],
        haystack_dates: ["2023/01/01", "2023/06/30"],
        haystack_sessions: [
          [{ role: "user", content: "I completed my undergraduate degree in January." }],
          [{ role: "user", content: "I submitted my master's thesis at the end of June." }]
        ]
      }
    ]));

    for (const item of [lunchItem, vehicleItem, monthsItem]) {
      const retrieval = retrieveFromTransientBenchmarkIndex(
        buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
        item,
        { transientStrategy: "longmemeval_session_v3", topK: 5 }
      );
      const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });
      expect(worksheet.deterministic_answer).toBe("");
      expect(worksheet.deterministic_reason).toBe("");
    }
  });

  it("uses worksheet_router_v3 timeline rows for temporal date differences", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "timeline-v3-diff",
        question_type: "temporal-reasoning",
        question_date: "2023/06/20",
        question: "How many days were between buying the camera and receiving the lens?",
        answer: "9 days",
        answer_session_ids: ["camera", "lens"],
        haystack_session_ids: ["camera", "lens"],
        haystack_dates: ["2023/06/01", "2023/06/10"],
        haystack_sessions: [
          [{ role: "user", content: "I bought the camera today." }],
          [{ role: "user", content: "I received the lens today." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });

    expect(worksheet.timeline.events.map((event) => event.event_date)).toEqual(expect.arrayContaining(["2023-06-01", "2023-06-10"]));
    expect(worksheet.deterministic_answer).toBe("9 days");
    expect(worksheet.deterministic_reason).toBe("v3-temporal-timeline");
  });

  it("uses worksheet_router_v3 structured actual events for temporal order answers", () => {
    const [item] = parseLongMemEvalDataset(JSON.stringify([
      {
        question_id: "timeline-v3-actual-order",
        question_type: "temporal-reasoning",
        question_date: "2023/06/24",
        question: "What is the order of the three sports events I participated in during the past month, from earliest to latest?",
        answer: "Spring Sprint Triathlon, Midsummer 5K Run, charity soccer tournament",
        haystack_session_ids: ["planned", "triathlon", "run", "soccer"],
        haystack_dates: ["2023/06/01", "2023/06/02", "2023/06/10", "2023/06/17"],
        haystack_sessions: [
          [{ role: "user", content: "I am planning to attend the Midsummer 5K Run again next month." }],
          [{ role: "user", content: "I just completed the Spring Sprint Triathlon today." }],
          [{ role: "user", content: "I just finished a 5K run at the Midsummer 5K Run today." }],
          [{ role: "user", content: "I participated in the charity soccer tournament today." }]
        ]
      }
    ]));

    const retrieval = retrieveFromTransientBenchmarkIndex(
      buildTransientBenchmarkIndex([item], { transientStrategy: "longmemeval_session_v3" }),
      item,
      { transientStrategy: "longmemeval_session_v3", topK: 5 }
    );
    const worksheet = buildAnswerWorksheet(item, retrieval.contexts, { answererProfile: "worksheet_router_v3" });

    expect(worksheet.structured.intent).toBe("temporal_order");
    expect(worksheet.structured.events.some((event) => event.event_status === "planned")).toBe(true);
    expect(worksheet.deterministic_answer).toBe("Spring Sprint Triathlon, Midsummer 5K Run, charity soccer tournament");
    expect(worksheet.deterministic_reason).toBe("v3-temporal-timeline");
  });

  it("classifies answer failures and builds the requested failure export shape", () => {
    const item = {
      id: "fail-1",
      category: "multi-session",
      question: "How much did I spend?",
      answer: "$55"
    };
    const result = {
      id: "fail-1",
      category: "multi-session",
      generated_answer: "$20",
      retrieved_session_ids: ["a", "b"],
      answer_session_ids: ["a", "b"],
      evidence_recall_at_5: true,
      answer_text_hit_at_5: false,
      answer_worksheet: {
        deterministic_reason: "v3-multi-session-ledger",
        deterministic_answer: "$20"
      },
      judge: { verdict: "fail", passed: false, rationale: "The total is wrong." }
    };

    expect(classifyAnswerFailure(result)).toBe("aggregation_error");
    expect(buildAnswerFailureExportEntry(item, result)).toMatchObject({
      id: "fail-1",
      category: "multi-session",
      question: "How much did I spend?",
      gold_answer: "$55",
      generated_answer: "$20",
      failure_kind: "aggregation_error",
      retrieved_session_ids: ["a", "b"],
      answer_session_ids: ["a", "b"],
      evidence_recall_at_5: true,
      answer_text_hit_at_5: false,
      deterministic_reason: "v3-multi-session-ledger"
    });
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
      fallback_count: 1,
      answer_failure_counts: expect.objectContaining({
        missing_evidence: 1
      })
    });
    expect(summary.categories.find((category) => category.category === "single")).toMatchObject({
      item_count: 2,
      judged_count: 2,
      judge_pass_count: 1,
      fallback_count: 1,
      recall_eligible_count: 2,
      recall_at_5_pass_count: 1,
      recall_at_5: 0.5,
      failure_counts: expect.objectContaining({
        missing_evidence: 1
      })
    });
    expect(summary.existing_measurement_runs).toEqual([{ id: "run-1", input_tokens_saved: 2036 }]);
  });
});
