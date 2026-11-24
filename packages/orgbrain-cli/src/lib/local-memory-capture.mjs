import { randomUUID } from "node:crypto";
import { isTransientMemory } from "@org-brain/shared/runtime/memory-admission-runtime";
import { hasConfirmedQuestionAnswer } from "./question-answer-memory.mjs";
import { classifiedAutoSaveEnabled, classifiedMemoryInput, classifySourceMemory, isClassifiedAuto, hasClassifiedAutoInput, mergeClassifiedAutoInput } from "./memory-classified-autosave.mjs";
import { WORK_TYPES, normalizeRecord, nullableString, finiteNumber, memoryFromRow, json } from "./local-memory-record.mjs";
import { writeLocalEmbedding, writeRetrievalUnits, writeRetrievalUnitsV4, writeStableRetrievalUnits } from "./local-memory-projections.mjs";

function classificationRequired() {
  return (process.env.MEMORY_CLASSIFICATION_MODE ?? process.env.ORGBRAIN_CLASSIFICATION_MODE) === "require";
}

export function validateBusinessClassification(db, tenantId, businessCategoryId, workType) {
  if (classificationRequired() && !businessCategoryId) throw new Error("business_category_required");
  if (classificationRequired() && !workType) throw new Error("work_type_required");
  if (workType && !WORK_TYPES.has(workType)) throw new Error("invalid_work_type");
  if (!businessCategoryId) return;
  const category = db.prepare(
    "SELECT id FROM business_categories WHERE tenant_id = ? AND id = ? AND is_active = 1"
  ).get(tenantId, businessCategoryId);
  if (!category) throw new Error("business_category_not_found_or_inactive");
}

function validateActivitySourceReferences(db, record) {
  record.source_references = record.source_references.map((reference) => {
    if (reference.type !== "agent_activity") return reference;
    const rawRef = nullableString(reference.ref, 256);
    const eventId = rawRef?.startsWith("agent-activity:") ? rawRef.slice("agent-activity:".length) : null;
    if (!eventId) throw new Error("invalid_agent_activity_reference");
    const activity = db.prepare(
      `SELECT id, tenant_id, project_id, occurred_at, sequence, action, fidelity, harness_name
       FROM agent_activity_events WHERE tenant_id = ? AND id = ?`
    ).get(record.tenant_id, eventId);
    if (!activity) throw new Error("agent_activity_not_found");
    if ((record.project_id ?? null) !== (activity.project_id ?? null)) {
      throw new Error("agent_activity_scope_mismatch");
    }
    return {
      type: "agent_activity",
      ref: `agent-activity:${activity.id}`,
      event_id: activity.id,
      occurred_at: new Date(Number(activity.occurred_at)).toISOString(),
      sequence: Number(activity.sequence),
      action: activity.action,
      fidelity: activity.fidelity,
      harness_name: activity.harness_name
    };
  });
  return record;
}

function captureComparable(record) {
  return {
    tenant_id: record.tenant_id,
    project_id: record.project_id,
    business_category_id: record.business_category_id,
    work_type: record.work_type,
    kind: record.kind,
    lifecycle_state: record.lifecycle_state,
    scope_type: record.scope_type,
    scope_key: record.scope_key,
    content: record.content,
    summary: record.summary,
    tags: record.tags,
    entities: record.entities,
    source: record.source,
    source_references: record.source_references,
    external_key: record.external_key,
    actor_type: record.actor_type,
    actor_id: record.actor_id,
    created_at: record.created_at,
    valid_from: record.valid_from,
    valid_until: record.valid_until,
    confidence_score: record.confidence_score,
    utility_score: record.utility_score,
    content_hash: record.content_hash,
    rationale: record.rationale,
    reuse_rule: record.reuse_rule,
    evidence: record.evidence,
    conflicts: record.conflicts,
    permissions: record.permissions,
    canonical_key: record.canonical_key,
    root_memory_id: record.root_memory_id,
    expires_at: record.expires_at,
    capture_origin: record.capture_origin,
    capture_route: record.capture_route,
    verification_state: record.verification_state,
    verified_at: record.verified_at,
    learning: record.learning,
    quality_dimensions: record.quality_dimensions
  };
}

