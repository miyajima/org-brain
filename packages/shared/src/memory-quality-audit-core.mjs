import { MEMORY_CONTRACT_V2_CONTRACT_HASH } from "./memory-contract-v2-contract.mjs";
import { normalizeMemoryContractV2Event } from "./memory-contract-v2-runtime.mjs";
import { assessMemoryUsefulnessV1 } from "./memory-quality-runtime.mjs";

export const MEMORY_QUALITY_AUDIT_CONTRACT = "memory-quality-audit/v1";

const VALID_WORK_TYPES = new Set([
  "implementation", "review", "debug", "proposal",
  "support", "research", "operations", "other"
]);
const CONFIRMED_DECISION_STATES = new Set(["user_confirmed", "user_corrected", "reviewed", "confirmed"]);
const GENERIC_PITFALL_PATTERN = /reuse this workaround only for the same project pattern|same project pattern|同じプロジェクト(?:の)?パターン/u;

function text(value) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function activeMemory(row) {
  return row.lifecycle_state !== "suppressed" && row.deleted_at == null;
}

function hasFiniteTimestamp(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function expired(row, now) {
  const rawValue = row.valid_until ?? row.expires_at;
  return hasFiniteTimestamp(rawValue) && Number(rawValue) <= now;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : null;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value ?? "")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasArtifactReference(sourceReferences) {
  return sourceReferences.some((entry) => {
    const type = text(entry?.type).toLowerCase();
    return type.includes("artifact") || type === "merged_pr" || type === "commit";
  });
}

function addReason(reasons, value) {
  if (value) reasons.add(value);
}

export async function evaluateMemoryQualityAuditItemV1(row, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const learning = parseObject(row.learning_json ?? row.learning);
  const evidence = parseArray(row.evidence_json ?? row.evidence);
  const sourceReferences = parseArray(row.source_refs_json ?? row.source_references);
  const conflicts = parseArray(row.conflicts_json ?? row.conflicts);
  const qualityDimensions = parseObject(row.quality_dimensions_json ?? row.quality_dimensions);
  const provenance = parseObject(row.provenance_json ?? row.provenance);
  const active = activeMemory(row);
  const validation = Object.keys(learning).length > 0
    ? await normalizeMemoryContractV2Event(learning, {
      workspaceRoot: options.workspace_root ?? null,
      sensitivePolicy: { mode: "deny", allowed_principals: [] }
    })
    : { accepted: false, reason_codes: ["learning_v2_missing"], event: null, event_hash: null };
  const assessment = assessMemoryUsefulnessV1({
    content: row.content,
    summary: row.summary,
    rationale: row.rationale,
    reuse_rule: row.reuse_rule,
    learning: validation.event ?? learning,
    evidence,
    source_references: sourceReferences,
    quality_dimensions: qualityDimensions,
    capture_origin: row.capture_origin,
    verification_state: row.verification_state,
    verified_at: row.verified_at,
    valid_until: row.valid_until ?? row.expires_at,
    conflicts,
    reason_codes: validation.reason_codes,
    ai_certification: row.ai_certification ?? provenance.ai_certification,
    judge_consensus: row.judge_consensus ?? provenance.judge_consensus,
    now
  });
  const reasons = new Set([...validation.reason_codes, ...assessment.reason_codes, ...assessment.hard_violations]);
  const coverage = {
    learning_v2: validation.accepted === true,
    rationale: Boolean(text(row.rationale) || text(learning.rationale) || text(learning.why_it_worked) || text(learning.root_cause)),
    reuse_rule: Boolean(text(row.reuse_rule) || text(learning.reuse_when) || text(learning.avoidance_rule)),
    evidence: evidence.length > 0 || parseArray(learning.evidence_selectors).length > 0,
    source_references: sourceReferences.length > 0,
    applicability: parseArray(learning?.applicability?.target_files).length + parseArray(learning?.applicability?.components).length > 0,
    owner: Boolean(text(row.owner_principal)),
    creator: Boolean(text(row.created_by_principal)),
    category: Boolean(text(row.business_category_id)),
    work_type: VALID_WORK_TYPES.has(row.work_type),
    content_hash: Boolean(text(row.content_hash)),
    canonical_key: Boolean(text(row.canonical_key)),
    ttl: hasFiniteTimestamp(row.valid_until ?? row.expires_at),
    provenance: Boolean(text(row.capture_origin) && text(row.capture_route) && (text(row.created_by_principal) || text(row.actor_id))),
    acl: parseArray(row.permissions_json).length > 0 || Boolean(text(row.owner_principal)),
    observed: row.capture_origin === "observed",
    verified: row.verification_state === "verified" && hasFiniteTimestamp(row.verified_at)
  };
  if (active) {
    for (const [key, present] of Object.entries(coverage)) if (!present) addReason(reasons, `${key}_missing`);
    if (expired(row, now)) addReason(reasons, "expired_active");
    if (row.kind === "pitfall" && GENERIC_PITFALL_PATTERN.test(`${text(row.content)} ${text(row.reuse_rule)}`)) {
      addReason(reasons, "generic_pitfall_placeholder");
    }
  }
  return {
    memory_id: String(row.id),
    project_id: text(row.project_id) || null,
    active,
    semantic_kind: text(row.kind) || null,
    lesson_type: text(learning.lesson_type) || null,
    route: active ? assessment.route : "inactive",
    reason_codes: [...reasons].sort(),
    hard_violations: assessment.hard_violations,
    quality_dimensions: assessment.quality_dimensions,
    coverage,
    row_sha256: await sha256([
      row.id, row.project_id, row.kind, row.lifecycle_state, row.content, row.summary,
      row.rationale, row.reuse_rule, row.evidence_json, row.source_refs_json, row.learning_json
    ].map((value) => String(value ?? "")).join("\0"))
  };
}

function evaluateDecision(row, now) {
  const active = text(row.status || "active") === "active";
  const confirmed = CONFIRMED_DECISION_STATES.has(text(row.confirmation_state)) && hasFiniteTimestamp(row.confirmed_at);
  const sourceReferences = parseArray(row.source_refs_json);
  const reasons = new Set();
  if (active && !confirmed) reasons.add("active_decision_unconfirmed");
  if (active && !text(row.rationale)) reasons.add("active_decision_rationale_missing");
  if (active && sourceReferences.length === 0) reasons.add("active_decision_evidence_missing");
  if (active && !hasArtifactReference(sourceReferences)) reasons.add("artifact_unlinked");
  if (active && hasFiniteTimestamp(row.valid_until) && Number(row.valid_until) <= now) reasons.add("active_decision_expired");
  return {
    decision_memory_id: String(row.id),
    project_id: text(row.project_id) || null,
    active,
    confirmed,
    reason_codes: [...reasons].sort()
  };
}

export async function evaluateMemoryQualityAuditV1(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const rows = Array.isArray(input.memory_rows) ? input.memory_rows : [];
  const decisions = (Array.isArray(input.decision_rows) ? input.decision_rows : []).map((row) => evaluateDecision(row, now));
  const items = await Promise.all(rows.map((row) => evaluateMemoryQualityAuditItemV1(row, {
    now,
    workspace_root: input.workspace_root ?? null
  })));
  const duplicateGroups = new Map();
  for (const [index, row] of rows.entries()) {
    if (!items[index].active || !text(row.canonical_key)) continue;
    const group = duplicateGroups.get(row.canonical_key) ?? [];
    group.push(items[index]);
    duplicateGroups.set(row.canonical_key, group);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    for (const item of group) item.reason_codes = [...new Set([...item.reason_codes, "duplicate_canonical_key"])].sort();
  }
  const active = items.filter((item) => item.active);
  const counts = {
    memories_total: items.length,
    memories_active: active.length,
    memories_suppressed: items.length - active.length,
    active_verified: active.filter((item) => item.coverage.verified).length,
    active_quarantine_required: active.filter((item) => item.route === "quarantine").length,
    active_excluded_required: active.filter((item) => item.route === "excluded").length,
    decisions_total: decisions.length,
    decisions_active: decisions.filter((item) => item.active).length,
    decisions_confirmed: decisions.filter((item) => item.active && item.confirmed).length,
    decisions_inferred: decisions.filter((item) => item.active && !item.confirmed).length
  };
  const coverageKeys = active[0] ? Object.keys(active[0].coverage) : [
    "learning_v2", "rationale", "reuse_rule", "evidence", "source_references", "applicability",
    "owner", "creator", "category", "work_type", "content_hash", "canonical_key", "ttl", "provenance", "acl", "observed", "verified"
  ];
  const coverage = Object.fromEntries(coverageKeys.map((key) => [
    key,
    ratio(active.filter((item) => item.coverage[key]).length, active.length)
  ]));
  const quality_axes = Object.fromEntries([
    "semantic_completeness", "evidence_support", "rationale_quality", "future_reuse",
    "scope_specificity", "freshness_validity", "atomicity"
  ].map((axis) => [axis, ratio(active.filter((item) => Number(item.quality_dimensions[axis]) >= 95).length, active.length)]));
  const reasonSamples = {};
  const addSample = (reason, id) => {
    const values = reasonSamples[reason] ?? [];
    if (values.length < 20 && !values.includes(id)) values.push(id);
    reasonSamples[reason] = values;
  };
  for (const item of items) for (const reason of item.reason_codes) addSample(reason, item.memory_id);
  for (const item of decisions) for (const reason of item.reason_codes) addSample(reason, item.decision_memory_id);
  const projects = new Map();
  for (const item of items) {
    const key = item.project_id ?? "unassigned";
    const current = projects.get(key) ?? { project_id: item.project_id, total: 0, active: 0, verified: 0, quarantine_required: 0, excluded_required: 0 };
    current.total += 1;
    if (item.active) current.active += 1;
    if (item.active && item.coverage.verified) current.verified += 1;
    if (item.active && item.route === "quarantine") current.quarantine_required += 1;
    if (item.active && item.route === "excluded") current.excluded_required += 1;
    projects.set(key, current);
  }
  return {
    contract: MEMORY_QUALITY_AUDIT_CONTRACT,
    contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
    generated_at: now,
    read_only: true,
    scope: {
      tenant_id: text(input.tenant_id) || "default",
      project_id: text(input.project_id) || null,
      kind: text(input.scope) === "tenant" ? "tenant" : "project"
    },
    counts,
    coverage,
    quality_axes,
    by_project: [...projects.values()].sort((left, right) => String(left.project_id ?? "").localeCompare(String(right.project_id ?? ""))),
    reason_code_samples: Object.fromEntries(Object.entries(reasonSamples).sort(([left], [right]) => left.localeCompare(right))),
    integrity: {
      raw_content_emitted: false,
      pii_text_emitted: false,
      credential_values_emitted: false,
      physical_delete_count: 0
    }
  };
}
