import { screenSensitiveMemory } from "@org-brain/shared/runtime/memory-capture-v2-runtime";
import { isClassifiedAuto, CLASSIFIED_PROVENANCE_LIMIT } from "./memory-classified-autosave.mjs";
import { createHash, randomUUID } from "node:crypto";

export function hashContent(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function parseJson(raw, fallback = []) {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function parseJsonObject(raw, fallback = null) {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function normalizeStrings(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

export function normalizeObjects(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item)).slice(0, limit);
}

export function json(value) {
  return JSON.stringify(value ?? []);
}

export function nullableString(value, maxLength = 20_000) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function memoryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    business_category_id: row.business_category_id ?? null,
    work_type: row.work_type ?? null,
    kind: row.kind,
    lifecycle_state: row.lifecycle_state,
    scope_type: row.scope_type,
    scope_key: row.scope_key,
    content: row.content,
    summary: row.summary,
    tags: parseJson(row.tags_json),
    entities: parseJson(row.entities_json),
    source: row.source,
    source_references: parseJson(row.source_refs_json),
    external_key: row.external_key,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    owner_principal: row.owner_principal ?? null,
    created_by_principal: row.created_by_principal ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    confidence_score: row.confidence_score,
    utility_score: row.utility_score,
    content_hash: row.content_hash,
    current_version: row.current_version,
    rationale: row.rationale,
    reuse_rule: row.reuse_rule,
    evidence: parseJson(row.evidence_json),
    conflicts: parseJson(row.conflicts_json),
    permissions: parseJson(row.permissions_json),
    canonical_key: row.canonical_key ?? null,
    root_memory_id: row.root_memory_id ?? null,
    expires_at: row.expires_at ?? null,
    deleted_at: row.deleted_at ?? null,
    deleted_by_principal: row.deleted_by_principal ?? null,
    delete_reason: row.delete_reason ?? null,
    capture_origin: row.capture_origin || "legacy",
    capture_route: row.capture_route || "legacy",
    capture_batch_id: row.capture_batch_id ?? null,
    verification_state: row.verification_state || "unverified",
    verified_at: row.verified_at,
    learning: parseJsonObject(row.learning_json),
    quality_dimensions: parseJsonObject(row.quality_dimensions_json)
  };
}


export const WORK_TYPES = new Set([
  "implementation", "review", "debug", "proposal",
  "support", "research", "operations", "other"
]);
function screenSharedMemory(value) {
  if (typeof value === "string") {
    if (!screenSensitiveMemory(value).allowed) throw new Error("sensitive_memory_denied");
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      screenSharedMemory(key);
      screenSharedMemory(entry);
    }
  }
}

