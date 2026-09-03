import {
  buildProjectCategoryIdentity,
  normalizeMemoryPaths,
  screenSensitiveMemory
} from "./memory-capture-v2-runtime.mjs";
import { normalizeMemoryContractV2Event } from "./memory-contract-v2-runtime.mjs";
import { assessMemoryUsefulnessV1 } from "./memory-quality-runtime.mjs";

const VALID_WORK_TYPES = new Set([
  "implementation", "review", "debug", "proposal",
  "support", "research", "operations", "other"
]);
const DURABLE_KINDS = new Set(["decision", "constraint", "pitfall", "preference", "fact"]);
const AUTOMATIC_SOURCES = new Set(["codex", "claude", "cursor", "openclaw", "opencode", "hook"]);
const GENERIC_PITFALL_PATTERN = /reuse this workaround only for the same project pattern|same project pattern|同じプロジェクト(?:の)?パターン/u;
const TRANSIENT_COMPLETION_PATTERN = /(?:実装|作業|対応).{0,24}(?:完了|成功)|(?:commit|push|deploy).{0,24}(?:completed|succeeded|成功)/iu;

function collapseWhitespace(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
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

function normalizeCanonical(value) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/\[external-path\]/gu, "path")
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizePersistedValue(value, workspaceRoot) {
  if (typeof value === "string") return normalizeMemoryPaths(value, workspaceRoot);
  if (Array.isArray(value)) return value.map((item) => normalizePersistedValue(item, workspaceRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizePersistedValue(item, workspaceRoot)])
    );
  }
  return value;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function qualityScore(candidate) {
  const evidence = parseArray(candidate.evidence_json ?? candidate.evidence).length;
  const sourceRefs = parseArray(candidate.source_refs_json ?? candidate.source_references).length;
  const confidence = Number.isFinite(candidate.confidence_score) ? candidate.confidence_score : 0.5;
  const utility = Number.isFinite(candidate.utility_score) ? candidate.utility_score : 0.5;
  const age = Number.isFinite(candidate.created_at) ? candidate.created_at / 1e15 : 0;
  return confidence * 0.45 + utility * 0.25 + Math.min(0.2, evidence * 0.04 + sourceRefs * 0.03) + age;
}

function isLikelyRawHook(row, tags) {
  return AUTOMATIC_SOURCES.has(String(row.source ?? "").toLowerCase()) &&
    (tags.includes("hook") || tags.includes("promoted") || String(row.content ?? "").length >= 800);
}

function candidateSnapshot(candidate) {
  return {
    external_key: candidate.external_key,
    project_id: candidate.project_id,
    business_category_id: candidate.business_category_id,
    work_type: candidate.work_type,
    kind: candidate.kind,
    content: candidate.content,
    summary: candidate.summary,
    tags: candidate.tags,
    source_references: candidate.source_references,
    valid_from: candidate.valid_from,
    valid_until: candidate.valid_until,
    confidence_score: candidate.confidence_score,
    utility_score: candidate.utility_score,
    rationale: candidate.rationale,
    reuse_rule: candidate.reuse_rule,
    evidence: candidate.evidence,
    canonical_key: candidate.canonical_key,
    root_memory_id: candidate.root_memory_id,
    visibility: candidate.visibility,
    allowed_principals: candidate.allowed_principals
  };
}

export async function hashMemoryCandidateJson(candidate) {
  return sha256(JSON.stringify(candidateSnapshot(candidate)));
}

async function hashRepairAction(action) {
  return sha256(JSON.stringify({
    memory_id: action.memory_id,
    disposition: action.disposition,
    project_id: action.project_id,
    proposed_business_category_id: action.proposed_business_category_id,
    proposed_work_type: action.proposed_work_type,
    proposed_owner_principal: action.proposed_owner_principal,
    canonical_key: action.canonical_key,
    learning_event_hash: action.learning_event_hash,
    reason_codes: action.reason_codes,
    dedupe_winner: action.dedupe_winner === true,
    winner_memory_id: action.winner_memory_id ?? null
  }));
}

