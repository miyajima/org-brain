import {
  verifiedKnowledgeBundleV1Schema,
  type VerifiedKnowledgeBundleV1,
  type VerifiedKnowledgeCandidate
} from "@org-brain/contracts";
import {
  digestCanonical,
  evaluateVerifiedKnowledgeBundle,
  HttpError,
  screenMemoryText,
  ulid,
  verifySignedVerifiedKnowledgeBundle,
  type VerifiedBundleEvaluation
} from "@org-brain/shared";
import { assertPermission, authorizePermission } from "./rbac-service";
import type { Env } from "./types";

type CollectorKeyRow = {
  id: string;
  tenant_id: string;
  principal: string;
  public_key_json: string;
  algorithm: string;
  state: "active" | "revoked";
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalString(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function maskedManifest(bundle: VerifiedKnowledgeBundleV1): VerifiedKnowledgeBundleV1 {
  const mask = (value: string | null | undefined): string | undefined => typeof value === "string" ? screenMemoryText(value).text.slice(0, 2_000) : undefined;
  const span = (value: { excerpt?: string } & Record<string, unknown>) => ({ ...value, ...(value.excerpt ? { excerpt: mask(value.excerpt) } : {}) });
  return {
    ...bundle,
    new_input_refs: bundle.new_input_refs.map((ref) => ({ ...ref, ...(ref.excerpt ? { excerpt: mask(ref.excerpt) } : {}) })),
    background_refs: bundle.background_refs.map((ref) => ({ ...ref, ...(ref.excerpt ? { excerpt: mask(ref.excerpt) } : {}) })),
    candidates: bundle.candidates.map((candidate) => ({
      ...candidate,
      value: mask(candidate.value) ?? "",
      ...(candidate.summary ? { summary: mask(candidate.summary) } : {}),
      source_spans: candidate.source_spans.map((sourceSpan) => span(sourceSpan as unknown as { excerpt?: string } & Record<string, unknown>) as typeof sourceSpan)
    })),
    evidence_receipts: bundle.evidence_receipts.map((receipt) => ({
      ...receipt,
      source_span: span(receipt.source_span as unknown as { excerpt?: string } & Record<string, unknown>) as typeof receipt.source_span
    }))
  };
}

function parsePublicJwk(value: unknown): JsonWebKey {
  const input = objectValue(value);
  if (!input || input.kty !== "EC" || input.crv !== "P-256" || typeof input.x !== "string" || typeof input.y !== "string") {
    throw new HttpError(400, "invalid_public_key", "public_key must be an ECDSA P-256 public JWK");
  }
  return input as JsonWebKey;
}

function ingestionMode(env: Env): "off" | "shadow" | "beta" | "on" {
  const value = env.VERIFIED_INGESTION_MODE ?? "off";
  if (value !== "off" && value !== "shadow" && value !== "beta" && value !== "on") throw new HttpError(500, "misconfigured", "VERIFIED_INGESTION_MODE is invalid");
  return value;
}

async function loadCollectorKey(env: Env, tenantId: string, keyId: string): Promise<CollectorKeyRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, tenant_id, principal, public_key_json, algorithm, state, created_at, expires_at, revoked_at FROM local_collector_keys WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, keyId).first<CollectorKeyRow>();
  if (!row) throw new HttpError(401, "collector_key_unknown", "Collector key is not registered");
  if (row.state !== "active" || (row.expires_at !== null && row.expires_at <= Date.now())) throw new HttpError(401, "collector_key_revoked", "Collector key is not active");
  if (row.algorithm !== "ECDSA-P256-SHA256") throw new HttpError(401, "collector_key_algorithm_invalid", "Collector key algorithm is not supported");
  return row;
}

