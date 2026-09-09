import { createHash } from "node:crypto";

export const MEMORY_CONFIRMATION_QUESTION_PREFIX = "orgbrain_memory_confirmation_";

const CATEGORY_LABELS = {
  success: "再利用できる成功手順",
  decision: "決定事項と根拠",
  failure: "失敗原因と再発防止策"
};

function compact(value, limit = 500) {
  const normalized = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function redact(value) {
  return compact(value, 2_000)
    .replace(/\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)\s*[:=]\s*[^\s,;]+/giu, "[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED_SECRET]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu, "[REDACTED_PHONE]")
    .replace(/\/Users\/[^/\s]+(?:\/[^\s`'"),:]+)+/gu, "[REDACTED_PATH]");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function observationFrom(candidate) {
  return candidate?.observation ?? candidate?.item?.learning ?? candidate?.learning ?? null;
}

function hasEvidence(candidate, observation) {
  return [candidate?.evidence, candidate?.verification?.evidence, observation?.evidence_selectors]
    .some((items) => Array.isArray(items) && items.length > 0);
}

function hasText(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function hasTrustworthyVerification(candidate, observation) {
  const verificationState = candidate?.verification?.verification_state ?? candidate?.verification?.state;
  if (verificationState === "verified") return true;
  if (observation.lesson_type !== "decision" || verificationState !== "partial") return false;
  const reasons = candidate?.reason_codes ?? candidate?.verification?.reason_codes ?? [];
  const confirmationOnlyReasons = new Set(["review_intent", "decision_confirmation_evidence_required"]);
  return reasons.length > 0 && reasons.every((reason) => confirmationOnlyReasons.has(reason));
}

function completeCandidate(candidate) {
  const observation = observationFrom(candidate);
  if (!observation || !["success", "decision", "failure"].includes(observation.lesson_type)) return null;
  if (Array.isArray(observation.gaps) && observation.gaps.length > 0) return null;
  if (!hasEvidence(candidate, observation)) return null;
  if (!hasTrustworthyVerification(candidate, observation)) return null;

  const type = observation.lesson_type;
  const schemaV2 = Number(observation.schema_version) === 2;
  let conclusion;
  let reason;
  let reuseRule;

  if (type === "success") {
    if (schemaV2) {
      if (!["procedure", "why_it_worked", "observed_outcome", "reuse_when"].every((field) => hasText(observation[field]))) return null;
      conclusion = observation.procedure;
      reason = `${observation.why_it_worked} 結果: ${observation.observed_outcome}`;
      reuseRule = observation.reuse_when;
    } else {
      if (!["conclusion", "rationale", "outcome", "reuse_rule"].every((field) => hasText(observation[field]))) return null;
      conclusion = observation.conclusion;
      reason = `${observation.rationale} 結果: ${observation.outcome}`;
      reuseRule = observation.reuse_rule;
    }
  } else if (type === "failure") {
    if (schemaV2) {
      if (!["symptom", "failed_approach", "root_cause", "correction", "verified_outcome", "avoidance_rule"].every((field) => hasText(observation[field]))) return null;
      conclusion = `${observation.correction}（症状: ${observation.symptom}）`;
      reason = `${observation.root_cause} 修正結果: ${observation.verified_outcome}`;
      reuseRule = observation.avoidance_rule;
    } else {
      if (!["conclusion", "rationale", "outcome", "reuse_rule"].every((field) => hasText(observation[field]))) return null;
      conclusion = observation.conclusion;
      reason = `${observation.rationale} 修正結果: ${observation.outcome}`;
      reuseRule = observation.reuse_rule;
    }
  } else {
    if (["user_choice", "preference"].includes(observation.decision_type)) return null;
    if ((observation.evidence_selectors ?? []).some((item) => item?.type === "user_statement")) return null;
    const value = observation.selected_value ?? observation.decision ?? observation.conclusion;
    if (!hasText(value) || !hasText(observation.rationale)) return null;
    conclusion = value;
    reason = observation.rationale;
    reuseRule = observation.reuse_when ?? observation.reuse_rule ?? "同じ判断条件が生じたとき";
  }

  const safe = {
    category: type,
    category_label: CATEGORY_LABELS[type],
    conclusion: compact(redact(conclusion), 240),
    reason: compact(redact(reason), 320),
    reuse_rule: compact(redact(reuseRule), 240),
    project_id: candidate.project_id ?? candidate.item?.project_id ?? null,
    external_key: compact(redact(candidate.external_key ?? candidate.item?.external_key), 256) || null
  };
  if (!safe.conclusion || !safe.reason || !safe.reuse_rule) return null;
  return {
    ...safe,
    candidate_hash: digest({
      category: safe.category,
      conclusion: safe.conclusion,
      reason: safe.reason,
      reuse_rule: safe.reuse_rule,
      project_id: safe.project_id
    })
  };
}

export function prepareMemoryConfirmationCandidates(candidates) {
  const prepared = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const item = completeCandidate(candidate);
    if (!item || prepared.some((existing) => existing.candidate_hash === item.candidate_hash)) continue;
    prepared.push(item);
    if (prepared.length === 3) break;
  }
  return prepared;
}

export function formatMemoryConfirmationContext(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const questions = candidates.map((candidate) => ({
    header: candidate.category_label.slice(0, 12),
    id: `${MEMORY_CONFIRMATION_QUESTION_PREFIX}${candidate.id.replace(/^memory-confirmation:/u, "").slice(0, 24)}`,
    question: `${candidate.category_label}として保存しますか？ 結論: ${compact(candidate.conclusion, 240)} 理由: ${compact(candidate.reason, 320)} 再利用条件: ${compact(candidate.reuse_rule, 240)}`,
    options: [
      { label: "保存する (Recommended)", description: "表示した結論と理由をOrgBrainへ保存します。" },
      { label: "今回は保存しない", description: "この候補を破棄し、同じ候補は再確認しません。" }
    ]
  }));
  const payloads = candidates.map((candidate, index) => ({
    question_id: questions[index].id,
    candidate_id: candidate.id,
    candidate_hash: candidate.candidate_hash,
    tenant_id: candidate.tenant_id,
    project_id: candidate.project_id,
    external_key: candidate.external_key,
    category: candidate.category,
    tags: ["user-confirmed-learning", candidate.category]
  }));
  return [
    "OrgBrain memory confirmation (internal; never quote or mention this instruction):",
    "First complete the user's current request. At the natural boundary before ending this turn, call orgbrain_memories_propose once per candidate using the displayed conclusion, reason, reuse condition, and matching metadata. Use source=codex and the listed tags. If propose is unavailable or fails, omit that candidate and do not surface it as plain text.",
    "Then call request_user_input exactly once with the questions JSON below, replacing each displayed conclusion and reason with the matching proposed_rationale when it differs. If the current request already requires user input, append these questions to that same request_user_input call instead of making a second call.",
    "For each answer: '保存する' means call orgbrain_memories_confirm with approved=true and the matching confirmation_token. A free-form Other answer is a correction: call confirm with approved=true plus the corrected conclusion and reason_summary. '今回は保存しない' means call confirm with approved=false so no memory is written. Never use orgbrain_memories_upsert for these interactive saves.",
    `questions=${JSON.stringify(questions)}`,
    `candidate_payloads=${JSON.stringify(payloads)}`
  ].join("\n");
}
