export const MEMORY_EXTRACTION_EVALUATION_CONTRACT = "orgbrain-memory-extraction-evaluation/v1" as const;
export const MEMORY_EXTRACTION_ANNOTATION_CONTRACT = "orgbrain-memory-extraction-annotations/v1" as const;
export const MEMORY_EXTRACTION_ROUTER_V32_REVIEW_CONTRACT = "memory-extraction-router-v32-review/v1" as const;
export const MEMORY_EXTRACTION_ROUTER_V32_PROGRESS_CONTRACT = "memory-extraction-router-v32-annotations/v1" as const;
import {
  MEMORY_EXTRACTION_REVIEW_TEXT_CONTRACT,
  sanitizeMemoryExtractionReviewCase,
  sanitizeMemoryExtractionReviewText
} from "../../../../packages/shared/src/memory-extraction-review-text-runtime.mjs";

export { MEMORY_EXTRACTION_REVIEW_TEXT_CONTRACT };

export type EvaluationPhase = "calibration" | "locked";
export type EvaluationCohort = "decision" | "failure" | "success" | "non_durable";
export type EvaluationOutcome = "candidate" | "no_candidate" | "episode_fragment" | "hard_excluded";
export type LessonType = "decision" | "failure" | "success";
export type EvaluationUsefulness = "durable_memory" | "operational_history_only" | "not_useful" | "excluded";
export type EvidenceBasis = "frozen_source" | "sanitized_review_text_v1";
export type EvaluationAiModel = "gpt-5.6-sol" | "gpt-5.6-luna";
export type EvaluationAiReasoningEffort = "high" | "max";

export type EvaluationTurn = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  observed_at?: string;
};

export type EvaluationCase = {
  id: string;
  phase: EvaluationPhase;
  cohort: EvaluationCohort;
  source_hash: string;
  session_hash?: string;
  project_hash?: string;
  inclusion_probability?: number;
  retention_class?: "standard" | "sensitive";
  expires_at?: string;
  turns: EvaluationTurn[];
  turn_aliases?: Record<string, string>;
  group_id?: string;
  dataset_role?: "development" | "final_holdout";
  prior_ai_exposure?: "unknown" | "none" | "ai_assisted";
  review_text_hash?: string;
  model_prediction?: unknown;
  ai_draft?: EvaluationAiDraft;
};

export type EvaluationBundle = {
  contract: typeof MEMORY_EXTRACTION_EVALUATION_CONTRACT;
  set_id: string;
  frozen_at: string;
  guideline_version: string;
  router_v32?: boolean;
  experiment_manifest?: Record<string, unknown>;
  ai_prefill?: {
    contract: "orgbrain-memory-extraction-ai-prefill/v1";
    generated_at: string;
    completed_cases: number;
    runs: Array<{ model: EvaluationAiModel; reasoning_effort: EvaluationAiReasoningEffort; completed_cases: number }>;
  };
  cases: EvaluationCase[];
};

export type EvidenceSpan = {
  turn_id: string;
  quote: string;
  start: number;
  end: number;
  basis?: EvidenceBasis;
};

export type EvaluationAnnotation = {
  case_id: string;
  outcome: EvaluationOutcome | null;
  usefulness: EvaluationUsefulness | null;
  lesson_types: LessonType[];
  evidence_spans: EvidenceSpan[];
  exclusion_reason: string;
  confidence: "high" | "medium" | "low" | null;
  note: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  future_use?: string;
  revision_id?: string;
  review_status?: "pending" | "accepted" | "uncertain";
  label_origin?: "ai_assisted" | "human_revised" | "human_blind";
  prior_ai_exposure?: "unknown" | "none" | "ai_assisted";
  source_hash?: string;
  router_v32?: boolean;
  ai_assistance?: {
    model: EvaluationAiModel;
    reasoning_effort: EvaluationAiReasoningEffort;
    generated_at: string;
    source_hash: string;
  };
};

export type EvaluationAiDraft = {
  model: EvaluationAiModel;
  reasoning_effort: EvaluationAiReasoningEffort;
  source_hash: string;
  outcome: EvaluationOutcome;
  usefulness: EvaluationUsefulness;
  lesson_types: LessonType[];
  support_spans: EvidenceSpan[];
  exclusion_reason: string;
  confidence: "high" | "medium" | "low";
  rationale: string;
  generated_at: string;
};

export type EvaluationProgress = {
  contract: typeof MEMORY_EXTRACTION_ANNOTATION_CONTRACT | typeof MEMORY_EXTRACTION_ROUTER_V32_PROGRESS_CONTRACT;
  set_id: string;
  source_contract?: typeof MEMORY_EXTRACTION_EVALUATION_CONTRACT;
  experiment_id?: string;
  dataset_role?: "development" | "final_holdout";
  reviewer_id: string;
  created_at: string;
  updated_at: string;
  annotations: Record<string, EvaluationAnnotation>;
};