function capturePayloadEquivalent(left, right) {
  return JSON.stringify(captureComparable(left)) === JSON.stringify(captureComparable(right));
}

export function captureIntoDatabase(
  db,
  input,
  { updateFeatureStats = true, writeProjections = true } = {}
) {
  // The question-answer handler already checks explicit user authority and verified provenance.
  if(!hasConfirmedQuestionAnswer(input) && (hasClassifiedAutoInput(input)||classifiedAutoSaveEnabled()) && input.kind!=='episodic' && (isClassifiedAuto(input)||input.capture_route==='realtime_hook')){
    if(!hasClassifiedAutoInput(input)&&input.learning?.lesson_type){
      const classified=classifiedMemoryInput({item:input,observation:input.learning,external_key:input.external_key},
        {tenantId:input.tenant_id??'default',projectId:input.project_id,taskKey:input.capture_batch_id});
      if(!classified||classified.held||classified.quarantine)throw Error(classified?.reason_code??'classification_ambiguous');
      const retainVerification=input.kind===classified.kind&&input.verification_state==='verified';
      input={...input,...classified,source:input.source,external_key:input.external_key,capture_origin:input.capture_origin??classified.capture_origin,
        verification_state:retainVerification?'verified':'unverified',verified_at:retainVerification?input.verified_at:null};
    }
    if(!hasClassifiedAutoInput(input)){
      const classified=classifySourceMemory(input,{snapshot:{},candidate:{support_refs:[]}});
      input={...classified,verification_state:input.kind===classified.kind?input.verification_state:'unverified',
        verified_at:input.kind===classified.kind?input.verified_at:null};
    }
    if(isClassifiedAuto(input))input=mergeClassifiedAutoInput(db,input);
  }
  if ((input.capture_origin === 'observed' || input.capture_route === 'realtime_hook') && isTransientMemory(input)) throw new Error('transient_memory_rejected');
  const now = Date.now();
  const tenantId = nullableString(input.tenant_id, 128) || "default";
  if (tenantId === "all" && input.target_tenant_id !== "all") throw new Error("target_tenant_id_required");
  const source = nullableString(input.source, 64) || "local";
  const externalKey = nullableString(input.external_key, 256);
  const existing = externalKey
    ? db.prepare("SELECT * FROM memories WHERE tenant_id = ? AND source = ? AND external_key = ?").get(
        tenantId,
        source,
        externalKey
      )
    : null;
  const id = existing?.id || nullableString(input.id, 128) || randomUUID();
  const createdAt = existing?.created_at || finiteNumber(input.created_at) || now;
  const record = normalizeRecord(
    {
      ...input,
      id,
      tenant_id: tenantId,
      source,
      external_key: externalKey,
      created_at: createdAt,
      updated_at: finiteNumber(input.updated_at) || now,
      current_version: Number(existing?.current_version || 0) + 1
    },
    existing ? memoryFromRow(existing) : null
  );
  validateActivitySourceReferences(db, record);
  validateBusinessClassification(db, tenantId, record.business_category_id, record.work_type);
  if (existing && capturePayloadEquivalent(record, memoryFromRow(existing))) {
    return {
      memory_id: existing.id,
      version: Number(existing.current_version || 1),
      operation: "capture",
      created: false,
      deduplicated: true,
      idempotent: true
    };
  }
  if (record.canonical_key && record.lifecycle_state !== "suppressed") {
    const canonicalExisting = db.prepare(
      `SELECT id, current_version
       FROM memories
       WHERE tenant_id = ? AND canonical_key = ?
         AND id != ?
         AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
       ORDER BY confidence_score DESC, utility_score DESC, updated_at DESC, id
       LIMIT 1`
    ).get(tenantId, record.canonical_key, record.id);
    if (canonicalExisting) {
      return {
        memory_id: canonicalExisting.id,
        version: Number(canonicalExisting.current_version ?? 1),
        operation: "capture",
        created: false,
        deduplicated: true
      };
    }
  }
  writeRecord(db, record, Boolean(existing), updateFeatureStats, writeProjections);
  writeVersion(db, record, "capture");
  return {
    memory_id: record.id,
    version: record.current_version,
    operation: "capture",
    created: !existing
  };
}