export async function registerCollectorKey(env: Env, tenantId: string, raw: unknown, actorPrincipal: string) {
  const body = objectValue(raw);
  if (!body) throw new HttpError(400, "invalid_payload", "request body must be an object");
  const id = optionalString(body.key_id ?? body.id, 128) ?? ulid();
  const principal = optionalString(body.principal, 128) ?? actorPrincipal;
  const key = parsePublicJwk(body.public_key);
  try {
    await crypto.subtle.importKey("jwk", key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    throw new HttpError(400, "invalid_public_key", "public_key is not a valid P-256 JWK");
  }
  const expiresAt = body.expires_at === undefined || body.expires_at === null ? null : Number(body.expires_at);
  if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= Date.now())) throw new HttpError(400, "invalid_payload", "expires_at must be a future timestamp");
  const existing = await env.OPEN_BRAIN_DB.prepare("SELECT id, state FROM local_collector_keys WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first<{ id: string; state: string }>();
  if (existing?.state === "active") throw new HttpError(409, "collector_key_exists", "Collector key already exists");
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO local_collector_keys(id, tenant_id, principal, public_key_json, algorithm, state, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)"
  ).bind(id, tenantId, principal, JSON.stringify(key), "ECDSA-P256-SHA256", "active", now, expiresAt).run();
  return { id, tenant_id: tenantId, principal, algorithm: "ECDSA-P256-SHA256", state: "active", created_at: now, expires_at: expiresAt };
}

export async function revokeCollectorKey(env: Env, tenantId: string, keyId: string, actorPrincipal: string) {
  const now = Date.now();
  const result = await env.OPEN_BRAIN_DB.prepare(
    "UPDATE local_collector_keys SET state = 'revoked', revoked_at = ?, revoked_by_principal = ? WHERE tenant_id = ? AND id = ? AND state = 'active'"
  ).bind(now, actorPrincipal, tenantId, keyId).run();
  if (!result.meta.changes) throw new HttpError(404, "collector_key_not_found", "Collector key not found or already revoked");
  return { id: keyId, tenant_id: tenantId, state: "revoked", revoked_at: now };
}

export async function listVerifiedManifestsByCollector(env: Env, tenantId: string, keyId: string) {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, bundle_key, bundle_digest, source_digest, verification_state, verification_reasons_json, projected_decision_id, projected_memory_id, created_at, updated_at FROM verified_ingestion_manifests WHERE tenant_id = ? AND collector_key_id = ? ORDER BY created_at DESC LIMIT 500"
  ).bind(tenantId, keyId).all<Record<string, unknown>>();
  return rows.results.map((row) => {
    let reasons: unknown[] = [];
    try {
      const parsed = JSON.parse(String(row.verification_reasons_json ?? "[]")) as unknown;
      reasons = Array.isArray(parsed) ? parsed : [];
    } catch {
      reasons = [];
    }
    return { ...row, verification_reasons: reasons };
  });
}

async function eventChainValid(bundle: VerifiedKnowledgeBundleV1): Promise<boolean> {
  return (await digestCanonical([...bundle.new_input_refs, ...bundle.background_refs].map((ref) => ({
    event_id: ref.event_id,
    digest: ref.digest,
    is_new_input: ref.is_new_input
  })))) === bundle.event_chain_hash;
}

async function sourceDigestValid(bundle: VerifiedKnowledgeBundleV1): Promise<boolean> {
  return (await digestCanonical(bundle.new_input_refs.map((ref) => ({ event_id: ref.event_id, digest: ref.digest })))) === bundle.source_digest;
}

function first(bundle: VerifiedKnowledgeBundleV1, type: VerifiedKnowledgeCandidate["candidate_type"]): VerifiedKnowledgeCandidate | null {
  return bundle.candidates.find((candidate) => candidate.candidate_type === type) ?? null;
}

async function findSemanticProjection(env: Env, bundle: VerifiedKnowledgeBundleV1, decision: VerifiedKnowledgeCandidate) {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, origin_memory_id, decision, source_refs_json FROM decision_memories WHERE tenant_id = ? AND project_id IS ? AND origin_source = 'verified_ingestion' AND status NOT IN ('retired', 'superseded') ORDER BY updated_at DESC LIMIT 200"
  ).bind(bundle.tenant_id, bundle.project_id ?? null).all<{
    id: string;
    origin_memory_id: string | null;
    decision: string;
    source_refs_json: string | null;
  }>();
  for (const row of rows.results) {
    let refs: unknown = [];
    try { refs = JSON.parse(row.source_refs_json ?? "[]"); } catch { refs = []; }
    const semantic = Array.isArray(refs)
      && refs.some((ref) => ref && typeof ref === "object" && !Array.isArray(ref)
        && (ref as Record<string, unknown>).type === "semantic_key"
        && (ref as Record<string, unknown>).id === decision.semantic_key);
    if (semantic || (!decision.semantic_key && row.decision === decision.value)) return row;
  }
  return null;
}