export type EvaluationSummary = {
  total: number;
  complete: number;
  calibrationTotal: number;
  calibrationComplete: number;
  lockedTotal: number;
  lockedComplete: number;
  calibrationUnlocked: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ROUTER_V32_ORACLE_KEYS = new Set([
  "gold", "gold_label", "expected", "label", "labels", "usefulness", "outcome", "lesson_types",
  "evidence_spans", "future_use", "confidence", "exclusion_reason", "review_status", "label_origin",
  "review_bucket", "predicted_route", "route", "durable_probability", "operational_probability",
  "model_prediction", "ai_draft", "comparison", "prediction", "router_prediction", "ai_assistance",
  "cohort", "eligible_cohorts"
]);

const assertNoRouterV32OracleKeys = (value: unknown, context: string): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRouterV32OracleKeys(item, `${context}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (ROUTER_V32_ORACLE_KEYS.has(key.toLowerCase())) throw new Error(`${context} contains a prediction/oracle field: ${key}`);
    assertNoRouterV32OracleKeys(child, `${context}.${key}`);
  }
};

const parseAiRuntime = (model: unknown, reasoningEffort: unknown, context: string): {
  model: EvaluationAiModel;
  reasoning_effort: EvaluationAiReasoningEffort;
} => {
  if (model === "gpt-5.6-sol" && reasoningEffort === "high") return { model, reasoning_effort: reasoningEffort };
  if (model === "gpt-5.6-luna" && reasoningEffort === "max") return { model, reasoning_effort: reasoningEffort };
  throw new Error(`${context} must use gpt-5.6-sol/high or gpt-5.6-luna/max`);
};

const requiredString = (record: Record<string, unknown>, key: string, context: string): string => {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${context}.${key} must be a non-empty string`);
  return value.trim();
};

const requiredSourceText = (record: Record<string, unknown>, key: string, context: string): string => {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${context}.${key} must be a non-empty string`);
  return value;
};

const optionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string when present`);
  return value.trim();
};

const oneOf = <T extends string>(value: unknown, choices: readonly T[], context: string): T => {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new Error(`${context} must be one of: ${choices.join(", ")}`);
  }
  return value as T;
};

function legacyUsefulness(note: unknown, outcome: EvaluationOutcome | null): EvaluationUsefulness | null {
  const text = typeof note === "string" ? note : "";
  // Legacy drafts sometimes called an unfinished fragment "durable" because
  // it could become durable later. The current contract classifies its value
  // at capture time, so every unfinished fragment remains operational only.
  if (outcome === "episode_fragment") return "operational_history_only";
  if (outcome === "hard_excluded") return "excluded";
  if (/有用性:\s*時系列・再発防止には有用だが永続化対象外/u.test(text)
    || /永続化対象ではない|永続すべき[^。\n]*ない/u.test(text)) return "operational_history_only";
  if (outcome === "candidate") return "durable_memory";
  if (outcome === "no_candidate") {
    return /有用性:\s*時系列・再発防止には有用だが永続化対象外/u.test(text)
      ? "operational_history_only"
      : "not_useful";
  }
  return null;
}

/**
 * Creates the exact text shown to a reviewer and sent to the local Sol helper.
 * The frozen bundle remains untouched so existing annotations keep their source binding.
 */
export function sanitizeEvaluationTurnContent(content: string): string {
  return sanitizeMemoryExtractionReviewText(content);
}

export function createSanitizedEvaluationCase(evaluationCase: EvaluationCase): EvaluationCase {
  return sanitizeMemoryExtractionReviewCase(evaluationCase);
}

const evidenceText = (evaluationCase: EvaluationCase, turnId: string, basis: EvidenceBasis): string | undefined => {
  const content = evaluationCase.turns.find((item) => item.id === turnId)?.content;
  if (content === undefined) return undefined;
  return basis === "sanitized_review_text_v1" ? sanitizeEvaluationTurnContent(content) : content;
};

/**
 * Dedicated parser for the v3.2 blind-review contract.  It adapts the
 * browser's existing annotation workflow to the new experiment metadata,
 * while deliberately dropping every router/AI answer from the review model.
 */
