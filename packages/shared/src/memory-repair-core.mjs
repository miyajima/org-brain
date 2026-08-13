import {
  buildProjectCategoryIdentity,
  extractDurableMemoryDrafts,
  normalizeMemoryPaths,
  screenSensitiveMemory
} from "./memory-capture-v2-runtime.mjs";

const VALID_WORK_TYPES = new Set([
  "implementation", "review", "debug", "proposal",
  "support", "research", "operations", "other"
]);
const DURABLE_KINDS = new Set(["decision", "constraint", "pitfall", "preference", "fact"]);
const AUTOMATIC_SOURCES = new Set(["codex", "claude", "cursor", "openclaw", "opencode", "hook"]);

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

export async function planMemoryRepairRows(rows, options = {}) {
  const tenantId = options.tenant_id ?? "default";
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const workspaceRoot = options.workspace_root ?? null;
  const sensitivePolicy = options.sensitive_policy ?? { mode: "deny", allowed_principals: [] };
  const actions = [];
  const candidates = [];
  const credentialRotation = [];
  const categories = new Map();

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
    const extraction = extractDurableMemoryDrafts({
      event_id: `repair:${row.id}`,
      tenant_id: tenantId,
      project_id: projectId,
      source: row.source ?? "repair",
      occurred_at: createdAt,
      text: normalizedContent
    }, {
      workspace_root: workspaceRoot,
      sensitive_policy: sensitivePolicy,
      max_candidates: 3
    });
    const rawExpiry = row.valid_until ?? row.expires_at;
    const expiry = rawExpiry === null || rawExpiry === undefined ? null : Number(rawExpiry);
    if (alreadySuppressed) {
      if (persistedSensitivity.hard_reject) {
        credentialRotation.push({ memory_id: row.id, reason_code: "rotation_required" });
      }
      continue;
    }
    let suppressReason = null;
    if (persistedSensitivity.hard_reject) {
      suppressReason = "credential_detected";
      credentialRotation.push({ memory_id: row.id, reason_code: "rotation_required" });
    } else if (!persistedSensitivity.allowed) {
      suppressReason = "sensitive_memory_denied";
    } else if (Number.isFinite(expiry) && expiry <= now) {
      suppressReason = "expired";
    } else if (!normalizedContent) {
      suppressReason = "low_quality";
    } else if (extraction.drafts.length === 0 && extraction.excluded.some((item) => item.reason === "transient")) {
      suppressReason = "transient";
    } else if (isLikelyRawHook(row, tags)) {
      suppressReason = extraction.drafts.length > 0 ? "derived_atomic" :
        "low_quality";
    } else if (extraction.drafts.length === 0 && !DURABLE_KINDS.has(row.kind)) {
      suppressReason = "low_quality";
    }

    const workType = VALID_WORK_TYPES.has(row.work_type) ? row.work_type : "other";
    if (!suppressReason) {
      const kind = DURABLE_KINDS.has(row.kind)
        ? row.kind
        : extraction.drafts[0]?.kind ?? "fact";
      const canonicalText = normalizeCanonical(normalizedContent);
      const canonicalKey = await sha256(`${tenantId}\0${projectId || "global"}\0${kind}\0${canonicalText}`);
      const updated = {
        type: "update",
        memory_id: row.id,
        tenant_id: tenantId,
        project_id: projectId,
        business_category_id: businessCategoryId,
        work_type: workType,
        kind,
        content: normalizedContent,
        summary: normalizedSummary,
        tags,
        entities,
        rationale: normalizedRationale,
        reuse_rule: normalizedReuseRule,
        evidence,
        source_references: sourceReferences,
        conflicts,
        canonical_key: canonicalKey,
        valid_until: Number.isFinite(expiry) ? expiry : null,
        confidence_score: Number.isFinite(row.confidence_score) ? row.confidence_score : 0.5,
        utility_score: Number.isFinite(row.utility_score) ? row.utility_score : 0.5,
        created_at: createdAt,
        reason_code: "normalized"
      };
      actions.push(updated);
      candidates.push(updated);
    } else {
      actions.push({
        type: "suppress",
        memory_id: row.id,
        tenant_id: tenantId,
        reason_code: suppressReason,
        created_at: createdAt
      });
    }

    if (suppressReason === "derived_atomic") {
      for (const [index, draft] of extraction.drafts.entries()) {
        const canonicalKey = await sha256(`${tenantId}\0${projectId || "global"}\0${draft.kind}\0${draft.canonical_text}`);
        const externalKey = `repair:${row.id}:${canonicalKey}`.slice(0, 256);
        const idHash = await sha256(`${tenantId}\0${externalKey}`);
        const derived = {
          type: "derive",
          memory_id: `mem_repair_${idHash.slice(0, 24)}`,
          tenant_id: tenantId,
          project_id: projectId,
          business_category_id: businessCategoryId,
          work_type: workType,
          external_key: externalKey,
          kind: draft.kind,
          content: draft.content,
          summary: draft.summary,
          tags: [...new Set([...draft.tags, "repair-v2", `derived-from:${row.id}`])],
          source: "memory-repair",
          source_references: draft.source_references,
          valid_from: draft.valid_from,
          valid_until: draft.valid_until,
          confidence_score: draft.confidence_score,
          utility_score: draft.utility_score,
          rationale: draft.rationale,
          reuse_rule: draft.reuse_rule,
          evidence: draft.evidence,
          canonical_key: canonicalKey,
          root_memory_id: row.id,
          derived_from: row.id,
          visibility: draft.visibility,
          allowed_principals: draft.allowed_principals,
          created_at: createdAt + index,
          reason_code: "atomic_derivation"
        };
        derived.candidate_hash = await hashMemoryCandidateJson(derived);
        actions.push(derived);
        candidates.push(derived);
      }
    }
  }

  const groups = new Map();
  for (const candidate of candidates) {
    const group = groups.get(candidate.canonical_key) ?? [];
    group.push(candidate);
    groups.set(candidate.canonical_key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [winner, ...duplicates] = [...group].sort((left, right) =>
      qualityScore(right) - qualityScore(left) || String(left.memory_id).localeCompare(String(right.memory_id))
    );
    winner.dedupe_winner = true;
    for (const duplicate of duplicates) {
      duplicate.suppressed_by_dedupe = true;
      actions.push({
        type: "suppress",
        memory_id: duplicate.memory_id,
        tenant_id: tenantId,
        reason_code: "duplicate_canonical_key",
        canonical_key: duplicate.canonical_key,
        winner_memory_id: winner.memory_id,
        created_at: duplicate.created_at
      });
    }
  }

  const effectiveActions = actions.filter((action) =>
    !(action.type === "update" || action.type === "derive") || !action.suppressed_by_dedupe
  );
  return {
    tenant_id: tenantId,
    scanned_count: rows.length,
    categories: [...categories.values()],
    actions: effectiveActions,
    credential_rotation_required: credentialRotation,
    stats: {
      derive_count: effectiveActions.filter((action) => action.type === "derive").length,
      update_count: effectiveActions.filter((action) => action.type === "update").length,
      suppress_count: effectiveActions.filter((action) => action.type === "suppress").length,
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