export function writeRecord(db, record, exists, updateFeatureStats = true, writeProjections = true) {
  const columns = [
    "id", "tenant_id", "project_id", "business_category_id", "work_type", "kind", "lifecycle_state", "scope_type", "scope_key", "content",
    "summary", "tags_json", "entities_json", "source", "source_refs_json", "external_key", "actor_type",
    "actor_id", "created_at", "updated_at", "valid_from", "valid_until", "confidence_score", "utility_score",
    "content_hash", "current_version", "rationale", "evidence_json", "conflicts_json", "permissions_json",
    "canonical_key", "root_memory_id", "last_accessed_at", "suppressed_at", "consolidated_at", "promoted_at",
    "expires_at", "revised_at", "reuse_rule", "capture_origin", "verification_state", "verified_at",
    "capture_route", "capture_batch_id", "learning_json", "quality_dimensions_json"
  ];
  const values = {
    ...record,
    tags_json: json(record.tags),
    entities_json: json(record.entities),
    source_refs_json: json(record.source_references),
    evidence_json: json(record.evidence),
    conflicts_json: json(record.conflicts),
    permissions_json: json(record.permissions)
    , learning_json: record.learning ? json(record.learning) : null
    , quality_dimensions_json: record.quality_dimensions ? json(record.quality_dimensions) : null
  };
  if (exists) {
    const mutable = columns.filter((column) => column !== "id" && column !== "tenant_id");
    db.prepare(
      `UPDATE memories SET ${mutable.map((column) => `"${column}" = ?`).join(", ")}
       WHERE tenant_id = ? AND id = ?`
    ).run(...mutable.map((column) => values[column]), record.tenant_id, record.id);
  } else {
    db.prepare(
      `INSERT INTO memories(${columns.map((column) => `"${column}"`).join(",")})
       VALUES(${columns.map(() => "?").join(",")})`
    ).run(...columns.map((column) => values[column]));
  }
  if (writeProjections) {
    db.prepare("DELETE FROM memories_fts WHERE tenant_id = ? AND memory_id = ?").run(record.tenant_id, record.id);
    if (record.lifecycle_state !== "suppressed") {
      db.prepare(
        "INSERT INTO memories_fts(memory_id, tenant_id, content, summary, tags, entities) VALUES(?,?,?,?,?,?)"
      ).run(record.id, record.tenant_id, record.content, record.summary || "", json(record.tags), json(record.entities));
    }
    writeLocalEmbedding(db, record, updateFeatureStats);
    writeRetrievalUnits(db, record, updateFeatureStats);
    writeRetrievalUnitsV4(db, record);
    writeStableRetrievalUnits(db, record, true, true, updateFeatureStats);
  }
}

export function writeVersion(db, record, operation) {
  db.prepare(
    `INSERT INTO memory_versions(
      id, memory_id, tenant_id, version, operation, content, summary, tags_json,
      kind, lifecycle_state, scope_type, scope_key, actor_type, actor_id,
      confidence_score, utility_score, canonical_key, snapshot_json, content_hash, created_at
      , business_category_id, work_type, reuse_rule
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    randomUUID(),
    record.id,
    record.tenant_id,
    record.current_version,
    operation,
    record.content,
    record.summary,
    json(record.tags),
    record.kind,
    record.lifecycle_state,
    record.scope_type,
    record.scope_key,
    record.actor_type,
    record.actor_id,
    record.confidence_score,
    record.utility_score,
    record.canonical_key,
    JSON.stringify(memoryFromRow({
      ...record,
      tags_json: json(record.tags),
      entities_json: json(record.entities),
      source_refs_json: json(record.source_references),
      evidence_json: json(record.evidence),
      conflicts_json: json(record.conflicts),
      permissions_json: json(record.permissions)
    })),
    record.content_hash,
    record.updated_at,
    record.business_category_id,
    record.work_type,
    record.reuse_rule
  );
}