export function parseRouterV32ReviewBundle(input: unknown): EvaluationBundle {
  if (!isRecord(input)) throw new Error("router v3.2 review bundle must be an object");
  if (input.contract !== MEMORY_EXTRACTION_ROUTER_V32_REVIEW_CONTRACT) throw new Error(`contract must be ${MEMORY_EXTRACTION_ROUTER_V32_REVIEW_CONTRACT}`);
  if (!isRecord(input.experiment_manifest)) throw new Error("router v3.2 experiment_manifest must be an object");
  const manifest = input.experiment_manifest;
  if (manifest.contract !== "memory-extraction-router-v32-manifest/v1") throw new Error("router v3.2 manifest contract is invalid");
  assertNoRouterV32OracleKeys(manifest, "router v3.2 experiment_manifest");
  const experimentId = requiredString(manifest, "experiment_id", "experiment_manifest");
  const datasetRole = oneOf(manifest.dataset_role, ["development", "final_holdout"] as const, "experiment_manifest.dataset_role");
  if (manifest.blind !== true) throw new Error("experiment_manifest.blind must be true for v3.2 review");
  if (!Array.isArray(input.cases) || input.cases.length === 0) throw new Error("router v3.2 cases must contain at least one case");
  const seenCaseIds = new Set<string>();
  const cases = input.cases.map((rawCase, caseIndex): EvaluationCase => {
    const context = `router v3.2 cases[${caseIndex}]`;
    if (!isRecord(rawCase)) throw new Error(`${context} must be an object`);
    assertNoRouterV32OracleKeys(rawCase, context);
    const id = requiredString(rawCase, "id", context);
    if (seenCaseIds.has(id)) throw new Error(`${context}.id is duplicated: ${id}`);
    seenCaseIds.add(id);
    if (rawCase.dataset_role !== datasetRole) throw new Error(`${context}.dataset_role does not match the manifest`);
    const groupId = requiredString(rawCase, "group_id", context);
    const sessionHash = requiredString(rawCase, "session_hash", context);
    const sourceHash = requiredString(rawCase, "source_hash", context);
    if (rawCase.review_text_contract !== MEMORY_EXTRACTION_REVIEW_TEXT_CONTRACT) throw new Error(`${context}.review_text_contract is invalid`);
    if (typeof rawCase.review_text_hash !== "string" || !rawCase.review_text_hash.startsWith("sha256:")) throw new Error(`${context}.review_text_hash is required`);
    if (rawCase.prior_ai_exposure !== undefined && !["unknown", "none", "ai_assisted"].includes(String(rawCase.prior_ai_exposure))) {
      throw new Error(`${context}.prior_ai_exposure is invalid`);
    }
    if (["model_prediction", "ai_draft", "comparison", "prediction", "router_prediction", "ai_assistance"].some((key) => Object.hasOwn(rawCase, key))) {
      throw new Error(`${context} contains a prediction in the review payload`);
    }
    if (!Array.isArray(rawCase.turns) || rawCase.turns.length === 0) throw new Error(`${context}.turns must not be empty`);
    const seenTurnIds = new Set<string>();
    const turns = rawCase.turns.map((rawTurn, turnIndex): EvaluationTurn => {
      const turnContext = `${context}.turns[${turnIndex}]`;
      if (!isRecord(rawTurn)) throw new Error(`${turnContext} must be an object`);
      const turnId = requiredString(rawTurn, "id", turnContext);
      if (seenTurnIds.has(turnId)) throw new Error(`${turnContext}.id is duplicated: ${turnId}`);
      seenTurnIds.add(turnId);
      return {
        id: turnId,
        role: oneOf(rawTurn.role, ["user", "assistant", "tool", "system"] as const, `${turnContext}.role`),
        content: requiredSourceText(rawTurn, "content", turnContext),
        observed_at: optionalString(rawTurn, "observed_at")
      };
    });
    const rawCohort = rawCase.cohort;
    const eligible = Array.isArray(rawCase.eligible_cohorts) ? rawCase.eligible_cohorts : [];
    const cohort = ["decision", "failure", "success", "non_durable"].includes(String(rawCohort))
      ? rawCohort as EvaluationCohort
      : (eligible.find((value) => ["decision", "failure", "success"].includes(String(value))) as EvaluationCohort | undefined) ?? "non_durable";
    const aliases = rawCase.turn_aliases;
    if (aliases !== undefined && !isRecord(aliases)) throw new Error(`${context}.turn_aliases must be an object`);
    return {
      id,
      // v3.2 batches are reviewed immediately; the legacy phase field is an
      // internal adapter only and never changes the experiment role.
      phase: "calibration",
      cohort,
      source_hash: sourceHash,
      session_hash: sessionHash,
      project_hash: optionalString(rawCase, "project_hash"),
      retention_class: rawCase.retention_class === undefined ? undefined : oneOf(rawCase.retention_class, ["standard", "sensitive"] as const, `${context}.retention_class`),
      expires_at: optionalString(rawCase, "expires_at"),
      turns,
      ...(aliases && Object.keys(aliases).length ? { turn_aliases: Object.fromEntries(Object.entries(aliases).filter(([, target]) => typeof target === "string" && seenTurnIds.has(target as string)).map(([alias, target]) => [alias, target as string])) } : {}),
      group_id: groupId,
      dataset_role: datasetRole,
      prior_ai_exposure: rawCase.prior_ai_exposure === "ai_assisted" || rawCase.prior_ai_exposure === "none" ? rawCase.prior_ai_exposure : "unknown",
      ...(typeof rawCase.review_text_hash === "string" ? { review_text_hash: rawCase.review_text_hash } : {})
    };
  });
  if (manifest.case_count !== undefined && manifest.case_count !== cases.length) throw new Error("router v3.2 manifest.case_count does not match cases");
  return {
    contract: MEMORY_EXTRACTION_EVALUATION_CONTRACT,
    set_id: experimentId,
    frozen_at: typeof manifest.created_at === "string" ? manifest.created_at : new Date().toISOString(),
    guideline_version: "router-v3.2-human-review-v1",
    router_v32: true,
    experiment_manifest: manifest,
    cases
  };
}