export function normalizeRecord(input, fallback = null) {
  const content = nullableString(input.content, 20_000);
  if (!content) throw new Error("content must not be empty");
  const tenantId = nullableString(input.tenant_id, 128) || "default";
  const projectId = nullableString(input.project_id, 128);
  const businessCategoryId = nullableString(input.business_category_id, 128) ?? fallback?.business_category_id ?? null;
  if (input.work_type !== undefined && input.work_type !== null && !WORK_TYPES.has(input.work_type)) {
    throw new Error("invalid_work_type");
  }
  const workType = WORK_TYPES.has(input.work_type)
    ? input.work_type
    : fallback?.work_type ?? null;
  const kind = [
    "episodic",
    "semantic",
    "org_knowledge",
    "fact",
    "decision",
    "constraint",
    "pitfall",
    "preference"
  ].includes(input.kind)
    ? input.kind
    : "episodic";
  const lifecycleState = ["active", "suppressed", "consolidated", "promoted"].includes(input.lifecycle_state)
    ? input.lifecycle_state
    : "active";
  const scopeType = ["tenant", "project", "org"].includes(input.scope_type)
    ? input.scope_type
    : projectId
      ? "project"
      : "tenant";
  const captureOrigin = ["observed", "synthetic", "repair", "legacy"].includes(input.capture_origin)
    ? input.capture_origin
    : fallback?.capture_origin ?? "legacy";
  const captureRoute = ["realtime_hook", "initial_import", "manual", "repair", "legacy"].includes(input.capture_route)
    ? input.capture_route
    : fallback?.capture_route ?? "legacy";
  const verificationState = ["verified", "partial", "unverified", "rejected"].includes(input.verification_state)
    ? input.verification_state
    : fallback?.verification_state ?? "unverified";
  const learning = input.learning && typeof input.learning === "object" && !Array.isArray(input.learning)
    ? input.learning
    : fallback?.learning ?? null;
  const qualityDimensions = input.quality_dimensions && typeof input.quality_dimensions === "object" && !Array.isArray(input.quality_dimensions)
    ? Object.fromEntries(Object.entries(input.quality_dimensions).map(([key, raw]) => {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("invalid_quality_dimension");
      return [key.slice(0, 80), value];
    }))
    : fallback?.quality_dimensions ?? null;
  const verifiedAt = finiteNumber(input.verified_at) ?? fallback?.verified_at ?? null;
  if (verificationState === "verified" && (captureOrigin !== "observed" || !learning || !verifiedAt)) {
    throw new Error("invalid_verified_learning");
  }
  const now = Date.now();
  const record = {
    id: nullableString(input.id, 128) || fallback?.id || randomUUID(),
    tenant_id: tenantId,
    project_id: projectId,
    business_category_id: businessCategoryId,
    work_type: workType,
    kind,
    lifecycle_state: lifecycleState,
    scope_type: scopeType,
    scope_key: nullableString(input.scope_key, 128) || projectId || tenantId,
    content,
    summary: nullableString(input.summary, 1000),
    tags: normalizeStrings(input.tags),
    entities: normalizeStrings(input.entities),
    source: nullableString(input.source, 64) || "local",
    source_references: normalizeObjects(input.source_references,isClassifiedAuto(input)?CLASSIFIED_PROVENANCE_LIMIT:64),
    external_key: nullableString(input.external_key, 256),
    actor_type: nullableString(input.actor_type, 64),
    actor_id: nullableString(input.actor_id, 128),
    created_at: finiteNumber(input.created_at) || fallback?.created_at || now,
    updated_at: finiteNumber(input.updated_at) || now,
    valid_from: finiteNumber(input.valid_from),
    valid_until: finiteNumber(input.valid_until),
    confidence_score: finiteNumber(input.confidence_score),
    utility_score: finiteNumber(input.utility_score),
    content_hash: hashContent(content),
    current_version: Math.max(1, Number(input.current_version || fallback?.current_version || 1)),
    rationale: nullableString(input.rationale, 4000),
    reuse_rule: nullableString(input.reuse_rule, 1000),
    evidence: normalizeObjects(input.evidence,isClassifiedAuto(input)?CLASSIFIED_PROVENANCE_LIMIT:64),
    conflicts: normalizeStrings(input.conflicts),
    permissions: normalizeObjects(input.permissions),
    canonical_key: nullableString(input.canonical_key, 256),
    root_memory_id: nullableString(input.root_memory_id, 128) || fallback?.root_memory_id || input.id,
    last_accessed_at: finiteNumber(input.last_accessed_at),
    suppressed_at: lifecycleState === "suppressed" ? now : finiteNumber(input.suppressed_at),
    consolidated_at: finiteNumber(input.consolidated_at),
    promoted_at: finiteNumber(input.promoted_at),
    expires_at: finiteNumber(input.expires_at) ?? finiteNumber(input.valid_until),
    revised_at: finiteNumber(input.revised_at) || now
    , capture_origin: captureOrigin
    , capture_route: captureRoute
    , capture_batch_id: nullableString(input.capture_batch_id, 128) ?? fallback?.capture_batch_id ?? null
    , verification_state: verificationState
    , verified_at: verificationState === "verified" ? verifiedAt : null
    , learning
    , quality_dimensions: qualityDimensions
  };
  if (tenantId === "all") {
    if (projectId !== null || scopeType === "project" || record.permissions.length) {
      throw new Error("invalid_shared_scope");
    }
    for (const [field, value] of Object.entries(record)) {
      if (!["id", "content_hash", "root_memory_id"].includes(field)) screenSharedMemory(value);
    }
    // UUIDs can contain digit runs that resemble phone numbers. Exempt only
    // canonical v4 UUIDs in these identifier fields.
    for (const identifier of [record.id, record.root_memory_id]) {
      const isUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(identifier);
      if (!isUuid) screenSharedMemory(identifier);
    }
  }
  return record;
}

