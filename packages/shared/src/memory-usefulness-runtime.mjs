export const MEMORY_USEFULNESS_CONTRACT = "memory-usefulness/v2";
export const MEMORY_REVIEW_LABELS = ["accepted", "corrected", "not_needed", "incorrect", "not_decided", "deferred", "unknown"];

// A human's willingness to save is not evidence that a task succeeded. The
// same five dimensions are used for capture predictions and observed use;
// missing observations stay unknown rather than becoming zero or a pass.
export function assessMemoryUsefulnessV2(input = {}) {
  const dimension = (value, basis) => ({
    status: value === true ? "supported" : value === false ? "unsupported" : "unknown",
    basis
  });
  const reasons = [];
  let applicable = input.applicable;
  if (input.project_id && input.task_project_id && input.project_id !== input.task_project_id) {
    applicable = false;
    reasons.push("project_mismatch");
  }
  const expiry = input.valid_until ?? input.expires_at;
  if (Number.isFinite(expiry) && expiry <= (input.now ?? Date.now())) {
    applicable = false;
    reasons.push("expired");
  }
  if (input.source_available === false) {
    applicable = false;
    reasons.push("source_unavailable");
  }
  if (applicable === false && reasons.length === 0) reasons.push("not_applicable");
  const axes = {
    grounding: dimension(input.evidence_supported, "source_evidence"),
    applicability: dimension(applicable, "current_scope_and_validity"),
    task_contribution: dimension(input.task_contribution, "task_outcome"),
    incremental_value: dimension(input.incremental_value, "current_context_comparison"),
    information_amount: dimension(input.within_budget, "evidence_and_output_budget")
  };
  if (input.evidence_supported === false) reasons.push("unsupported_claim");
  if (input.within_budget === false) reasons.push("over_budget");
  if (input.task_contribution === false) reasons.push("no_task_contribution");
  if (input.incremental_value === false) reasons.push("no_incremental_value");
  const stage = input.stage === "use" ? "use" : "capture";
  return {
    contract: MEMORY_USEFULNESS_CONTRACT,
    stage,
    basis: input.basis === "human_confirmation" || input.basis === "observed" ? input.basis : "prediction",
    axes,
    disposition: reasons.some((reason) => reason !== "over_budget") ? "exclude"
      : input.within_budget === false ? "reduce"
        : Object.values(axes).some((axis) => axis.status === "unknown") ? "needs_evidence" : "eligible",
    reason_codes: reasons
  };
}

export function classifyMemoryReviewAnswer(value) {
  const answer = String(value ?? "").normalize("NFKC").trim();
  if (/保存しない|保存不要|覚えなくて|do not save|don't save|not needed|^skip$/iu.test(answer)) return "not_needed";
  if (/まだ.{0,8}(?:決め|決定)|未決定|決定.{0,4}(?:していない|ではない|じゃない)|not decided/iu.test(answer)) return "not_decided";
  if (/保留|後で|あとで|今は.{0,6}(?:やめ|不要)|later|defer/iu.test(answer)) return "deferred";
  if (/^(?:内容が違う|間違い|誤り|違います|incorrect|wrong)[。.!！\s]*$/iu.test(answer)) return "incorrect";
  if (/^(?:保存する|この内容で保存する|合っているので保存する|save)(?:\s*\(Recommended\))?[。.!！\s]*$/iu.test(answer)) return "accepted";
  // Only explicit corrections carry approval under the displayed question.
  // Generic yes/no, a new task, and ambiguous free text are not consent.
  if (/^(?:修正|訂正|correction|correct)\s*[:：]\s*\S/iu.test(answer)
      && !/(?:しない|ではない|じゃない|don't|do not|\?)/iu.test(answer)
      && answer.length >= 8) return "corrected";
  return "unknown";
}