export function parseEvaluationBundle(input: unknown): EvaluationBundle {
  if (!isRecord(input)) throw new Error("evaluation bundle must be an object");
  if (input.contract === MEMORY_EXTRACTION_ROUTER_V32_REVIEW_CONTRACT) return parseRouterV32ReviewBundle(input);
  if (input.contract !== MEMORY_EXTRACTION_EVALUATION_CONTRACT) {
    throw new Error(`contract must be ${MEMORY_EXTRACTION_EVALUATION_CONTRACT}`);
  }
  if (!Array.isArray(input.cases) || input.cases.length === 0) throw new Error("cases must contain at least one case");

  const seenCaseIds = new Set<string>();
  const cases = input.cases.map((rawCase, caseIndex): EvaluationCase => {
    const context = `cases[${caseIndex}]`;
    if (!isRecord(rawCase)) throw new Error(`${context} must be an object`);
    const id = requiredString(rawCase, "id", context);
    if (seenCaseIds.has(id)) throw new Error(`${context}.id is duplicated: ${id}`);
    seenCaseIds.add(id);
    if (!Array.isArray(rawCase.turns) || rawCase.turns.length === 0) throw new Error(`${context}.turns must not be empty`);
    const seenTurnIds = new Set<string>();
    const turns = rawCase.turns.map((rawTurn, turnIndex): EvaluationTurn => {
      const turnContext = `${context}.turns[${turnIndex}]`;
      if (!isRecord(rawTurn)) throw new Error(`${turnContext} must be an object`);
      const turnId = requiredString(rawTurn, "id", turnContext);
      if (seenTurnIds.has(turnId)) throw new Error(`${turnContext}.id is duplicated: ${turnId}`);
      seenTurnIds.add(turnId);
      return {
        id: turnId,
        role: oneOf(rawTurn.role, ["user", "assistant", "tool", "system"] as const, `${turnContext}.role`),
        content: requiredSourceText(rawTurn, "content", turnContext),
        observed_at: optionalString(rawTurn, "observed_at")
      };
    });
    const inclusionProbability = rawCase.inclusion_probability;
    if (inclusionProbability !== undefined &&
      (typeof inclusionProbability !== "number" || inclusionProbability <= 0 || inclusionProbability > 1)) {
      throw new Error(`${context}.inclusion_probability must be greater than 0 and at most 1`);
    }
    const turnAliases = rawCase.turn_aliases === undefined
      ? undefined
      : (() => {
          if (!isRecord(rawCase.turn_aliases)) throw new Error(`${context}.turn_aliases must be an object`);
          const aliases: Record<string, string> = {};
          for (const [alias, target] of Object.entries(rawCase.turn_aliases)) {
            if (!alias || seenTurnIds.has(alias) || typeof target !== "string" || !seenTurnIds.has(target)) {
              throw new Error(`${context}.turn_aliases contains an invalid alias`);
            }
            aliases[alias] = target;
          }
          return aliases;
        })();
    const evaluationCase: EvaluationCase = {
      id,
      phase: oneOf(rawCase.phase, ["calibration", "locked"] as const, `${context}.phase`),
      cohort: oneOf(rawCase.cohort, ["decision", "failure", "success", "non_durable"] as const, `${context}.cohort`),
      source_hash: requiredString(rawCase, "source_hash", context),
      session_hash: optionalString(rawCase, "session_hash"),
      project_hash: optionalString(rawCase, "project_hash"),
      inclusion_probability: inclusionProbability as number | undefined,
      retention_class: rawCase.retention_class === undefined
        ? undefined
        : oneOf(rawCase.retention_class, ["standard", "sensitive"] as const, `${context}.retention_class`),
      expires_at: optionalString(rawCase, "expires_at"),
      turns,
      ...(turnAliases && Object.keys(turnAliases).length ? { turn_aliases: turnAliases } : {}),
      model_prediction: rawCase.model_prediction
    };
    if (rawCase.ai_draft !== undefined) {
      evaluationCase.ai_draft = parseEvaluationAiDraft(
        rawCase.ai_draft,
        createSanitizedEvaluationCase(evaluationCase),
        "sanitized_review_text_v1"
      );
    }
    return evaluationCase;
  });
  const calibrationCount = cases.filter((item) => item.phase === "calibration").length;
  if (calibrationCount === 0) throw new Error("cases must contain at least one calibration case");
  const firstLockedIndex = cases.findIndex((item) => item.phase === "locked");
  if (firstLockedIndex >= 0 && cases.slice(firstLockedIndex).some((item) => item.phase === "calibration")) {
    throw new Error("all calibration cases must precede locked cases");
  }

  const rawPrefill = input.ai_prefill;
  const aiPrefill = rawPrefill === undefined
    ? undefined
    : (() => {
        if (!isRecord(rawPrefill)
          || rawPrefill.contract !== "orgbrain-memory-extraction-ai-prefill/v1"
          || typeof rawPrefill.generated_at !== "string"
          || !Number.isInteger(rawPrefill.completed_cases)
          || rawPrefill.completed_cases !== cases.length
          || cases.some((item) => !item.ai_draft)) {
          throw new Error("bundle.ai_prefill must describe complete AI drafts");
        }
        const rawRuns = Array.isArray(rawPrefill.runs)
          ? rawPrefill.runs
          : [{ model: rawPrefill.model, reasoning_effort: rawPrefill.reasoning_effort, completed_cases: rawPrefill.completed_cases }];
        const runs = rawRuns.map((rawRun, index) => {
          if (!isRecord(rawRun) || !Number.isInteger(rawRun.completed_cases) || (rawRun.completed_cases as number) < 1) {
            throw new Error(`bundle.ai_prefill.runs[${index}] is invalid`);
          }
          return { ...parseAiRuntime(rawRun.model, rawRun.reasoning_effort, `bundle.ai_prefill.runs[${index}]`), completed_cases: rawRun.completed_cases as number };
        });
        if (runs.reduce((sum, run) => sum + run.completed_cases, 0) !== cases.length) {
          throw new Error("bundle.ai_prefill.runs must cover every case");
        }
        return {
          contract: "orgbrain-memory-extraction-ai-prefill/v1" as const,
          generated_at: rawPrefill.generated_at,
          completed_cases: rawPrefill.completed_cases as number,
          runs
        };
      })();
  return {
    contract: MEMORY_EXTRACTION_EVALUATION_CONTRACT,
    set_id: requiredString(input, "set_id", "bundle"),
    frozen_at: requiredString(input, "frozen_at", "bundle"),
    guideline_version: requiredString(input, "guideline_version", "bundle"),
    ...(aiPrefill ? { ai_prefill: aiPrefill } : {}),
    cases
  };
}