async function hasSemanticConflict(env: Env, bundle: VerifiedKnowledgeBundleV1, decision: VerifiedKnowledgeCandidate) {
  if (!decision.semantic_key) return false;
  const rows = await env.OPEN_BRAIN_DB.prepare(
    "SELECT decision, source_refs_json FROM decision_memories WHERE tenant_id = ? AND project_id IS ? AND origin_source = 'verified_ingestion' AND status NOT IN ('retired', 'superseded') LIMIT 200"
  ).bind(bundle.tenant_id, bundle.project_id ?? null).all<{ decision: string; source_refs_json: string | null }>();
  return rows.results.some((row) => {
    let refs: unknown = [];
    try { refs = JSON.parse(row.source_refs_json ?? "[]"); } catch { refs = []; }
    const semantic = Array.isArray(refs) && refs.some((ref) => ref && typeof ref === "object" && !Array.isArray(ref)
      && (ref as Record<string, unknown>).type === "semantic_key" && (ref as Record<string, unknown>).id === decision.semantic_key);
    return semantic && row.decision !== decision.value;
  });
}

async function persistBindings(env: Env, bundle: VerifiedKnowledgeBundleV1, manifestId: string, decisionId: string, memoryId: string) {
  const statements = [];
  for (const binding of bundle.field_bindings) {
    const candidate = bundle.candidates.find((item) => item.candidate_id === binding.candidate_id);
    const span = candidate?.source_spans[binding.source_span_index];
    const receipt = bundle.evidence_receipts.find((item) => item.receipt_id === binding.receipt_id);
    if (!candidate || !span || !receipt) continue;
    const entityType = binding.entity === "decision" || binding.entity === "reason" ? "decision_memory" : "memory";
    const entityId = entityType === "decision_memory" ? decisionId : memoryId;
    statements.push(env.OPEN_BRAIN_DB.prepare(
      "INSERT OR IGNORE INTO knowledge_provenance_bindings(id, tenant_id, manifest_id, entity_type, entity_id, field_name, source_event_id, source_span_json, receipt_id, source_digest, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(ulid(), bundle.tenant_id, manifestId, entityType, entityId, binding.field, span.event_id, JSON.stringify(span), receipt.receipt_id, receipt.digest, Date.now()));
  }
  for (const edge of bundle.edge_bindings) {
    const receipt = bundle.evidence_receipts.find((item) => edge.receipt_ids.includes(item.receipt_id));
    if (!receipt) continue;
    statements.push(env.OPEN_BRAIN_DB.prepare(
      "INSERT OR IGNORE INTO knowledge_provenance_bindings(id, tenant_id, manifest_id, entity_type, entity_id, edge_relation, source_event_id, source_span_json, receipt_id, source_digest, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(ulid(), bundle.tenant_id, manifestId, "edge", edge.source_candidate_id, edge.relation, receipt.event_id, JSON.stringify(receipt.source_span), receipt.receipt_id, receipt.digest, Date.now()));
  }
  if (statements.length) await env.OPEN_BRAIN_DB.batch(statements);
}

async function persistProjectedResources(env: Env, bundle: VerifiedKnowledgeBundleV1, manifestId: string, decisionId: string, memoryId: string, actorPrincipal: string) {
  const artifacts = bundle.candidates.filter((candidate) => candidate.candidate_type === "artifact" && candidate.artifact_ref && candidate.content_hash);
  const evidence = bundle.candidates.filter((candidate) => candidate.candidate_type === "evidence");
  if (!artifacts.length && !evidence.length) return;
  const rationale = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM decision_rationales WHERE tenant_id = ? AND memory_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(bundle.tenant_id, memoryId).first<{ id: string }>();
  const rationaleId = rationale?.id ?? "verified_rationale_" + bundle.bundle_digest.slice(0, 32);
  const statements = [];
  for (const artifact of artifacts) {
    const artifactRef = artifact.artifact_ref as string;
    const contentHash = artifact.content_hash as string;
    const resourceDigest = await digestCanonical({ tenant_id: bundle.tenant_id, artifact_ref: artifactRef });
    const versionDigest = await digestCanonical({ resource_digest: resourceDigest, content_hash: contentHash });
    const resourceId = "verified_resource_" + resourceDigest.slice(0, 32);
    const versionId = "verified_resource_version_" + versionDigest.slice(0, 32);
    const uri = `verified://${bundle.tenant_id}/${encodeURIComponent(artifactRef)}`;
    const assertionId = "verified_assertion_" + await digestCanonical({ decision_id: decisionId, resource_id: resourceId });
    const receipt = bundle.evidence_receipts.find((item) => item.event_id === artifact.source_event_ids[0]);
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        "INSERT OR IGNORE INTO knowledge_resources(id, tenant_id, project_id, resource_kind, canonical_uri, title, source_system, media_type, visibility, permissions_json, current_version_id, lifecycle_state, created_by_principal, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(resourceId, bundle.tenant_id, bundle.project_id ?? null, "other", uri, artifactRef, "verified_ingestion", "application/octet-stream", bundle.project_id ? "project" : "tenant", "[]", null, "active", actorPrincipal, bundle.created_at, bundle.created_at),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT OR IGNORE INTO knowledge_resource_locations(id, tenant_id, resource_id, uri, normalized_uri, location_role, connector_id, fetch_enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
      ).bind(resourceId + ":location", bundle.tenant_id, resourceId, uri, uri, "canonical", "verified-collector", 0, bundle.created_at, bundle.created_at),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT OR IGNORE INTO knowledge_resource_versions(id, tenant_id, resource_id, connector_id, source_version, etag, last_modified, content_hash, snapshot_object_ref, extracted_text, extracted_text_hash, extraction_state, captured_at, created_by_principal, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(versionId, bundle.tenant_id, resourceId, "verified-collector", "bundle:" + bundle.bundle_digest, null, null, contentHash, uri + "#" + contentHash, artifactRef, await digestCanonical(artifactRef), "ready", bundle.created_at, actorPrincipal, bundle.created_at),
      env.OPEN_BRAIN_DB.prepare("UPDATE knowledge_resources SET current_version_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").bind(versionId, bundle.created_at, bundle.tenant_id, resourceId),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT OR IGNORE INTO knowledge_assertions(id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate, object_type, object_ref, resource_id, context_json, confidence, confirmation_state, idempotency_key, valid_from, valid_until, actor_principal, reviewed_by_principal, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(assertionId, bundle.tenant_id, bundle.project_id ?? null, "relation", "decision_memory", decisionId, "artifact", "knowledge_resource", resourceId, resourceId, JSON.stringify({ manifest_id: manifestId }), 1, "confirmed", assertionId, bundle.created_at, null, actorPrincipal, actorPrincipal, bundle.created_at, bundle.created_at),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT OR IGNORE INTO knowledge_assertion_evidence(id, tenant_id, assertion_id, resource_id, resource_version_id, locator_json, excerpt_digest, note, created_at) VALUES(?,?,?,?,?,?,?,?,?)"
      ).bind(assertionId + ":evidence", bundle.tenant_id, assertionId, resourceId, versionId, JSON.stringify(artifact.source_spans[0] ?? null), await digestCanonical(artifact.source_spans[0] ?? artifactRef), artifactRef, bundle.created_at),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT OR IGNORE INTO knowledge_provenance_bindings(id, tenant_id, manifest_id, entity_type, entity_id, field_name, source_event_id, source_span_json, receipt_id, source_digest, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
      ).bind("provenance:" + resourceId + ":" + versionId, bundle.tenant_id, manifestId, "knowledge_resource_version", versionId, "content_hash", artifact.source_event_ids[0], JSON.stringify(artifact.source_spans[0] ?? null), receipt?.receipt_id ?? "receipt:" + artifact.source_event_ids[0], receipt?.digest ?? bundle.source_digest, bundle.created_at)
    );
  }
  for (const item of evidence) {
    const receipt = bundle.evidence_receipts.find((candidate) => candidate.event_id === item.source_event_ids[0]);
    if (!receipt) continue;
    statements.push(env.OPEN_BRAIN_DB.prepare(
      "INSERT OR IGNORE INTO decision_evidence(id, tenant_id, rationale_id, evidence_type, evidence_ref, relation, note, weight_score, created_at) VALUES(?,?,?,?,?,?,?,?,?)"
    ).bind("verified_evidence_" + await digestCanonical({ rationale_id: rationaleId, candidate_id: item.candidate_id }), bundle.tenant_id, rationaleId, receipt.evidence_type, receipt.event_id, "supports:" + item.candidate_id, item.value, 1, bundle.created_at));
  }
  if (statements.length) await env.OPEN_BRAIN_DB.batch(statements);
}

async function projectActiveBundle(env: Env, bundle: VerifiedKnowledgeBundleV1, manifestId: string, actorPrincipal: string) {
  const decision = first(bundle, "decision");
  const reason = first(bundle, "reason");
  if (!decision || !reason) return { decision_id: null, memory_id: null, created: false };
  const hasExplicitSupersedes = bundle.edge_bindings.some((edge) => edge.relation === "decision_supersedes");
  const priorByBundle = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, origin_memory_id FROM decision_memories WHERE tenant_id = ? AND origin_source = 'verified_ingestion' AND origin_external_key = ? LIMIT 1"
  ).bind(bundle.tenant_id, bundle.bundle_key).first<{ id: string; origin_memory_id: string | null }>();
  const semanticPrior = decision.semantic_key ? await findSemanticProjection(env, bundle, decision) : null;
  const prior = priorByBundle ?? (hasExplicitSupersedes ? null : semanticPrior);
  const now = Date.now();
  const decisionId = prior?.id ?? "verified_decision_" + bundle.bundle_digest.slice(0, 32);
  const memoryId = prior?.origin_memory_id ?? "verified_memory_" + bundle.bundle_digest.slice(0, 32);
  if (!prior) {
    await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO memories(id, tenant_id, project_id, content, summary, tags_json, created_at, kind, lifecycle_state, scope_type, scope_key, actor_type, actor_id, current_version, updated_at, content_hash, rationale, evidence_json, permissions_json, canonical_key, capture_origin, capture_route, verification_state, verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        memoryId, bundle.tenant_id, bundle.project_id ?? null, decision.value, decision.summary ?? decision.value.slice(0, 500),
        JSON.stringify(["verified-ingestion", "decision"]), now, "decision", "active", bundle.project_id ? "project" : "tenant",
        bundle.project_id ?? bundle.tenant_id, decision.actor_type ?? "human", decision.actor_id ?? actorPrincipal,
        1, now, bundle.source_digest, reason.value,
        JSON.stringify(bundle.evidence_receipts.map((receipt) => ({ type: receipt.evidence_type, ref: receipt.event_id, digest: receipt.digest }))),
        "[]", bundle.bundle_key, "observed", "initial_import", "verified", now
      ),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO decision_memories(id, tenant_id, project_id, domain, title, decision, rationale, source_refs_json, owner_refs_json, status, confidence, visibility, allowed_principals_json, created_at, updated_at, origin_memory_id, origin_source, origin_external_key, auto_generated, confirmation_state, confirmation_note, confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        decisionId, bundle.tenant_id, bundle.project_id ?? null, "verified-ingestion", decision.summary ?? "Verified decision",
        decision.value, reason.value,
        JSON.stringify([
          ...bundle.new_input_refs.map((ref) => ({ type: "session_event", id: ref.event_id, digest: ref.digest })),
          ...(decision.semantic_key ? [{ type: "semantic_key", id: decision.semantic_key }] : [])
        ]),
        JSON.stringify([{ type: "principal", id: decision.actor_id ?? actorPrincipal }]), "active", 1, "tenant", "[]",
        now, now, memoryId, "verified_ingestion", bundle.bundle_key, 1, "user_confirmed", "Signed local evidence bundle", now
      )
    ]);
    await env.OPEN_BRAIN_DB.prepare(
      "INSERT INTO decision_rationales(id, tenant_id, memory_id, project_id, decision_type, conclusion, reason_summary, status, confirmation_state, confidence_score, created_at, confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      "verified_rationale_" + bundle.bundle_digest.slice(0, 32), bundle.tenant_id, memoryId, bundle.project_id ?? null,
      "user_choice", decision.value, reason.value, "active", "confirmed", 1, now, now
    ).run();
    if (hasExplicitSupersedes && semanticPrior) {
      await env.OPEN_BRAIN_DB.batch([
        env.OPEN_BRAIN_DB.prepare(
          "UPDATE decision_memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
        ).bind(decisionId, now, bundle.tenant_id, semanticPrior.id),
        env.OPEN_BRAIN_DB.prepare(
          "UPDATE decision_rationales SET status = 'superseded', superseded_by = ? WHERE tenant_id = ? AND memory_id = ? AND superseded_by IS NULL"
        ).bind(decisionId, bundle.tenant_id, semanticPrior.origin_memory_id ?? "")
      ]);
    }
  } else {
    const existingDecision = await env.OPEN_BRAIN_DB.prepare(
      "SELECT source_refs_json FROM decision_memories WHERE tenant_id = ? AND id = ?"
    ).bind(bundle.tenant_id, decisionId).first<{ source_refs_json: string | null }>();
    const existingMemory = await env.OPEN_BRAIN_DB.prepare(
      "SELECT evidence_json FROM memories WHERE tenant_id = ? AND id = ?"
    ).bind(bundle.tenant_id, memoryId).first<{ evidence_json: string | null }>();
    const parseList = (value: string | null | undefined): Record<string, unknown>[] => {
      try {
        const parsed = JSON.parse(value ?? "[]") as unknown;
        return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
      } catch {
        return [];
      }
    };
    const refs = [...parseList(existingDecision?.source_refs_json), ...bundle.new_input_refs.map((ref) => ({ type: "session_event", id: ref.event_id, digest: ref.digest }))];
    const uniqueRefs = [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()];
    const evidence = [...parseList(existingMemory?.evidence_json), ...bundle.evidence_receipts.map((receipt) => ({ type: receipt.evidence_type, ref: receipt.event_id, digest: receipt.digest }))];
    const uniqueEvidence = [...new Map(evidence.map((item) => [JSON.stringify(item), item])).values()];
    await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare("UPDATE decision_memories SET source_refs_json = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").bind(JSON.stringify(uniqueRefs), now, bundle.tenant_id, decisionId),
      env.OPEN_BRAIN_DB.prepare("UPDATE memories SET evidence_json = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").bind(JSON.stringify(uniqueEvidence), now, bundle.tenant_id, memoryId)
    ]);
  }
  await persistBindings(env, bundle, manifestId, decisionId, memoryId);
  await persistProjectedResources(env, bundle, manifestId, decisionId, memoryId, actorPrincipal);
  return { decision_id: decisionId, memory_id: memoryId, created: !prior };
}

