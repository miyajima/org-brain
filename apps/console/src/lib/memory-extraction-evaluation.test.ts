import { describe, expect, it } from "vitest";
import {
  MEMORY_EXTRACTION_EVALUATION_CONTRACT,
  applyEvaluationAiDraft,
  createEmptyAnnotation,
  createProgress,
  createSanitizedEvaluationCase,
  isAnnotationComplete,
  parseEvaluationBundle,
  parseRouterV32ReviewBundle,
  parseEvaluationAiDraft,
  parseEvaluationProgress,
  sanitizeEvaluationTurnContent,
  storageKey,
  summarizeEvaluation
} from "./memory-extraction-evaluation";

const bundleInput = {
  contract: MEMORY_EXTRACTION_EVALUATION_CONTRACT,
  set_id: "frozen-500-v1",
  frozen_at: "2026-09-03T00:00:00.000Z",
  guideline_version: "2026-09-03",
  cases: [
    {
      id: "cal-1",
      phase: "calibration",
      cohort: "decision",
      source_hash: "sha256:cal-1",
      turns: [{ id: "turn-1", role: "user", content: "Use SQLite for the local store." }],
      model_prediction: { outcome: "candidate" }
    },
    {
      id: "locked-1",
      phase: "locked",
      cohort: "non_durable",
      source_hash: "sha256:locked-1",
      turns: [{ id: "turn-2", role: "assistant", content: "I will inspect it now." }]
    }
  ]
};