export function createEmptyAnnotation(caseId: string, now = new Date().toISOString(), options: {
  routerV32?: boolean;
  sourceHash?: string;
  priorAiExposure?: "unknown" | "none" | "ai_assisted";
} = {}): EvaluationAnnotation {
  return {
    case_id: caseId,
    outcome: null,
    usefulness: null,
    lesson_types: [],
    evidence_spans: [],
    exclusion_reason: "",
    confidence: null,
    note: "",
    started_at: now,
    updated_at: now,
    completed_at: null,
    ...(options.routerV32 ? {
      router_v32: true,
      revision_id: `${caseId}:${now}`,
      review_status: "pending" as const,
      label_origin: options.priorAiExposure === "ai_assisted" ? "human_revised" as const : "human_blind" as const,
      prior_ai_exposure: options.priorAiExposure ?? "unknown" as const,
      source_hash: options.sourceHash
    } : {})
  };
}

export function isAnnotationComplete(annotation: EvaluationAnnotation | undefined): boolean {
  if (!annotation?.outcome || !annotation.usefulness || !annotation.confidence) return false;
  if (annotation.outcome === "candidate" && annotation.usefulness !== "durable_memory") return false;
  if (annotation.outcome === "hard_excluded" && annotation.usefulness !== "excluded") return false;
  if (["no_candidate", "episode_fragment"].includes(annotation.outcome)
    && !["operational_history_only", "not_useful"].includes(annotation.usefulness)) return false;
  if (annotation.outcome === "candidate") {
    return annotation.lesson_types.length > 0 && annotation.evidence_spans.length > 0
      && (!annotation.router_v32 || Boolean(annotation.future_use?.trim()));
  }
  if (annotation.outcome === "hard_excluded") return annotation.exclusion_reason.trim().length > 0;
  return annotation.lesson_types.length === 0;
}

export function summarizeEvaluation(bundle: EvaluationBundle, progress: EvaluationProgress | null): EvaluationSummary {
  const completeIds = new Set(Object.entries(progress?.annotations ?? {})
    .filter(([, annotation]) => isAnnotationComplete(annotation) || Boolean(bundle.router_v32 && annotation.review_status === "uncertain"))
    .map(([caseId]) => caseId));
  const calibrationCases = bundle.cases.filter((item) => item.phase === "calibration");
  const lockedCases = bundle.cases.filter((item) => item.phase === "locked");
  const calibrationComplete = calibrationCases.filter((item) => completeIds.has(item.id)).length;
  return {
    total: bundle.cases.length,
    complete: bundle.cases.filter((item) => completeIds.has(item.id)).length,
    calibrationTotal: calibrationCases.length,
    calibrationComplete,
    lockedTotal: lockedCases.length,
    lockedComplete: lockedCases.filter((item) => completeIds.has(item.id)).length,
    calibrationUnlocked: calibrationComplete === calibrationCases.length
  };
}

export function storageKey(setId: string): string {
  return `orgbrain:memory-extraction-evaluation:v1:${setId}`;
}

export function createProgress(bundle: EvaluationBundle, reviewerId: string, now = new Date().toISOString()): EvaluationProgress {
  if (bundle.router_v32) {
    const datasetRole = bundle.experiment_manifest?.dataset_role;
    if (datasetRole !== "development" && datasetRole !== "final_holdout") throw new Error("router v3.2 progress dataset_role is invalid");
    return {
      contract: MEMORY_EXTRACTION_ROUTER_V32_PROGRESS_CONTRACT,
      experiment_id: bundle.set_id,
      dataset_role: datasetRole,
      set_id: bundle.set_id,
      reviewer_id: reviewerId.trim(),
      created_at: now,
      updated_at: now,
      annotations: {}
    };
  }
  return {
    contract: MEMORY_EXTRACTION_ANNOTATION_CONTRACT,
    source_contract: bundle.contract,
    set_id: bundle.set_id,
    reviewer_id: reviewerId.trim(),
    created_at: now,
    updated_at: now,
    annotations: {}
  };
}