function response(id: string, bundle: VerifiedKnowledgeBundleV1, evaluation: VerifiedBundleEvaluation, projection: { decision_id: string | null; memory_id: string | null; created: boolean } | null, duplicate = false) {
  return {
    manifest_id: id,
    bundle_key: bundle.bundle_key,
    bundle_digest: bundle.bundle_digest,
    verification_state: duplicate ? "duplicate" : evaluation.state,
    verification_reasons: evaluation.reasons,
    missing_stages: evaluation.missing_stages,
    provenance_coverage: evaluation.provenance_coverage,
    evidence_count: evaluation.evidence_count,
    candidate_count: evaluation.candidate_count,
    edge_count: evaluation.edge_count,
    projected_decision_id: projection?.decision_id ?? null,
    projected_memory_id: projection?.memory_id ?? null,
    projected_created: projection?.created ?? false
  };
}

export async function ingestVerifiedKnowledgeBundle(
  env: Env,
  tenantId: string,
  raw: unknown,
  actorPrincipal: string,
  options: { publishAuthorized?: boolean; allowShadow?: boolean } = {}
) {
  const currentMode = ingestionMode(env);
  if (currentMode === "off" && !options.allowShadow) throw new HttpError(404, "feature_disabled", "Verified ingestion is not enabled");
  const body = objectValue(raw);
  const parsed = verifiedKnowledgeBundleV1Schema.safeParse(objectValue(body?.bundle) ?? body);
  if (!parsed.success) throw new HttpError(400, "invalid_verified_bundle", parsed.error.issues[0]?.message ?? "Invalid verified bundle");
  const bundle = parsed.data;
  if (bundle.tenant_id !== tenantId) throw new HttpError(403, "cross_tenant_bundle", "Bundle tenant does not match authenticated tenant");
  const key = await loadCollectorKey(env, tenantId, bundle.collector_key_id);
  if (key.principal !== actorPrincipal) throw new HttpError(403, "collector_principal_mismatch", "Collector key belongs to another principal");
  let publicKey: JsonWebKey;
  try { publicKey = JSON.parse(key.public_key_json) as JsonWebKey; } catch { throw new HttpError(500, "collector_key_corrupt", "Stored collector key is invalid"); }
  const signature = await verifySignedVerifiedKnowledgeBundle(bundle, publicKey);
  const chainValid = await eventChainValid(bundle);
  const sourceValid = await sourceDigestValid(bundle);
  const auth = await authorizePermission(env, { tenantId, principal: actorPrincipal, projectId: bundle.project_id ?? null, permission: "memory:attest" });
  let evaluation = evaluateVerifiedKnowledgeBundle(bundle, {
    signature_valid: signature.valid,
    event_chain_valid: chainValid,
    publish_authorized: options.publishAuthorized ?? auth.allowed
  });
  const decision = first(bundle, "decision");
  if (decision && await hasSemanticConflict(env, bundle, decision) && !bundle.edge_bindings.some((edge) => edge.relation === "decision_supersedes")) {
    evaluation = {
      ...evaluation,
      state: "extractor_disagreement",
      reasons: [...new Set([...evaluation.reasons, "semantic_key_content_changed_without_supersedes"])],
      missing_stages: [...evaluation.missing_stages]
    };
  }
  if (!sourceValid) {
    evaluation = {
      ...evaluation,
      state: "quarantined",
      reasons: [...new Set([...evaluation.reasons, "source_digest_invalid"])],
      missing_stages: [...evaluation.missing_stages]
    };
  }
  const prior = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM verified_ingestion_manifests WHERE tenant_id = ? AND bundle_key = ? AND bundle_digest = ?"
  ).bind(tenantId, bundle.bundle_key, bundle.bundle_digest).first<{ id: string }>();
  if (prior) return response(prior.id, bundle, evaluation, null, true);
  const id = ulid();
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO verified_ingestion_manifests(id, tenant_id, bundle_key, bundle_digest, source_digest, scene_key, collector_key_id, extraction_profile_id, extraction_profile_version, extraction_profile_hash, manifest_json, verification_state, verification_reasons_json, missing_stages_json, provenance_coverage, evidence_count, candidate_count, edge_count, created_by_principal, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    id, tenantId, bundle.bundle_key, bundle.bundle_digest, bundle.source_digest, bundle.scene_key,
    bundle.collector_key_id, bundle.extraction_profile_ref.profile_id, bundle.extraction_profile_ref.version,
    bundle.extraction_profile_ref.hash, JSON.stringify(maskedManifest(bundle)), evaluation.state, JSON.stringify(evaluation.reasons),
    JSON.stringify(evaluation.missing_stages), evaluation.provenance_coverage, evaluation.evidence_count,
    evaluation.candidate_count, evaluation.edge_count, actorPrincipal, now, now
  ).run();
  let projection: { decision_id: string | null; memory_id: string | null; created: boolean } | null = null;
  if (evaluation.state === "active" && env.VERIFIED_AUTO_PROMOTE === "on" && currentMode !== "shadow") {
    projection = await projectActiveBundle(env, bundle, id, actorPrincipal);
    await env.OPEN_BRAIN_DB.prepare(
      "UPDATE verified_ingestion_manifests SET projected_decision_id = ?, projected_memory_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
    ).bind(projection.decision_id, projection.memory_id, now, tenantId, id).run();
  }
  return response(id, bundle, evaluation, projection);
}

