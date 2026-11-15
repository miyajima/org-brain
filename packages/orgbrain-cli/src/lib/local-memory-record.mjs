import { createHash } from "node:crypto";

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