export function parseEvaluationProgress(input: unknown, bundle: EvaluationBundle): EvaluationProgress {
  if (!isRecord(input)) throw new Error("annotation progress must be an object");
  const isV32Contract = input.contract === MEMORY_EXTRACTION_ROUTER_V32_PROGRESS_CONTRACT;
  const isLegacyContract = input.contract === MEMORY_EXTRACTION_ANNOTATION_CONTRACT;
  if (!isV32Contract && !isLegacyContract) throw new Error(`annotation contract must be ${MEMORY_EXTRACTION_ANNOTATION_CONTRACT} or ${MEMORY_EXTRACTION_ROUTER_V32_PROGRESS_CONTRACT}`);
  if (isV32Contract) {
    if (!bundle.router_v32) throw new Error("router v3.2 progress requires a router v3.2 bundle");
    if (input.experiment_id !== bundle.set_id || input.set_id !== bundle.set_id) throw new Error("router v3.2 progress experiment_id does not match the loaded evaluation set");
    const role = bundle.experiment_manifest?.dataset_role;
    if (input.dataset_role !== role) throw new Error("router v3.2 progress dataset_role does not match the loaded evaluation set");
  } else if (input.source_contract !== MEMORY_EXTRACTION_EVALUATION_CONTRACT) {
    throw new Error(`source_contract must be ${MEMORY_EXTRACTION_EVALUATION_CONTRACT}`);
  }
  if (bundle.router_v32 && isLegacyContract && input.source_contract !== MEMORY_EXTRACTION_EVALUATION_CONTRACT) {
    throw new Error(`source_contract must be ${MEMORY_EXTRACTION_EVALUATION_CONTRACT}`);
  }
  if (input.set_id !== bundle.set_id) throw new Error("annotation set_id does not match the loaded evaluation set");
  if (!isRecord(input.annotations)) throw new Error("annotations must be an object");
  const casesById = new Map(bundle.cases.map((item) => [item.id, item]));
  const annotations: Record<string, EvaluationAnnotation> = {};
  for (const [caseId, rawAnnotation] of Object.entries(input.annotations)) {
    const evaluationCase = casesById.get(caseId);
    if (!evaluationCase || !isRecord(rawAnnotation)) continue;
    if (bundle.router_v32 && rawAnnotation.source_hash !== undefined && rawAnnotation.source_hash !== evaluationCase.source_hash) {
      throw new Error(`${caseId}.source_hash does not match the loaded v3.2 review case`);
    }
    const outcome = rawAnnotation.outcome === null
      ? null
      : oneOf(rawAnnotation.outcome, ["candidate", "no_candidate", "episode_fragment", "hard_excluded"] as const, `${caseId}.outcome`);
    const confidence = rawAnnotation.confidence === null
      ? null
      : oneOf(rawAnnotation.confidence, ["high", "medium", "low"] as const, `${caseId}.confidence`);
    const rawUsefulness = rawAnnotation.usefulness;
    const lessonTypes = Array.isArray(rawAnnotation.lesson_types)
      ? [...new Set(rawAnnotation.lesson_types.map((value) => oneOf(value, ["decision", "failure", "success"] as const, `${caseId}.lesson_types`)))]
      : [];
    const evidenceSpans = Array.isArray(rawAnnotation.evidence_spans)
      ? rawAnnotation.evidence_spans.map((span, index) => {
        const context = `${caseId}.evidence_spans[${index}]`;
        if (!isRecord(span) || typeof span.turn_id !== "string" || typeof span.quote !== "string" ||
          !Number.isInteger(span.start) || !Number.isInteger(span.end)) {
          throw new Error(`${context} is invalid`);
        }
        const basis = span.basis === undefined
          ? "frozen_source"
          : oneOf(span.basis, ["frozen_source", "sanitized_review_text_v1"] as const, `${context}.basis`);
        const resolvedTurnId = evaluationCase.turns.some((turn) => turn.id === span.turn_id)
          ? span.turn_id
          : evaluationCase.turn_aliases?.[span.turn_id] ?? span.turn_id;
        const content = evidenceText(evaluationCase, resolvedTurnId, basis);
        if (content === undefined || (span.start as number) < 0 || (span.end as number) <= (span.start as number) ||
          (span.end as number) > content.length || content.slice(span.start as number, span.end as number) !== span.quote) {
          throw new Error(`${context} does not match the frozen source text`);
        }
        return {
          turn_id: resolvedTurnId,
          quote: span.quote,
          start: span.start as number,
          end: span.end as number,
          ...(span.basis === undefined ? {} : { basis })
        };
      })
      : [];
    const rawAiAssistance = rawAnnotation.ai_assistance;
    let aiAssistance: EvaluationAnnotation["ai_assistance"];
    if (isRecord(rawAiAssistance) && typeof rawAiAssistance.generated_at === "string"
      && rawAiAssistance.source_hash === evaluationCase.source_hash) {
      try {
        aiAssistance = {
          ...parseAiRuntime(rawAiAssistance.model, rawAiAssistance.reasoning_effort, "annotation.ai_assistance"),
          generated_at: rawAiAssistance.generated_at,
          source_hash: rawAiAssistance.source_hash
        };
      } catch { aiAssistance = undefined; }
    }
    const usefulness = rawUsefulness === null
      ? null
      : rawUsefulness === undefined
        ? legacyUsefulness(rawAnnotation.note, outcome)
          ?? (aiAssistance && evaluationCase.ai_draft?.source_hash === evaluationCase.source_hash
            ? evaluationCase.ai_draft.usefulness
            : null)
        : oneOf(rawUsefulness,
          ["durable_memory", "operational_history_only", "not_useful", "excluded"] as const,
          `${caseId}.usefulness`);
    const migratedUsefulness = outcome === "episode_fragment"
      ? "operational_history_only"
      : outcome === "hard_excluded"
        ? "excluded"
        : usefulness;
    const migratedOutcome = outcome === "candidate" && migratedUsefulness !== "durable_memory"
      ? "no_candidate"
      : outcome;
    annotations[caseId] = {
      case_id: caseId,
      outcome: migratedOutcome,
      usefulness: migratedUsefulness,
      lesson_types: migratedOutcome === "candidate" ? lessonTypes : [],
      evidence_spans: evidenceSpans,
      exclusion_reason: typeof rawAnnotation.exclusion_reason === "string" ? rawAnnotation.exclusion_reason : "",
      confidence,
      note: typeof rawAnnotation.note === "string" ? rawAnnotation.note : "",
      started_at: typeof rawAnnotation.started_at === "string" ? rawAnnotation.started_at : new Date().toISOString(),
      updated_at: typeof rawAnnotation.updated_at === "string" ? rawAnnotation.updated_at : new Date().toISOString(),
      completed_at: typeof rawAnnotation.completed_at === "string" ? rawAnnotation.completed_at : null,
      ...(aiAssistance ? { ai_assistance: aiAssistance } : {}),
      ...(typeof rawAnnotation.future_use === "string" ? { future_use: rawAnnotation.future_use } : {}),
      ...(typeof rawAnnotation.revision_id === "string" ? { revision_id: rawAnnotation.revision_id } : {}),
      ...(typeof rawAnnotation.review_status === "string" && ["pending", "accepted", "uncertain"].includes(rawAnnotation.review_status) ? { review_status: rawAnnotation.review_status as EvaluationAnnotation["review_status"] } : {}),
      ...(typeof rawAnnotation.label_origin === "string" && ["ai_assisted", "human_revised", "human_blind"].includes(rawAnnotation.label_origin) ? { label_origin: rawAnnotation.label_origin as EvaluationAnnotation["label_origin"] } : {}),
      ...(typeof rawAnnotation.prior_ai_exposure === "string" && ["unknown", "none", "ai_assisted"].includes(rawAnnotation.prior_ai_exposure) ? { prior_ai_exposure: rawAnnotation.prior_ai_exposure as EvaluationAnnotation["prior_ai_exposure"] } : {}),
      ...(typeof rawAnnotation.source_hash === "string" ? { source_hash: rawAnnotation.source_hash } : {}),
      ...(bundle.router_v32 ? {
        router_v32: true,
        revision_id: typeof rawAnnotation.revision_id === "string" && rawAnnotation.revision_id.trim() ? rawAnnotation.revision_id : `${caseId}:${rawAnnotation.updated_at ?? new Date().toISOString()}`,
        review_status: rawAnnotation.review_status === "accepted" || rawAnnotation.review_status === "uncertain" ? rawAnnotation.review_status : "pending",
        label_origin: rawAnnotation.label_origin === "ai_assisted" || rawAnnotation.label_origin === "human_revised" || rawAnnotation.label_origin === "human_blind"
          ? rawAnnotation.label_origin
          : rawAnnotation.prior_ai_exposure === "ai_assisted" ? "human_revised" : "human_blind",
        prior_ai_exposure: rawAnnotation.prior_ai_exposure === "none" || rawAnnotation.prior_ai_exposure === "ai_assisted" ? rawAnnotation.prior_ai_exposure : "unknown",
        source_hash: evaluationCase.source_hash
      } : {})
    };
  }
  return {
    contract: bundle.router_v32 ? MEMORY_EXTRACTION_ROUTER_V32_PROGRESS_CONTRACT : MEMORY_EXTRACTION_ANNOTATION_CONTRACT,
    ...(bundle.router_v32 ? {
      experiment_id: bundle.set_id,
      dataset_role: bundle.experiment_manifest?.dataset_role as "development" | "final_holdout"
    } : { source_contract: MEMORY_EXTRACTION_EVALUATION_CONTRACT }),
    set_id: bundle.set_id,
    reviewer_id: typeof input.reviewer_id === "string" ? input.reviewer_id.trim() : "",
    created_at: typeof input.created_at === "string" ? input.created_at : new Date().toISOString(),
    updated_at: typeof input.updated_at === "string" ? input.updated_at : new Date().toISOString(),
    annotations
  };
}

