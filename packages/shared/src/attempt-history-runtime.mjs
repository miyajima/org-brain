import { createHash, randomUUID } from "node:crypto";
import { normalizeMemoryPaths, screenSensitiveMemory } from "./memory-capture-v2-runtime.mjs";

export const ATTEMPT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS action_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  action_label TEXT NOT NULL,
  attempt_type TEXT NOT NULL CHECK(attempt_type IN ('intervention','tool_result')),
  target TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  conditions_hash TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','inconclusive')),
  result_summary TEXT NOT NULL,
  change_hypothesis TEXT,
  failure_kind TEXT CHECK(failure_kind IN ('deterministic','transient','unknown')),
  performed_at INTEGER NOT NULL,
  requested_by TEXT,
  executed_by_type TEXT NOT NULL CHECK(executed_by_type IN ('principal','agent','unknown')),
  executed_by TEXT,
  evidence_json TEXT NOT NULL,
  verification_state TEXT NOT NULL CHECK(verification_state IN ('verified','reported')),
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  supersedes_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_action_attempts_lookup
  ON action_attempts(tenant_id, project_id, action_key, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_attempts_project
  ON action_attempts(tenant_id, project_id, performed_at DESC);
CREATE TABLE IF NOT EXISTS action_hook_coverage (
  day TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK(coverage IN ('checked','opaque','recorded','blocked')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,tenant_id,project_id,tool_name,coverage)
);
CREATE TABLE IF NOT EXISTS action_attempt_use_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  task_id TEXT,
  stage TEXT NOT NULL CHECK(stage IN ('returned','injected','adopted','executed','result_checked')),
  verification_state TEXT NOT NULL CHECK(verification_state IN ('observed','reported','verified')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_attempt_use_task
  ON action_attempt_use_events(tenant_id,project_id,task_id,stage,created_at DESC);
CREATE TABLE IF NOT EXISTS action_attempt_pattern_links (
  tenant_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,attempt_id,pattern_id)
);
CREATE TABLE IF NOT EXISTS action_attempt_metric_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('context_query','preflight','feedback')),
  source TEXT NOT NULL,
  action_key TEXT,
  conditions_hash TEXT,
  decision TEXT,
  reason TEXT,
  matched_attempt_id TEXT,
  related_event_id TEXT,
  feedback_verdict TEXT CHECK(feedback_verdict IN ('false_block','correct_block')),
  returned_count INTEGER,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  verification_state TEXT NOT NULL CHECK(verification_state IN ('observed','reported','verified')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_attempt_metric_project
  ON action_attempt_metric_events(tenant_id,project_id,kind,created_at DESC);
`;

function bounded(value, field, max, required = false) {
  const text = typeof value === "string" ? normalizeMemoryPaths(value).trim() : "";
  if (required && !text) throw new Error(`${field}_required`);
  if (text.length > max || /[\r\n]/u.test(text)) throw new Error(`invalid_${field}`);
  if (text && !screenSensitiveMemory(text).allowed) throw new Error(`sensitive_${field}`);
  if (text && (/(?:token|secret|password|authorization|bearer|api[_-]?key|credential|private[_-]?key)\s*[:=]\s*\S+/iu.test(text)
      || /https?:\/\/[^\s]+\?[^\s]+=/iu.test(text))) throw new Error(`sensitive_${field}`);
  return text || null;
}

function identifier(value, field, required = false) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new Error(`${field}_required`);
  if (text && !/^[a-zA-Z0-9._:-]+$/u.test(text)) throw new Error(`invalid_${field}`);
  if (text.length > 128) throw new Error(`invalid_${field}`);
  return text || null;
}

export function safeAttemptActionLabel(operation, tool, max = 160) {
  if (typeof operation !== "string" || !operation.trim()) return `${tool} operation`;
  const normalized = normalizeMemoryPaths(operation).replace(/\s+/gu, " ");
  if (!screenSensitiveMemory(normalized).allowed || /\$\(/u.test(operation)
      || /(?:token|secret|password|authorization|bearer|api[_-]?key|credential|private[_-]?key)/iu.test(normalized)
      || /https?:\/\/[^\s]+\?[^\s]+=/iu.test(normalized)) return `${tool} operation`;
  return normalized.slice(0, max);
}

export function normalizeAttemptConditions(input) {
  if (input == null) return { conditions_json: "{}", conditions_hash: null };
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_conditions");
  const entries = Object.entries(input);
  if (entries.length > 16) throw new Error("too_many_conditions");
  const safe = {};
  for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[a-zA-Z0-9._:-]{1,64}$/u.test(key)) throw new Error("invalid_condition_key");
    const normalized = bounded(value, "condition_value", 160, true);
    safe[key] = normalized;
  }
  const conditions_json = JSON.stringify(safe);
  return {
    conditions_json,
    conditions_hash: entries.length ? createHash("sha256").update(conditions_json).digest("hex") : null
  };
}

export function normalizeAttempt(input, { tenantId = "default", principal = null, trusted = false, now = Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_attempt");
  const { conditions_json, conditions_hash } = normalizeAttemptConditions(input.conditions);
  const outcome = input.outcome;
  if (!["success", "failure", "inconclusive"].includes(outcome)) throw new Error("invalid_outcome");
  const failure_kind = outcome === "failure" ? input.failure_kind ?? "unknown" : null;
  if (failure_kind && !["deterministic", "transient", "unknown"].includes(failure_kind)) throw new Error("invalid_failure_kind");
  const performed_at = Number(input.performed_at);
  if (!Number.isSafeInteger(performed_at) || performed_at < 0 || performed_at > now + 60_000) throw new Error("invalid_performed_at");
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (evidence.length > 8) throw new Error("too_many_evidence_refs");
  const safeEvidence = evidence.map((item) => ({
    ref_type: identifier(item?.ref_type, "ref_type", true),
    ref_id: identifier(item?.ref_id, "ref_id", true),
    content_hash: (() => {
      const hash = bounded(item?.content_hash, "content_hash", 64, true);
      if (!/^[a-f0-9]{64}$/iu.test(hash)) throw new Error("invalid_content_hash");
      return hash.toLowerCase();
    })()
  }));
  const executed_by_type = ["principal", "agent"].includes(input.executed_by_type) ? input.executed_by_type : "unknown";
  const executed_by = executed_by_type === "unknown" ? null : identifier(input.executed_by, "executed_by", true);
  return {
    id: identifier(input.id, "id", true),
    tenant_id: identifier(tenantId, "tenant_id", true),
    project_id: identifier(input.project_id, "project_id", true),
    action_key: identifier(input.action_key, "action_key", true),
    action_label: bounded(input.action_label, "action_label", 240, true),
    attempt_type: input.attempt_type === "tool_result" ? "tool_result" : "intervention",
    target: bounded(input.target, "target", 160, true),
    conditions_json,
    conditions_hash,
    outcome,
    result_summary: bounded(input.result_summary, "result_summary", 500, true),
    change_hypothesis: bounded(input.change_hypothesis, "change_hypothesis", 500),
    failure_kind,
    performed_at,
    requested_by: principal ? identifier(principal, "requested_by", true) : null,
    executed_by_type,
    executed_by,
    evidence_json: JSON.stringify(safeEvidence),
    verification_state: trusted && safeEvidence.length ? "verified" : "reported",
    source: identifier(input.source, "source", true),
    source_key: identifier(input.source_key, "source_key", true),
    supersedes_id: identifier(input.supersedes_id, "supersedes_id"),
    created_at: now
  };
}

export function normalizeAttemptUse(input, { tenantId = "default", trusted = false, now = Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_attempt_use");
  const stage = input.stage;
  if (!["returned", "injected", "adopted", "executed", "result_checked"].includes(stage)) throw new Error("invalid_attempt_use_stage");
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (evidence.length > 8) throw new Error("too_many_evidence_refs");
  const safeEvidence = evidence.map((item) => {
    const contentHash = identifier(item?.content_hash, "content_hash", true);
    if (!/^[a-f0-9]{64}$/iu.test(contentHash)) throw new Error("invalid_content_hash");
    return { ref_type: identifier(item?.ref_type, "ref_type", true),
      ref_id: identifier(item?.ref_id, "ref_id", true), content_hash: contentHash.toLowerCase() };
  });
  return {
    id: identifier(input.id ?? randomUUID(), "id", true),
    tenant_id: identifier(tenantId, "tenant_id", true),
    project_id: identifier(input.project_id, "project_id", true),
    attempt_id: identifier(input.attempt_id, "attempt_id", true),
    task_id: identifier(input.task_id, "task_id"),
    stage,
    verification_state: ["returned", "injected"].includes(stage) ? "observed" : trusted && safeEvidence.length ? "verified" : "reported",
    evidence_json: JSON.stringify(safeEvidence),
    created_at: now
  };
}

export function normalizeAttemptMetricEvent(input, { tenantId = "default", trusted = false, now = Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_attempt_metric_event");
  const kind = input.kind;
  if (!["context_query", "preflight", "feedback"].includes(kind)) throw new Error("invalid_attempt_metric_kind");
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (evidence.length > 8) throw new Error("too_many_evidence_refs");
  const safeEvidence = evidence.map((item) => {
    const contentHash = identifier(item?.content_hash, "content_hash", true);
    if (!/^[a-f0-9]{64}$/iu.test(contentHash)) throw new Error("invalid_content_hash");
    return { ref_type: identifier(item?.ref_type, "ref_type", true),
      ref_id: identifier(item?.ref_id, "ref_id", true), content_hash: contentHash.toLowerCase() };
  });
  const feedback = kind === "feedback" ? input.feedback_verdict : null;
  if (kind === "feedback" && !["false_block", "correct_block"].includes(feedback)) throw new Error("invalid_feedback_verdict");
  const decision = kind === "preflight" ? input.decision : null;
  if (kind === "preflight" && !["allow", "warn", "block"].includes(decision)) throw new Error("invalid_preflight_decision");
  const returned = kind === "context_query" ? Number(input.returned_count) : null;
  if (kind === "context_query" && (!Number.isSafeInteger(returned) || returned < 0 || returned > 100)) throw new Error("invalid_returned_count");
  return {
    id: identifier(input.id ?? randomUUID(), "id", true),
    tenant_id: identifier(tenantId, "tenant_id", true),
    project_id: identifier(input.project_id, "project_id", true),
    kind,
    source: identifier(input.source, "source", true),
    action_key: kind === "preflight" ? identifier(input.action_key, "action_key", true) : null,
    conditions_hash: kind === "preflight" ? identifier(input.conditions_hash, "conditions_hash") : null,
    decision,
    reason: kind === "preflight" ? identifier(input.reason, "reason", true) : null,
    matched_attempt_id: kind === "preflight" ? identifier(input.matched_attempt_id, "matched_attempt_id") : null,
    related_event_id: kind === "feedback" ? identifier(input.related_event_id, "related_event_id", true) : null,
    feedback_verdict: feedback,
    returned_count: returned,
    evidence_json: JSON.stringify(safeEvidence),
    verification_state: kind === "feedback" ? trusted && safeEvidence.length ? "verified" : "reported" : "observed",
    created_at: now
  };
}

export function publicAttempt(row) {
  const { conditions_json, evidence_json, ...rest } = row;
  return { ...rest, conditions: JSON.parse(conditions_json), evidence: JSON.parse(evidence_json) };
}

export function attemptSummaryJa(attempt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric"
  }).formatToParts(new Date(attempt.performed_at)).map(({ type, value }) => [type, value]));
  const date = `${parts.year}年${parts.month}月${parts.day}日`;
  const actor = attempt.verification_state === "verified" && attempt.executed_by_type === "principal" && attempt.executed_by_name
    ? `${attempt.executed_by_name}さんが`
    : attempt.verification_state === "verified" && attempt.executed_by_type === "agent"
      ? "エージェントが" : attempt.verification_state === "verified"
        ? "実行者未確認の記録では" : "未検証の報告では";
  const action = attempt.attempt_type === "tool_result" ? `操作「${attempt.action_label}」` : `施策「${attempt.action_label}」`;
  return `${date}に${actor}${action}を実施し、結果は「${attempt.result_summary}」でした。`;
}

export function rankAttempts(rows, query, limit = 20) {
  const needle = String(query ?? "").trim().toLocaleLowerCase();
  const tokens = needle.split(/[\s、。・:：()]+/u).filter((part) => part.length >= 2);
  return rows.map((row) => {
    const haystack = `${row.action_label} ${row.target} ${row.result_summary}`.toLocaleLowerCase();
    const score = !needle ? 1 : (haystack.includes(needle) ? 4 : 0)
      + tokens.reduce((sum, part) => sum + (haystack.includes(part) ? 1 : 0), 0);
    return { row, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.row.performed_at - left.row.performed_at)
    .slice(0, limit).map(({ row }) => publicAttempt(row));
}

export function preflightAttempt(attempts, proposed) {
  const sameAction = attempts.filter((row) => row.action_key === proposed.action_key);
  if (sameAction.length === 0) return { decision: "allow", reason: "no_accessible_prior_attempt", prior_attempts: [] };
  if (!proposed.conditions_hash) return { decision: "warn", reason: "conditions_unknown", prior_attempts: sameAction.slice(0, 3) };
  const sameConditions = sameAction.filter((row) => row.conditions_hash === proposed.conditions_hash);
  const latestVerifiedSuccess = sameConditions.find((row) => row.verification_state === "verified" && row.outcome === "success");
  const latestFailure = sameConditions.find((row) => row.outcome === "failure");
  const latestVerifiedFailure = sameConditions.find((row) => row.verification_state === "verified" && row.attempt_type === "intervention"
    && row.outcome === "failure" && row.failure_kind === "deterministic");
  if (latestVerifiedFailure && (!latestVerifiedSuccess || latestVerifiedFailure.performed_at >= latestVerifiedSuccess.performed_at)) {
    return { decision: "block", reason: "verified_same_condition_failure", prior_attempts: [latestVerifiedFailure] };
  }
  if (latestVerifiedSuccess && (!latestFailure || latestVerifiedSuccess.performed_at > latestFailure.performed_at)) {
    return { decision: "allow", reason: "latest_verified_success", prior_attempts: sameConditions.slice(0, 3) };
  }
  if (sameConditions.some((row) => row.outcome === "failure")) {
    return { decision: "warn", reason: "failure_not_deterministic_or_verified", prior_attempts: sameConditions.slice(0, 3) };
  }
  if (sameAction.some((row) => row.verification_state === "verified" && row.outcome === "failure")) {
    return { decision: proposed.change_hypothesis ? "allow" : "warn",
      reason: proposed.change_hypothesis ? "changed_conditions_with_hypothesis" : "change_hypothesis_required",
      prior_attempts: sameAction.slice(0, 3) };
  }
  return { decision: "allow", reason: sameAction.length ? "no_unresolved_failure" : "no_accessible_prior_attempt", prior_attempts: sameAction.slice(0, 3) };
}
