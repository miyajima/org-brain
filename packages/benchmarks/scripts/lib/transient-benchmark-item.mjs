import {
  TOKEN_ESTIMATE_MODEL,
  applyTreatmentTokenBudget,
  buildAnswerWorksheet,
  buildFullContextPrompt,
  buildTreatmentPrompt,
  buildTransientBenchmarkIndex,
  classifyAnswerFailure,
  computeAnswerTextHitAtK,
  computeEvidenceCoverageAtK,
  computeEvidenceRecallAtK,
  computeTokenReduction,
  estimateTokens,
  retrieveFromTransientBenchmarkIndex
} from "./memory-token-benchmark-core.mjs";

function compactAnswerWorksheet(worksheet) {
  if (!worksheet) return null;
  return {
    answer_type: worksheet.answer_type,
    proposed_answer: worksheet.proposed_answer || "",
    deterministic_answer: worksheet.deterministic_answer || "",
    deterministic_confidence: worksheet.deterministic_confidence || "none",
    deterministic_reason: worksheet.deterministic_reason || "",
    solver_reason: worksheet.solver_reason || "",
    solver_confidence: worksheet.solver_confidence || "none",
    solver_evidence_rows: worksheet.solver_evidence_rows ?? [],
    facts: (worksheet.facts ?? []).slice(0, 20).map((entry) => ({
      row: entry.row,
      session: entry.session,
      session_date: entry.session_date,
      date: entry.date,
      entity: entry.entity,
      event: entry.event,
      value: entry.value,
      role: entry.role,
      source_anchor: entry.source_anchor
    })),
    timeline: worksheet.timeline
      ? {
          question_date: worksheet.timeline.question_date,
          events: (worksheet.timeline.events ?? []).slice(0, 5).map((event) => ({
            row: event.row,
            session: event.session,
            session_date: event.session_date,
            event_date: event.event_date,
            role: event.role,
            event: event.event
          }))
        }
      : null
  };
}

export function runDeterministicTransientItem(options, item) {
  const itemIndex = buildTransientBenchmarkIndex([item], {
    chunkCharLimit: Math.max(options.contextCharLimit, 1800),
    transientStrategy: options.retrievalProfile ?? options.transientStrategy
  });
  const retrieval = retrieveFromTransientBenchmarkIndex(itemIndex, item, {
    strategy: `${options.strategy}:transient_${options.retrievalProfile ?? options.transientStrategy}`,
    transientStrategy: options.retrievalProfile ?? options.transientStrategy,
    topK: 5,
    contextCharLimit: options.contextCharLimit
  });
  const fullPrompt = buildFullContextPrompt(item);
  const treatmentContexts = applyTreatmentTokenBudget(item, retrieval.contexts, {
    tokenBudget: options.tokenBudget,
    answererProfile: options.answererProfile
  });
  const worksheetContexts = /^worksheet_router(?:_v[34])?$/u.test(options.answererProfile)
    ? retrieval.contexts
    : treatmentContexts;
  const worksheet = /^worksheet_router(?:_v[234])?$/u.test(options.answererProfile)
    ? buildAnswerWorksheet(item, worksheetContexts, { answererProfile: options.answererProfile })
    : null;
  const treatmentPrompt = buildTreatmentPrompt(item, treatmentContexts, {
    answererProfile: options.answererProfile
  });
  const reduction = computeTokenReduction(
    estimateTokens(fullPrompt),
    estimateTokens(treatmentPrompt)
  );
  const evidenceRecallAtFive = computeEvidenceRecallAtK(item, treatmentContexts);
  const result = {
    id: item.id,
    category: item.category,
    question_preview: item.question.slice(0, 160),
    ...reduction,
    token_source: TOKEN_ESTIMATE_MODEL,
    treatment_prompt_tokens: estimateTokens(treatmentPrompt),
    answer_compute_tokens: 0,
    retrieval_compute_tokens: 0,
    retrieval_count: treatmentContexts.length,
    retrieval_latency_ms: retrieval.latency_ms,
    fallback_used: retrieval.fallback_used,
    matched_count: retrieval.matched_count,
    recall_at_5: evidenceRecallAtFive,
    evidence_recall_at_5: evidenceRecallAtFive,
    evidence_coverage_at_5: computeEvidenceCoverageAtK(item, treatmentContexts),
    answer_text_hit_at_5: computeAnswerTextHitAtK(item.answer, treatmentContexts),
    retrieved_context_ids: treatmentContexts.map((context) =>
      context.kind === "doc" ? `doc:${context.id}` : context.id
    ),
    retrieved_session_ids: [
      ...new Set(treatmentContexts.map((context) => context.session_id).filter(Boolean))
    ],
    answer_session_ids: item.answer_session_ids ?? [],
    answer_worksheet: compactAnswerWorksheet(worksheet),
    generated_answer: null,
    judge: { verdict: "not_run", passed: null, rationale: "LLM skipped" }
  };
  result.answer_failure_kind = classifyAnswerFailure(result);
  return result;
}