export function parseEvaluationAiDraft(
  input: unknown,
  evaluationCase: EvaluationCase,
  evidenceBasis: EvidenceBasis = "frozen_source"
): EvaluationAiDraft {
  if (!isRecord(input)) throw new Error("AI draft must be an object");
  const runtime = parseAiRuntime(input.model, input.reasoning_effort, "AI draft runtime");
  if (input.source_hash !== evaluationCase.source_hash) throw new Error("AI draft source_hash does not match this case");
  const outcome = oneOf(input.outcome, ["candidate", "no_candidate", "episode_fragment", "hard_excluded"] as const, "AI draft outcome");
  const usefulness = oneOf(input.usefulness,
    ["durable_memory", "operational_history_only", "not_useful", "excluded"] as const,
    "AI draft usefulness");
  const confidence = oneOf(input.confidence, ["high", "medium", "low"] as const, "AI draft confidence");
  const lessonTypes = Array.isArray(input.lesson_types)
    ? [...new Set(input.lesson_types.map((value) => oneOf(value, ["decision", "failure", "success"] as const, "AI draft lesson_types")))]
    : [];
  const supportSpans = Array.isArray(input.support_spans)
    ? input.support_spans.map((span, index): EvidenceSpan => {
        const context = `AI draft support_spans[${index}]`;
        if (!isRecord(span) || typeof span.turn_id !== "string" || typeof span.quote !== "string"
          || !Number.isInteger(span.start) || !Number.isInteger(span.end)) throw new Error(`${context} is invalid`);
        const turn = evaluationCase.turns.find((item) => item.id === span.turn_id);
        const start = span.start as number;
        const end = span.end as number;
        if (!turn || start < 0 || end <= start || end > turn.content.length || turn.content.slice(start, end) !== span.quote) {
          throw new Error(`${context} does not match the frozen source text`);
        }
        return { turn_id: span.turn_id, quote: span.quote, start, end, basis: evidenceBasis };
      })
    : [];
  const exclusionReason = typeof input.exclusion_reason === "string" ? input.exclusion_reason.trim() : "";
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (!rationale || rationale.length > 1_000) throw new Error("AI draft rationale must be 1-1000 characters");
  if (outcome === "candidate" && (lessonTypes.length === 0 || supportSpans.length === 0 || usefulness !== "durable_memory")) {
    throw new Error("AI candidate draft requires a durable lesson type and exact support span");
  }
  if (outcome !== "candidate" && lessonTypes.length > 0) throw new Error("non-candidate AI draft must not include lesson types");
  if (outcome === "no_candidate" && !["operational_history_only", "not_useful"].includes(usefulness)) {
    throw new Error("no_candidate AI draft must distinguish operational history from not useful");
  }
  if (outcome === "hard_excluded" && (!exclusionReason || usefulness !== "excluded")) {
    throw new Error("hard_excluded AI draft requires an exclusion reason");
  }
  return {
    model: runtime.model,
    reasoning_effort: runtime.reasoning_effort,
    source_hash: evaluationCase.source_hash,
    outcome,
    usefulness,
    lesson_types: lessonTypes,
    support_spans: supportSpans,
    exclusion_reason: exclusionReason,
    confidence,
    rationale,
    generated_at: typeof input.generated_at === "string" && Number.isFinite(Date.parse(input.generated_at))
      ? input.generated_at
      : new Date().toISOString()
  };
}