export async function planMemoryRepairRows(rows, options = {}) {
  const tenantId = options.tenant_id ?? "default";
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const workspaceRoot = options.workspace_root ?? null;
  const sensitivePolicy = options.sensitive_policy ?? { mode: "deny", allowed_principals: [] };
  const actions = [];
  const credentialRotation = [];
  const categories = new Map();
  const rowsById = new Map(rows.map((row) => [String(row.id), row]));

  for (const row of rows) {
    const alreadySuppressed = row.lifecycle_state === "suppressed";
    const projectId = typeof row.project_id === "string" && row.project_id.trim() ? row.project_id.trim() : null;
    const categoryDigest = await sha256(`${tenantId}\0${projectId || "global"}`);
    const category = buildProjectCategoryIdentity(tenantId, projectId, categoryDigest);
    const existingCategoryId = typeof row.business_category_id === "string" && row.business_category_id.trim()
      ? row.business_category_id.trim()
      : null;
    const businessCategoryId = existingCategoryId ?? category.id;
    if (!existingCategoryId && !alreadySuppressed) categories.set(category.id, category);
    const tags = parseArray(row.tags_json)
      .filter((tag) => typeof tag === "string")
      .map((tag) => normalizeMemoryPaths(tag, workspaceRoot));
    const entities = normalizePersistedValue(parseArray(row.entities_json), workspaceRoot);
    const evidence = normalizePersistedValue(parseArray(row.evidence_json), workspaceRoot);
    const sourceReferences = normalizePersistedValue(parseArray(row.source_refs_json), workspaceRoot);
    const conflicts = normalizePersistedValue(parseArray(row.conflicts_json), workspaceRoot);
    const createdAt = Number.isFinite(row.created_at) ? row.created_at : now;
    const normalizedContent = normalizeMemoryPaths(row.content ?? "", workspaceRoot);
    const normalizedSummary = normalizeMemoryPaths(row.summary ?? "", workspaceRoot) || null;
    const normalizedRationale = normalizeMemoryPaths(row.rationale ?? "", workspaceRoot) || null;
    const normalizedReuseRule = normalizeMemoryPaths(row.reuse_rule ?? "", workspaceRoot) || null;
    const persistedSensitivity = screenSensitiveMemory(JSON.stringify({
      external_key: row.external_key ?? null,
      content: row.content ?? null,
      summary: row.summary ?? null,
      tags_json: row.tags_json ?? null,
      entities_json: row.entities_json ?? null,
      rationale: row.rationale ?? null,
      reuse_rule: row.reuse_rule ?? null,
      evidence_json: row.evidence_json ?? null,
      source_refs_json: row.source_refs_json ?? null,
      conflicts_json: row.conflicts_json ?? null
    }), sensitivePolicy);
    const learning = row.learning && typeof row.learning === "object"
      ? row.learning
      : (() => {
        try { return JSON.parse(row.learning_json ?? "null"); } catch { return null; }
      })();
    const qualityDimensions = row.quality_dimensions && typeof row.quality_dimensions === "object"
      ? row.quality_dimensions
      : (() => {
        try { return JSON.parse(row.quality_dimensions_json ?? "null"); } catch { return null; }
      })();
    const validation = learning
      ? await normalizeMemoryContractV2Event(learning, {
        workspaceRoot,
        sensitivePolicy
      })
      : { accepted: false, event: null, event_hash: null, reason_codes: ["learning_v2_missing"] };
    const usefulness = assessMemoryUsefulnessV1({
      content: normalizedContent,
      summary: normalizedSummary,
      rationale: normalizedRationale,
      reuse_rule: normalizedReuseRule,
      learning: validation.event ?? learning,
      evidence,
      source_references: sourceReferences,
      quality_dimensions: qualityDimensions,
      capture_origin: row.capture_origin,
      verification_state: row.verification_state,
      verified_at: row.verified_at,
      valid_until: row.valid_until ?? row.expires_at,
      conflicts,
      ai_certification: row.ai_certification,
      judge_consensus: row.judge_consensus,
      reason_codes: validation.reason_codes,
      now
    });
    const rawExpiry = row.valid_until ?? row.expires_at;
    const expiry = rawExpiry === null || rawExpiry === undefined ? null : Number(rawExpiry);
    if (alreadySuppressed) {
      if (persistedSensitivity.hard_reject) {
        credentialRotation.push({ memory_id: row.id, reason_code: "rotation_required" });
      }
      continue;
    }
    let disposition = null;
    const reasonCodes = new Set([...validation.reason_codes, ...usefulness.reason_codes, ...usefulness.hard_violations]);
    if (persistedSensitivity.hard_reject) {
      disposition = "excluded";
      reasonCodes.add("credential_detected");
      credentialRotation.push({ memory_id: row.id, reason_code: "rotation_required" });
    } else if (!persistedSensitivity.allowed) {
      disposition = "excluded";
      reasonCodes.add("sensitive_memory_denied");
    } else if (Number.isFinite(expiry) && expiry <= now) {
      disposition = "excluded";
      reasonCodes.add("expired");
    } else if (!normalizedContent) {
      disposition = "excluded";
      reasonCodes.add("low_quality");
    } else if (TRANSIENT_COMPLETION_PATTERN.test(normalizedContent) && !learning) {
      disposition = "excluded";
      reasonCodes.add("transient");
    } else if (row.kind === "pitfall" && GENERIC_PITFALL_PATTERN.test(`${normalizedContent} ${normalizedReuseRule ?? ""}`)) {
      disposition = "quarantine";
      reasonCodes.add("generic_pitfall_placeholder");
    } else if (isLikelyRawHook(row, tags)) {
      disposition = "quarantine";
      reasonCodes.add("raw_hook_review_required");
    } else if (usefulness.route === "excluded" || !DURABLE_KINDS.has(row.kind)) {
      disposition = usefulness.hard_violations.length > 0 ? "excluded" : "quarantine";
    } else if (validation.accepted && usefulness.route === "active") {
      disposition = "certification_pending";
      reasonCodes.add("repair_requires_certified_publish");
    } else {
      disposition = "quarantine";
    }

    const workType = VALID_WORK_TYPES.has(row.work_type) ? row.work_type : "other";
    const kind = DURABLE_KINDS.has(row.kind) ? row.kind : "fact";
    const canonicalText = normalizeCanonical(normalizedContent);
    const canonicalKey = canonicalText
      ? await sha256(`${tenantId}\0${projectId || "global"}\0${kind}\0${canonicalText}`)
      : null;
    const action = {
      type: disposition,
      disposition,
      memory_id: row.id,
      tenant_id: tenantId,
      project_id: projectId,
      proposed_business_category_id: businessCategoryId,
      proposed_work_type: workType,
      proposed_owner_principal: row.owner_principal ?? row.created_by_principal ?? row.actor_id ?? null,
      canonical_key: canonicalKey,
      learning_event_hash: validation.event_hash,
      reason_codes: [...reasonCodes].sort(),
      reason_code: [...reasonCodes].sort()[0] ?? `${disposition}_required`,
      created_at: createdAt
    };
    action.candidate_hash = await hashRepairAction(action);
    actions.push(action);
  }

  const groups = new Map();
  for (const action of actions) {
    if (!action.canonical_key) continue;
    const group = groups.get(action.canonical_key) ?? [];
    group.push(action);
    groups.set(action.canonical_key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [winner, ...duplicates] = [...group].sort((left, right) =>
      qualityScore(rowsById.get(String(right.memory_id)) ?? {}) - qualityScore(rowsById.get(String(left.memory_id)) ?? {}) ||
      String(left.memory_id).localeCompare(String(right.memory_id))
    );
    winner.dedupe_winner = true;
    for (const duplicate of duplicates) {
      duplicate.type = "excluded";
      duplicate.disposition = "excluded";
      duplicate.reason_codes = [...new Set([...duplicate.reason_codes, "duplicate_canonical_key"])].sort();
      duplicate.reason_code = "duplicate_canonical_key";
      duplicate.winner_memory_id = winner.memory_id;
    }
  }
  await Promise.all(actions.map(async (action) => {
    action.candidate_hash = await hashRepairAction(action);
  }));

  return {
    tenant_id: tenantId,
    scanned_count: rows.length,
    categories: [...categories.values()],
    actions,
    credential_rotation_required: credentialRotation,
    stats: {
      certification_pending_count: actions.filter((action) => action.type === "certification_pending").length,
      quarantine_count: actions.filter((action) => action.type === "quarantine").length,
      excluded_count: actions.filter((action) => action.type === "excluded").length,
      derive_count: 0,
      update_count: 0,
      suppress_count: 0,
      credential_count: credentialRotation.length,
      duplicate_group_count: [...groups.values()].filter((group) => group.length > 1).length
    }
  };
}

export async function planDecisionClassificationRepairRows(rows, options = {}) {
  const tenantId = options.tenant_id ?? "default";
  const actions = [];
  const categories = new Map();

  for (const row of rows) {
    if (row.status && row.status !== "active") continue;
    const projectId = typeof row.project_id === "string" && row.project_id.trim() ? row.project_id.trim() : null;
    const existingCategoryId = typeof row.business_category_id === "string" && row.business_category_id.trim()
      ? row.business_category_id.trim()
      : null;
    const workType = VALID_WORK_TYPES.has(row.work_type) ? row.work_type : "other";
    let businessCategoryId = existingCategoryId;
    if (!businessCategoryId) {
      const categoryDigest = await sha256(`${tenantId}\0${projectId || "global"}`);
      const category = buildProjectCategoryIdentity(tenantId, projectId, categoryDigest);
      categories.set(category.id, category);
      businessCategoryId = category.id;
    }
    if (row.business_category_id === businessCategoryId && row.work_type === workType) continue;
    actions.push({
      type: "decision_update",
      decision_memory_id: row.id,
      tenant_id: tenantId,
      project_id: projectId,
      business_category_id: businessCategoryId,
      work_type: workType,
      reason_code: "classified"
    });
  }

  return {
    tenant_id: tenantId,
    scanned_count: rows.length,
    categories: [...categories.values()],
    actions,
    stats: {
      update_count: actions.length,
      unclassified_after_plan: 0
    }
  };
}
