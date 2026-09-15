import crypto from "node:crypto";
import {
  extractDurableMemoryDrafts,
  screenSensitiveMemory
} from "../../../shared/src/memory-capture-v2-runtime.mjs";

const MAX_TEXT = 1_000;

function text(value, limit = MAX_TEXT) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, limit);
}

function redact(value) {
  return text(value, 20_000)
    .replace(/\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)\s*[:=]\s*[^\s,;]+/giu, "[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED_SECRET]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu, "[REDACTED_PHONE]")
    .replace(/\/Users\/[^/\s]+(?:\/[^\s`'"),:]+)+/gu, "[REDACTED_PATH]");
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function answerValue(commitment) {
  const answer = commitment?.answer;
  return typeof answer === "object" && answer !== null
    ? answer.label ?? answer.value ?? answer.raw ?? answer.option_id
    : answer;
}

function safeCandidateText(value, sensitivePolicy) {
  const policy = sensitivePolicy ?? { mode: "deny", allowed_principals: [] };
  const screened = screenSensitiveMemory(value, policy);
  if (!screened.allowed) return "";
  const safety = extractDurableMemoryDrafts({ text: value }, { sensitive_policy: policy });
  if (safety.excluded?.some((item) => item.disposition === "hard_excluded")) return "";
  return redact(screened.text);
}

/**
 * Convert an already observed request_user_input answer into a review-only
 * memory candidate. The task commitment remains the source of truth for the
 * immediate task; this separate candidate asks whether the answer should be
 * promoted to an OrgBrain decision memory.
 */
export function buildPlanDecisionMemoryConfirmationCandidates(commitments, options = {}) {
  const projectId = text(options.projectId, 256) || null;
  const sensitivePolicy = options.sensitivePolicy ?? { mode: "deny", allowed_principals: [] };
  const candidates = [];
  for (const commitment of Array.isArray(commitments) ? commitments : []) {
    const question = safeCandidateText(commitment?.question, sensitivePolicy);
    const selectedValue = safeCandidateText(answerValue(commitment), sensitivePolicy);
    const evidenceDigest = text(commitment?.evidence?.digest, 128);
    if (!question || !selectedValue || !/^sha256:[a-f0-9]{64}$/iu.test(evidenceDigest)) continue;
    const scopedProjectId = text(commitment?.scope?.project_id ?? commitment?.project_id, 256) || projectId;
    const decisionKey = text(commitment?.decision_key, 160) || `plan.${hash(`${question}\0${selectedValue}`).slice(0, 24)}`;
    const sourceKey = `${commitment?.task_key ?? ""}\0${decisionKey}\0${question}\0${selectedValue}\0${evidenceDigest}`;
    candidates.push({
      external_key: `plan-decision-review:${hash(sourceKey).slice(0, 40)}`,
      project_id: scopedProjectId,
      confirmation_only: true,
      confirmation_prompt: "plan_answer",
      source_question: question,
      source_answer: selectedValue,
      source_references: [{ type: "request_user_input_result", ref: evidenceDigest }],
      evidence: [{ type: "tool_result", ref: evidenceDigest }],
      observation: {
        record_type: "learning_observation",
        schema_version: 2,
        lesson_type: "decision",
        capture_intent: "review",
        trigger: `${question} -> ${selectedValue}`,
        applicability: { target_files: [], components: scopedProjectId ? [scopedProjectId] : [] },
        evidence_selectors: [{ type: "tool_result", digest: evidenceDigest, supports: ["question", "selected_value"] }],
        gaps: ["rationale_missing", "alternatives_missing", "reuse_when_missing", "durability_unclassified"],
        decision_type: "user_choice",
        decision_key: decisionKey,
        question,
        selected_value: selectedValue,
        decision: null,
        constraints: [],
        rationale: null,
        alternatives: [],
        reuse_when: null
      }
    });
  }
  return candidates.filter((candidate, index, all) => all.findIndex((item) => item.external_key === candidate.external_key) === index);
}