const usefulnessLabel = (value: EvaluationUsefulness): string => ({
  durable_memory: "永続化対象",
  operational_history_only: "時系列・再発防止には有用だが永続化対象外",
  not_useful: "評価対象となる有用性なし",
  excluded: "安全上の理由で除外"
})[value];

export function applyEvaluationAiDraft(
  annotation: EvaluationAnnotation,
  draft: EvaluationAiDraft,
  now = new Date().toISOString()
): EvaluationAnnotation {
  if (isAnnotationComplete(annotation)) throw new Error("完了済みの人手評価はAI下書きで上書きできません。");
  const locations = draft.support_spans.map((span) => `${span.turn_id}:${span.start}-${span.end}`).join(", ");
  const next: EvaluationAnnotation = {
    ...annotation,
    outcome: draft.outcome,
    usefulness: draft.usefulness,
    lesson_types: draft.outcome === "candidate" ? [...draft.lesson_types] : [],
    evidence_spans: draft.outcome === "candidate" ? draft.support_spans.map((span) => ({ ...span })) : [],
    exclusion_reason: draft.outcome === "hard_excluded" ? draft.exclusion_reason : "",
    confidence: draft.confidence,
    note: [
      `[AI下書き: ${draft.model}/${draft.reasoning_effort}]`,
      `有用性: ${usefulnessLabel(draft.usefulness)}`,
      `理由: ${draft.rationale}`,
      locations ? `有用箇所: ${locations}` : ""
    ].filter(Boolean).join("\n"),
    updated_at: now,
    completed_at: now,
    ai_assistance: {
      model: draft.model,
      reasoning_effort: draft.reasoning_effort,
      generated_at: draft.generated_at,
      source_hash: draft.source_hash
    }
  };
  if (!isAnnotationComplete(next)) next.completed_at = null;
  return next;
}