export async function getVerifiedIngestionManifest(env: Env, tenantId: string, manifestId: string, principal?: string) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, tenant_id, bundle_key, bundle_digest, source_digest, scene_key, collector_key_id, extraction_profile_id, extraction_profile_version, extraction_profile_hash, manifest_json, verification_state, verification_reasons_json, missing_stages_json, provenance_coverage, evidence_count, candidate_count, edge_count, projected_decision_id, projected_memory_id, created_by_principal, created_at, updated_at FROM verified_ingestion_manifests WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, manifestId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "manifest_not_found", "Verified ingestion manifest not found");
  const parseJson = (value: unknown) => {
    try { return JSON.parse(String(value ?? "[]")); } catch { return []; }
  };
  const manifest = parseJson(row.manifest_json);
  if (principal && manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
    const projectId = typeof (manifest as Record<string, unknown>).project_id === "string" ? (manifest as Record<string, unknown>).project_id as string : null;
    const authorized = await authorizePermission(env, { tenantId, projectId, principal, permission: "read" });
    if (!authorized.allowed) throw new HttpError(403, "forbidden", "Manifest is outside the principal scope");
  }
  return { ...row, manifest, verification_reasons: parseJson(row.verification_reasons_json), missing_stages: parseJson(row.missing_stages_json) };
}

export async function requireVerifiedPublishPermission(env: Env, tenantId: string, principal: string, projectId?: string | null) {
  await assertPermission(env, { tenantId, projectId, principal, permission: "memory:attest" });
}