describe("memory extraction evaluation", () => {
  it("parses v3.2 blind batches without exposing predictions and requires future use for durable labels", () => {
    const text = "決定事項としてSQLiteを採用する。将来の同様の構成で使う。";
    const bundle = parseRouterV32ReviewBundle({
      contract: "memory-extraction-router-v32-review/v1",
      experiment_manifest: {
        contract: "memory-extraction-router-v32-manifest/v1",
        experiment_id: "router-v32-test",
        dataset_role: "development",
        blind: true,
        case_count: 1
      },
      cases: [{
        id: "v32-1",
        source_hash: "sha256:v32-1",
        review_text_contract: "orgbrain-memory-extraction-review-text/v1",
        review_text_hash: "sha256:v32-review-text-1",
        session_hash: "session-v32-1",
        group_id: "group-v32-1",
        dataset_role: "development",
        turns: [{ id: "t1", role: "user", content: text }]
      }]
    });
    expect(bundle.router_v32).toBe(true);
    expect(bundle.cases[0]?.model_prediction).toBeUndefined();
    const progress = createProgress(bundle, "reviewer-local");
    expect(progress.contract).toBe("memory-extraction-router-v32-annotations/v1");
    expect(progress.experiment_id).toBe("router-v32-test");
    expect(progress.dataset_role).toBe("development");
    progress.annotations["v32-1"] = {
      ...createEmptyAnnotation("v32-1", undefined, { routerV32: true, sourceHash: "sha256:v32-1", priorAiExposure: "none" }),
      outcome: "candidate",
      usefulness: "durable_memory",
      lesson_types: ["decision"],
      evidence_spans: [{ turn_id: "t1", quote: "決定事項としてSQLiteを採用する。", start: 0, end: "決定事項としてSQLiteを採用する。".length }],
      confidence: "high",
      future_use: "構成を選ぶときに参照する"
    };
    expect(isAnnotationComplete(progress.annotations["v32-1"])).toBe(true);
    const restored = parseEvaluationProgress(JSON.parse(JSON.stringify(progress)), bundle);
    expect(restored.contract).toBe("memory-extraction-router-v32-annotations/v1");
    expect(restored.annotations["v32-1"]?.review_status).toBe("pending");
    expect(() => parseRouterV32ReviewBundle({
      contract: "memory-extraction-router-v32-review/v1",
      experiment_manifest: {
        contract: "memory-extraction-router-v32-manifest/v1",
        experiment_id: "router-v32-test",
        dataset_role: "development",
        blind: true,
        case_count: 1
      },
      cases: [{
        id: "v32-1",
        source_hash: "sha256:v32-1",
        review_text_contract: "orgbrain-memory-extraction-review-text/v1",
        review_text_hash: "sha256:v32-review-text-1",
        session_hash: "session-v32-1",
        group_id: "group-v32-1",
        dataset_role: "development",
        turns: [{ id: "t1", role: "user", content: text }],
        metadata: { gold_label: "durable_memory" }
      }]
    })).toThrow(/prediction\/oracle/);
    expect(() => parseRouterV32ReviewBundle({
      contract: "memory-extraction-router-v32-review/v1",
      experiment_manifest: {
        contract: "memory-extraction-router-v32-manifest/v1",
        experiment_id: "router-v32-test",
        dataset_role: "development",
        blind: true,
        case_count: 1
      },
      cases: [{
        id: "v32-1",
        source_hash: "sha256:v32-1",
        review_text_contract: "orgbrain-memory-extraction-review-text/v1",
        review_text_hash: "sha256:v32-review-text-1",
        session_hash: "session-v32-1",
        group_id: "group-v32-1",
        dataset_role: "development",
        cohort: "decision",
        turns: [{ id: "t1", role: "user", content: text }]
      }]
    })).toThrow(/prediction\/oracle/);
    expect(() => parseRouterV32ReviewBundle({
      contract: "memory-extraction-router-v32-review/v1",
      experiment_manifest: {
        contract: "memory-extraction-router-v32-manifest/v1",
        experiment_id: "router-v32-test",
        dataset_role: "development",
        blind: false,
        case_count: 1
      },
      cases: [{
        id: "v32-1",
        source_hash: "sha256:v32-1",
        review_text_contract: "orgbrain-memory-extraction-review-text/v1",
        review_text_hash: "sha256:v32-review-text-1",
        session_hash: "session-v32-1",
        group_id: "group-v32-1",
        dataset_role: "development",
        turns: [{ id: "t1", role: "user", content: text }]
      }]
    })).toThrow(/blind/);
  });

  it("parses a frozen bundle while retaining a blinded model prediction", () => {
    const bundle = parseEvaluationBundle(bundleInput);
    expect(bundle.set_id).toBe("frozen-500-v1");
    expect(bundle.cases[0]?.model_prediction).toEqual({ outcome: "candidate" });
  });

  it("preserves frozen turn text byte-for-byte so evidence offsets remain stable", () => {
    const content = "  Keep the leading and trailing whitespace.  \n";
    const bundle = parseEvaluationBundle({
      ...bundleInput,
      cases: [{ ...bundleInput.cases[0], turns: [{ id: "turn-spaced", role: "user", content }] }]
    });
    expect(bundle.cases[0]?.turns[0]?.content).toBe(content);
    const start = content.indexOf("Keep");
    const quote = "Keep the leading";
    const progress = createProgress(bundle, "reviewer-1");
    progress.annotations["cal-1"] = {
      ...createEmptyAnnotation("cal-1"),
      outcome: "candidate",
      lesson_types: ["decision"],
      evidence_spans: [{ turn_id: "turn-spaced", quote, start, end: start + quote.length }],
      confidence: "high"
    };
    expect(parseEvaluationProgress(progress, bundle).annotations["cal-1"]?.evidence_spans[0]).toMatchObject({ quote, start });
  });

  it("removes file references and markup while preserving decision content for display and Sol", () => {
    const original = [
      "<proposed_plan>",
      "# 実装方針",
      "[docs/plan.md](docs/plan.md) の方針を採用します。",
      "[秘密設定](<docs/My File/config> \"internal\") は参照しません。",
      "対象:",
      "- `apps/console/src/pages/admin/review.astro`",
      "- `/etc/passwd`",
      "- `.env`",
      "- `Dockerfile`",
      "Dockerfileを更新し、.envを確認してconfig.tsを修正しました。",
      "~/secret と C:\\secret は参照しません。",
      "SQLiteを標準保存先として実装しました。",
      "```text",
      "検証は3件成功しました。",
      "```",
      "</proposed_plan>",
      "<oai-mem-citation><citation_entries>docs/private.md:1-2|note=[internal]</citation_entries><rollout_ids>private-id</rollout_ids></oai-mem-citation>"
    ].join("\n");
    const sanitized = sanitizeEvaluationTurnContent(original);
    expect(sanitized).not.toContain("proposed_plan");
    expect(sanitized).not.toContain("docs/plan.md");
    expect(sanitized).not.toContain("review.astro");
    expect(sanitized).not.toContain("My File/config");
    expect(sanitized).not.toContain("/etc/passwd");
    expect(sanitized).not.toContain(".env");
    expect(sanitized).not.toContain("Dockerfile");
    expect(sanitized).not.toContain("config.ts");
    expect(sanitized).not.toContain("~/secret");
    expect(sanitized).not.toContain("C:\\secret");
    expect(sanitized).not.toContain("private-id");
    expect(sanitized).not.toContain("oai-mem-citation");
    expect(sanitized).not.toContain("```");
    expect(sanitized).toContain("既存資料 の方針を採用します。");
    expect(sanitized).toContain("既存資料 は参照しません。");
    expect(sanitized).toContain("SQLiteを標準保存先として実装しました。");
    expect(sanitized).toContain("検証は3件成功しました。");
  });

  it("keeps the frozen case binding while using sanitized review text for new evidence", () => {
    const bundle = parseEvaluationBundle({
      ...bundleInput,
      cases: [{
        ...bundleInput.cases[0],
        turns: [{ id: "turn-1", role: "user", content: "<decision>docs/plan.md を採用し、SQLiteを標準にします。</decision>" }]
      }]
    });
    const frozenCase = bundle.cases[0]!;
    const reviewCase = createSanitizedEvaluationCase(frozenCase);
    expect(reviewCase.source_hash).toBe(frozenCase.source_hash);
    expect(frozenCase.turns[0]?.content).toContain("docs/plan.md");
    expect(reviewCase.turns[0]?.content).not.toContain("docs/plan.md");
    const quote = "SQLiteを標準にします";
    const start = reviewCase.turns[0]!.content.indexOf(quote);
    const progress = createProgress(bundle, "reviewer-1");
    progress.annotations[frozenCase.id] = {
      ...createEmptyAnnotation(frozenCase.id),
      outcome: "candidate",
      lesson_types: ["decision"],
      evidence_spans: [{
        turn_id: "turn-1",
        quote,
        start,
        end: start + quote.length,
        basis: "sanitized_review_text_v1"
      }],
      confidence: "high"
    };
    expect(parseEvaluationProgress(progress, bundle).annotations[frozenCase.id]?.evidence_spans[0]).toMatchObject({
      quote,
      basis: "sanitized_review_text_v1"
    });
  });

  it("loads complete prefilled drafts and migrates evidence from deduplicated turn aliases", () => {
    const quote = "SQLiteを標準保存先として採用しました。";
    const bundle = parseEvaluationBundle({
      ...bundleInput,
      ai_prefill: {
        contract: "orgbrain-memory-extraction-ai-prefill/v1",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        generated_at: "2026-09-04T00:00:00.000Z",
        completed_cases: 1
      },
      cases: [{
        ...bundleInput.cases[0],
        turns: [{ id: "s1", role: "assistant", content: quote }],
        turn_aliases: { s2: "s1" },
        ai_draft: {
          model: "gpt-5.6-sol",
          reasoning_effort: "high",
          source_hash: bundleInput.cases[0].source_hash,
          outcome: "candidate",
          usefulness: "durable_memory",
          lesson_types: ["decision"],
          support_spans: [{ turn_id: "s1", quote, start: 0, end: quote.length }],
          exclusion_reason: "",
          confidence: "high",
          rationale: "標準保存先を定めた再利用可能な決定です。",
          generated_at: "2026-09-04T00:00:00.000Z"
        }
      }]
    });
    expect(bundle.cases[0]?.ai_draft?.outcome).toBe("candidate");
    const progress = createProgress(bundle, "reviewer-1");
    progress.annotations["cal-1"] = {
      ...createEmptyAnnotation("cal-1"),
      outcome: "candidate",
      lesson_types: ["decision"],
      evidence_spans: [{ turn_id: "s2", quote, start: 0, end: quote.length, basis: "sanitized_review_text_v1" }],
      confidence: "high"
    };
    expect(parseEvaluationProgress(progress, bundle).annotations["cal-1"]?.evidence_spans[0]?.turn_id).toBe("s1");
  });

  it("rejects duplicate case ids and invalid inclusion probabilities", () => {
    expect(() => parseEvaluationBundle({ ...bundleInput, cases: [bundleInput.cases[0], bundleInput.cases[0]] })).toThrow(/duplicated/);
    expect(() => parseEvaluationBundle({
      ...bundleInput,
      cases: [{ ...bundleInput.cases[0], inclusion_probability: 0 }]
    })).toThrow(/inclusion_probability/);
  });

  it("requires calibration and rejects locked cases placed before it", () => {
    expect(() => parseEvaluationBundle({ ...bundleInput, cases: [bundleInput.cases[1]] })).toThrow(/at least one calibration/);
    expect(() => parseEvaluationBundle({ ...bundleInput, cases: [bundleInput.cases[1], bundleInput.cases[0]] })).toThrow(/must precede locked/);
  });

  it("requires support for candidates and a reason for hard exclusions", () => {
    const annotation = createEmptyAnnotation("cal-1", "2026-09-03T00:00:00.000Z");
    annotation.outcome = "candidate";
    annotation.usefulness = "durable_memory";
    annotation.lesson_types = ["decision"];
    annotation.confidence = "high";
    expect(isAnnotationComplete(annotation)).toBe(false);
    annotation.evidence_spans.push({ turn_id: "turn-1", quote: "Use SQLite", start: 0, end: 10 });
    expect(isAnnotationComplete(annotation)).toBe(true);
    annotation.outcome = "hard_excluded";
    annotation.usefulness = "excluded";
    annotation.lesson_types = [];
    annotation.evidence_spans = [];
    expect(isAnnotationComplete(annotation)).toBe(false);
    annotation.exclusion_reason = "credential_detected";
    expect(isAnnotationComplete(annotation)).toBe(true);
  });

  it("keeps locked cases gated until calibration is complete", () => {
    const bundle = parseEvaluationBundle(bundleInput);
    const progress = createProgress(bundle, "reviewer-1", "2026-09-03T00:00:00.000Z");
    expect(summarizeEvaluation(bundle, progress).calibrationUnlocked).toBe(false);
    progress.annotations["cal-1"] = {
      ...createEmptyAnnotation("cal-1"),
      outcome: "no_candidate",
      usefulness: "not_useful",
      confidence: "medium",
      completed_at: "2026-09-03T00:01:00.000Z"
    };
    expect(summarizeEvaluation(bundle, progress)).toMatchObject({ complete: 1, calibrationUnlocked: true, lockedComplete: 0 });
  });

  it("uses a set-scoped storage key and ignores annotations for unknown cases", () => {
    const bundle = parseEvaluationBundle(bundleInput);
    expect(storageKey(bundle.set_id)).toBe("orgbrain:memory-extraction-evaluation:v1:frozen-500-v1");
    const restored = parseEvaluationProgress({
      ...createProgress(bundle, "reviewer-1"),
      annotations: { unknown: createEmptyAnnotation("unknown") }
    }, bundle);
    expect(restored.annotations).toEqual({});
  });

  it("rejects restored evidence that does not exactly match the frozen source", () => {
    const bundle = parseEvaluationBundle(bundleInput);
    expect(() => parseEvaluationProgress({
      ...createProgress(bundle, "reviewer-1"),
      annotations: {
        "cal-1": {
          ...createEmptyAnnotation("cal-1"),
          evidence_spans: [{ turn_id: "turn-1", quote: "wrong text", start: 0, end: 10 }]
        }
      }
    }, bundle)).toThrow(/does not match the frozen source text/);
  });

  it("parses and applies an exact Sol high candidate draft without overwriting completed work", () => {
    const bundle = parseEvaluationBundle(bundleInput);
    const evaluationCase = bundle.cases[0]!;
    const quote = "Use SQLite";
    const draft = parseEvaluationAiDraft({
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      source_hash: evaluationCase.source_hash,
      outcome: "candidate",
      usefulness: "durable_memory",
      lesson_types: ["decision"],
      support_spans: [{ turn_id: "turn-1", quote, start: 0, end: quote.length }],
      exclusion_reason: "",
      confidence: "high",
      rationale: "今後の標準保存先として再利用できる明示的な決定です。",
      generated_at: "2026-09-03T03:00:00.000Z"
    }, evaluationCase);
    const applied = applyEvaluationAiDraft(createEmptyAnnotation(evaluationCase.id), draft, "2026-09-03T03:01:00.000Z");
    expect(applied).toMatchObject({
      outcome: "candidate",
      usefulness: "durable_memory",
      lesson_types: ["decision"],
      confidence: "high",
      ai_assistance: { model: "gpt-5.6-sol", reasoning_effort: "high" }
    });
    expect(applied.note).toContain("永続化対象");
    expect(() => applyEvaluationAiDraft(applied, draft)).toThrow(/完了済み/);
  });

  it("keeps operational history useful while classifying it as non-durable", () => {
    const bundle = parseEvaluationBundle(bundleInput);
    const evaluationCase = bundle.cases[0]!;
    const quote = "Use SQLite";
    const draft = parseEvaluationAiDraft({
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      source_hash: evaluationCase.source_hash,
      outcome: "no_candidate",
      usefulness: "operational_history_only",
      lesson_types: [],
      support_spans: [{ turn_id: "turn-1", quote, start: 0, end: quote.length }],
      exclusion_reason: "",
      confidence: "medium",
      rationale: "同じ修正の反復防止には役立ちますが、安定した組織知ではありません。",
      generated_at: "2026-09-03T03:00:00.000Z"
    }, evaluationCase);
    const applied = applyEvaluationAiDraft(createEmptyAnnotation(evaluationCase.id), draft);
    expect(applied.outcome).toBe("no_candidate");
    expect(applied.usefulness).toBe("operational_history_only");
    expect(applied.evidence_spans).toEqual([]);
    expect(applied.note).toContain("時系列・再発防止には有用だが永続化対象外");
    expect(applied.note).toContain("turn-1:0-10");
  });

  it("migrates legacy episode fragments to operational history at capture time", () => {
    const bundle = parseEvaluationBundle(bundleInput);
    const progress = createProgress(bundle, "reviewer-1");
    const legacyAnnotation = {
      ...createEmptyAnnotation("cal-1"),
      outcome: "episode_fragment" as const,
      confidence: "medium" as const,
      note: "AI評価: 将来は永続化できる決定候補です。",
      completed_at: "2026-09-03T03:01:00.000Z"
    };
    delete (legacyAnnotation as { usefulness?: unknown }).usefulness;
    const restored = parseEvaluationProgress({
      ...progress,
      annotations: { "cal-1": legacyAnnotation }
    }, bundle);
    expect(restored.annotations["cal-1"]).toMatchObject({
      outcome: "episode_fragment",
      usefulness: "operational_history_only"
    });
    expect(isAnnotationComplete(restored.annotations["cal-1"]!)).toBe(true);
  });

  it("migrates legacy non-durable candidates to operational no-candidate labels", () => {
    const bundle = parseEvaluationBundle(bundleInput);
    const progress = createProgress(bundle, "reviewer-1");
    const legacyAnnotation = {
      ...createEmptyAnnotation("cal-1"),
      outcome: "candidate" as const,
      lesson_types: ["decision" as const],
      evidence_spans: [{ turn_id: "turn-1", quote: "Use SQLite", start: 0, end: 10 }],
      confidence: "high" as const,
      note: "時系列の確認には有用ですが、永続化対象ではない。",
      completed_at: "2026-09-03T03:01:00.000Z"
    };
    delete (legacyAnnotation as { usefulness?: unknown }).usefulness;
    const restored = parseEvaluationProgress({
      ...progress,
      annotations: { "cal-1": legacyAnnotation }
    }, bundle);
    expect(restored.annotations["cal-1"]).toMatchObject({
      outcome: "no_candidate",
      usefulness: "operational_history_only",
      lesson_types: []
    });
    expect(isAnnotationComplete(restored.annotations["cal-1"]!)).toBe(true);
  });

  it("rejects AI spans that do not match the frozen case", () => {
    const bundle = parseEvaluationBundle(bundleInput);
    expect(() => parseEvaluationAiDraft({
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      source_hash: bundle.cases[0]!.source_hash,
      outcome: "candidate",
      usefulness: "durable_memory",
      lesson_types: ["decision"],
      support_spans: [{ turn_id: "turn-1", quote: "wrong", start: 0, end: 5 }],
      exclusion_reason: "",
      confidence: "high",
      rationale: "有用です。"
    }, bundle.cases[0]!)).toThrow(/does not match the frozen source text/);
  });
});
