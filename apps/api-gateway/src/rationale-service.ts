import {
  CONFIRMATION_STATES,
  DECISION_TYPES,
  ENTITY_ROLES,
  ENTITY_TYPES,
  EVIDENCE_RELATIONS,
  EVIDENCE_TYPES,
  HttpError,
  RATIONALE_STATUSES,
  extractRationaleProposal,
  ulid,
  type ConfirmationState,
  type DecisionType,
  type EntityRole,
  type EntityType,
  type EvidenceRelation,
  type EvidenceType,
  type ProposedEntity,
  type ProposedEvidence
} from "@org-brain/shared";
import { captureMemoryItems, runBatchChunks } from "./memory-lifecycle-service";
import type { Env } from "./types";

const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

type ProposedMemoryInput = {
  external_key?: string;
  content: string;
  summary?: string;
  tags?: string[];
  created_at?: number;
  project_id?: string | null;
};

type ProposeMemoryRequest = {
  tenant_id?: string;
  source?: string;
  actor_type?: string | null;
  actor_id?: string | null;
  item?: ProposedMemoryInput;
  entities?: ProposedEntity[];
  evidence?: ProposedEvidence[];
};

type ConfirmMemoryRequest = {
  tenant_id?: string;
  confirmation_token?: string;
  approved?: boolean;
  conclusion?: string;
  reason_summary?: string;
  decision_type?: DecisionType;
  status?: string;
  entities?: ProposedEntity[];
  evidence?: ProposedEvidence[];
};

type CaptureMemoryWithRationaleRequest = ProposeMemoryRequest;

type StoredConfirmation = {
  id: string;
  tenant_id: string;
  source: string;
  payload_json: string;
  expires_at: number;
  consumed_at: number | null;
};

type ConfirmationPayload = {
  tenant_id: string;
  source: string;
  actor_type: string | null;
  actor_id: string | null;
  proposed_memory: {
    external_key: string | null;
    content: string;
    summary: string | null;
    tags: string[];
    created_at: number;
    project_id: string | null;
  };
  proposed_rationale: {
    decision_type: DecisionType;
    conclusion: string;
    reason_summary: string;
    status: string;
    confidence_score: number | null;
  };
  proposed_entities: ProposedEntity[];
  proposed_evidence: ProposedEvidence[];
};

type SearchFilters = {
  entityId: string | null;
  entityRole: string | null;
  decisionType: string | null;
  decisionStatus: string | null;
  confirmationState: string | null;
  reasonText: string | null;
};

function parseString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  }
  return trimmed.slice(0, maxLength);
}

function parseOptionalString(value: unknown, field: string, maxLength = 256): string | null {
  if (value === undefined || value === null) return null;
  return parseString(value, field, maxLength);
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_payload", `${field} must be a boolean`);
  }
  return value;
}

function parseOptionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be a finite number`);
  }
  return value;
}

function parseTags(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be an array`);
  }
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 16);
}

function parseEnum<T extends readonly string[]>(value: unknown, field: string, allowed: T, fallback?: T[number]): T[number] {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, "invalid_payload", `${field} is required`);
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function parseEntities(raw: unknown, field: string): ProposedEntity[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "invalid_payload", `${field} must be an array`);
  return raw.slice(0, 8).map((item, index) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "invalid_payload", `${field}[${index}] must be an object`);
    const row = item as Record<string, unknown>;
    return {
      name: parseString(row.name, `${field}[${index}].name`, 128),
      entity_type: parseEnum(row.entity_type, `${field}[${index}].entity_type`, ENTITY_TYPES, "unknown"),
      role: parseEnum(row.role, `${field}[${index}].role`, ENTITY_ROLES, "subject"),
      confidence_score: parseOptionalNumber(row.confidence_score, `${field}[${index}].confidence_score`),
      external_ref: parseOptionalString(row.external_ref, `${field}[${index}].external_ref`, 256)
    };
  });
}

function parseEvidence(raw: unknown, field: string): ProposedEvidence[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "invalid_payload", `${field} must be an array`);
  return raw.slice(0, 8).map((item, index) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "invalid_payload", `${field}[${index}] must be an object`);
    const row = item as Record<string, unknown>;
    return {
      evidence_type: parseEnum(row.evidence_type, `${field}[${index}].evidence_type`, EVIDENCE_TYPES, "external"),
      evidence_ref: parseString(row.evidence_ref, `${field}[${index}].evidence_ref`, 512),
      relation: parseEnum(row.relation, `${field}[${index}].relation`, EVIDENCE_RELATIONS, "supports"),
      note: parseOptionalString(row.note, `${field}[${index}].note`, 500),
      weight_score: parseOptionalNumber(row.weight_score, `${field}[${index}].weight_score`)
    };
  });
}

function parseProposeRequest(rawBody: unknown): {
  tenantId: string;
  source: string;
  actorType: string | null;
  actorId: string | null;
  item: ConfirmationPayload["proposed_memory"];
  entities: ProposedEntity[];
  evidence: ProposedEvidence[];
} {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as ProposeMemoryRequest;
  const item = body.item;
  if (!item || typeof item !== "object") throw new HttpError(400, "invalid_payload", "item is required");
  return {
    tenantId: parseOptionalString(body.tenant_id, "tenant_id", 128) ?? "default",
    source: parseOptionalString(body.source, "source", 64) ?? "openclaw",
    actorType: parseOptionalString(body.actor_type, "actor_type", 64),
    actorId: parseOptionalString(body.actor_id, "actor_id", 128),
    item: {
      external_key: parseOptionalString(item.external_key, "item.external_key", 256),
      content: parseString(item.content, "item.content", 20_000),
      summary: parseOptionalString(item.summary, "item.summary", 1_000),
      tags: parseTags(item.tags, "item.tags"),
      created_at: parseOptionalNumber(item.created_at, "item.created_at") ?? Date.now(),
      project_id: parseOptionalString(item.project_id, "item.project_id", 128)
    },
    entities: parseEntities(body.entities, "entities"),
    evidence: parseEvidence(body.evidence, "evidence")
  };
}

function parseCaptureWithRationaleRequest(rawBody: unknown): ReturnType<typeof parseProposeRequest> {
  return parseProposeRequest(rawBody as CaptureMemoryWithRationaleRequest);
}

function parseConfirmRequest(rawBody: unknown): {
  tenantId: string;
  confirmationToken: string;
  approved: boolean;
  conclusion: string | null;
  reasonSummary: string | null;
  decisionType: DecisionType | null;
  status: string | null;
  entities: ProposedEntity[];
  evidence: ProposedEvidence[];
} {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as ConfirmMemoryRequest;
  return {
    tenantId: parseOptionalString(body.tenant_id, "tenant_id", 128) ?? "default",
    confirmationToken: parseString(body.confirmation_token, "confirmation_token", 64),
    approved: parseOptionalBoolean(body.approved, "approved") ?? false,
    conclusion: parseOptionalString(body.conclusion, "conclusion", 240),
    reasonSummary: parseOptionalString(body.reason_summary, "reason_summary", 500),
    decisionType: body.decision_type ? parseEnum(body.decision_type, "decision_type", DECISION_TYPES) : null,
    status: parseOptionalString(body.status, "status", 64),
    entities: parseEntities(body.entities, "entities"),
    evidence: parseEvidence(body.evidence, "evidence")
  };
}

async function storeConfirmation(env: Env, payload: ConfirmationPayload): Promise<string> {
  const token = ulid();
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO memory_confirmations(id, tenant_id, source, payload_json, created_at, expires_at, consumed_at) VALUES(?,?,?,?,?,?,NULL)"
  )
    .bind(token, payload.tenant_id, payload.source, JSON.stringify(payload), now, now + CONFIRMATION_TTL_MS)
    .run();
  return token;
}

async function loadConfirmation(env: Env, tenantId: string, token: string): Promise<{ row: StoredConfirmation; payload: ConfirmationPayload }> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, tenant_id, source, payload_json, expires_at, consumed_at FROM memory_confirmations WHERE tenant_id = ? AND id = ?"
  )
    .bind(tenantId, token)
    .first<StoredConfirmation>();
  if (!row) throw new HttpError(404, "confirmation_not_found", "Confirmation token not found");
  if (row.consumed_at) throw new HttpError(409, "confirmation_consumed", "Confirmation token already used");
  if (row.expires_at <= Date.now()) throw new HttpError(410, "confirmation_expired", "Confirmation token expired");
  const payload = JSON.parse(row.payload_json) as ConfirmationPayload;
  return { row, payload };
}

async function consumeConfirmation(env: Env, tenantId: string, token: string): Promise<void> {
  await env.OPEN_BRAIN_DB.prepare("UPDATE memory_confirmations SET consumed_at = ? WHERE tenant_id = ? AND id = ?")
    .bind(Date.now(), tenantId, token)
    .run();
}

async function upsertEntity(env: Env, tenantId: string, entity: ProposedEntity): Promise<string> {
  const existing = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM entities WHERE tenant_id = ? AND entity_type = ? AND canonical_name = ?"
  )
    .bind(tenantId, entity.entity_type, entity.name)
    .first<{ id: string }>();
  if (existing?.id) return existing.id;
  const entityId = ulid();
  await env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO entities(id, tenant_id, entity_type, canonical_name, aliases_json, external_ref, created_at) VALUES(?,?,?,?,?,?,?)"
  )
    .bind(entityId, tenantId, entity.entity_type, entity.name, JSON.stringify([]), entity.external_ref ?? null, Date.now())
    .run();
  return entityId;
}

async function attachEntitiesAndEvidence(
  env: Env,
  args: {
    tenantId: string;
    memoryId: string;
    rationaleId: string;
    entities: ProposedEntity[];
    evidence: ProposedEvidence[];
    deciderEntityId: string | null;
  }
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    env.OPEN_BRAIN_DB.prepare("DELETE FROM memory_entities WHERE tenant_id = ? AND memory_id = ?").bind(args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare("DELETE FROM decision_evidence WHERE tenant_id = ? AND rationale_id = ?").bind(args.tenantId, args.rationaleId)
  ];

  for (const entity of args.entities) {
    const entityId = await upsertEntity(env, args.tenantId, entity);
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO memory_entities(id, tenant_id, memory_id, entity_id, role, confidence_score, created_at) VALUES(?,?,?,?,?,?,?)"
      ).bind(ulid(), args.tenantId, args.memoryId, entityId, entity.role, entity.confidence_score ?? null, Date.now())
    );
  }

  for (const evidence of args.evidence) {
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO decision_evidence(id, tenant_id, rationale_id, evidence_type, evidence_ref, relation, note, weight_score, created_at) VALUES(?,?,?,?,?,?,?,?,?)"
      ).bind(
        ulid(),
        args.tenantId,
        args.rationaleId,
        evidence.evidence_type,
        evidence.evidence_ref,
        evidence.relation,
        evidence.note ?? null,
        evidence.weight_score ?? null,
        Date.now()
      )
    );
  }

  if (args.deciderEntityId) {
    statements.push(
      env.OPEN_BRAIN_DB.prepare("UPDATE decision_rationales SET decider_entity_id = ? WHERE tenant_id = ? AND id = ?").bind(
        args.deciderEntityId,
        args.tenantId,
        args.rationaleId
      )
    );
  }

  await runBatchChunks(env.OPEN_BRAIN_DB, statements);
}

async function hasRationaleForMemory(env: Env, tenantId: string, memoryId: string): Promise<boolean> {
  const row = await env.OPEN_BRAIN_DB.prepare("SELECT id FROM decision_rationales WHERE tenant_id = ? AND memory_id = ? LIMIT 1")
    .bind(tenantId, memoryId)
    .first<{ id: string }>();
  return Boolean(row?.id);
}

async function persistInferredRationale(
  env: Env,
  args: {
    tenantId: string;
    memoryId: string;
    projectId: string | null;
    rationale: ConfirmationPayload["proposed_rationale"];
    entities: ProposedEntity[];
    evidence: ProposedEvidence[];
  }
): Promise<{ rationale_id: string | null; skipped: boolean; reason?: string }> {
  if (await hasRationaleForMemory(env, args.tenantId, args.memoryId)) {
    return { rationale_id: null, skipped: true, reason: "existing_rationale" };
  }

  const rationaleId = ulid();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO decision_rationales(
      id, tenant_id, memory_id, project_id, decision_type, conclusion, reason_summary, status,
      confirmation_state, decider_entity_id, confidence_score, created_at, confirmed_at, superseded_by
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      rationaleId,
      args.tenantId,
      args.memoryId,
      args.projectId,
      args.rationale.decision_type,
      args.rationale.conclusion,
      args.rationale.reason_summary,
      "accepted",
      "inferred_unconfirmed",
      null,
      args.rationale.confidence_score ?? null,
      Date.now(),
      null,
      null
    )
    .run();

  let deciderEntityId: string | null = null;
  const decider = args.entities.find((entity) => entity.role === "decision_maker");
  if (decider) {
    deciderEntityId = await upsertEntity(env, args.tenantId, decider);
  }
  await attachEntitiesAndEvidence(env, {
    tenantId: args.tenantId,
    memoryId: args.memoryId,
    rationaleId,
    entities: args.entities,
    evidence: args.evidence,
    deciderEntityId
  });

  return { rationale_id: rationaleId, skipped: false };
}

export async function proposeMemoryWithRationale(env: Env, rawBody: unknown) {
  const { tenantId, source, actorType, actorId, item, entities, evidence } = parseProposeRequest(rawBody);
  const extracted = extractRationaleProposal({
    content: item.content,
    summary: item.summary,
    projectId: item.project_id,
    entities,
    evidence
  });
  const payload: ConfirmationPayload = {
    tenant_id: tenantId,
    source,
    actor_type: actorType,
    actor_id: actorId,
    proposed_memory: item,
    proposed_rationale: extracted.rationale,
    proposed_entities: extracted.entities,
    proposed_evidence: extracted.evidence
  };
  const confirmationToken = await storeConfirmation(env, payload);
  return {
    tenant_id: tenantId,
    source,
    confirmation_token: confirmationToken,
    proposed_memory: item,
    proposed_rationale: {
      ...extracted.rationale,
      confirmation_state: "inferred_unconfirmed" as const
    },
    proposed_entities: extracted.entities,
    proposed_evidence: extracted.evidence
  };
}

export async function captureMemoryWithInferredRationale(env: Env, rawBody: unknown) {
  const { tenantId, source, actorType, actorId, item, entities, evidence } = parseCaptureWithRationaleRequest(rawBody);
  const extracted = extractRationaleProposal({
    content: item.content,
    summary: item.summary,
    projectId: item.project_id,
    entities,
    evidence
  });

  const capture = await captureMemoryItems(env, {
    tenantId,
    source,
    items: [
      {
        external_key: item.external_key,
        content: item.content,
        summary: item.summary,
        tags: item.tags,
        created_at: item.created_at,
        project_id: item.project_id,
        actor_type: actorType,
        actor_id: actorId,
        kind: "semantic",
        lifecycle_state: "active"
      }
    ],
    operation: "capture"
  });
  const memoryId = capture.items[0]?.memory_id;
  if (!memoryId) throw new HttpError(500, "memory_capture_failed", "Failed to persist memory");

  const rationale = await persistInferredRationale(env, {
    tenantId,
    memoryId,
    projectId: item.project_id,
    rationale: extracted.rationale,
    entities: entities.length > 0 ? entities : extracted.entities,
    evidence: evidence.length > 0 ? evidence : extracted.evidence
  });

  return {
    tenant_id: tenantId,
    source,
    memory_id: memoryId,
    capture,
    rationale_id: rationale.rationale_id,
    rationale_skipped: rationale.skipped,
    rationale_skip_reason: rationale.reason ?? null,
    confirmation_state: rationale.skipped ? null : "inferred_unconfirmed"
  };
}

export async function confirmProposedMemory(env: Env, rawBody: unknown) {
  const request = parseConfirmRequest(rawBody);
  const { payload } = await loadConfirmation(env, request.tenantId, request.confirmationToken);
  if (!request.approved) {
    await consumeConfirmation(env, request.tenantId, request.confirmationToken);
    return {
      tenant_id: request.tenantId,
      approved: false,
      saved: false
    };
  }

  const memoryWrite = {
    external_key: payload.proposed_memory.external_key,
    content: payload.proposed_memory.content,
    summary: payload.proposed_memory.summary,
    tags: payload.proposed_memory.tags,
    created_at: payload.proposed_memory.created_at,
    project_id: payload.proposed_memory.project_id,
    actor_type: payload.actor_type,
    actor_id: payload.actor_id,
    kind: "semantic" as const,
    lifecycle_state: "active" as const
  };
  const capture = await captureMemoryItems(env, {
    tenantId: request.tenantId,
    source: payload.source,
    items: [memoryWrite],
    operation: "capture"
  });
  const memoryId = capture.items[0]?.memory_id;
  if (!memoryId) throw new HttpError(500, "memory_capture_failed", "Failed to persist memory");

  const corrected = Boolean(
    (request.conclusion && request.conclusion !== payload.proposed_rationale.conclusion) ||
    (request.reasonSummary && request.reasonSummary !== payload.proposed_rationale.reason_summary) ||
    (request.decisionType && request.decisionType !== payload.proposed_rationale.decision_type) ||
    request.entities.length > 0 ||
    request.evidence.length > 0
  );
  const confirmationState: ConfirmationState = corrected ? "user_corrected" : "user_confirmed";
  const rationaleId = ulid();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO decision_rationales(
      id, tenant_id, memory_id, project_id, decision_type, conclusion, reason_summary, status,
      confirmation_state, decider_entity_id, confidence_score, created_at, confirmed_at, superseded_by
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      rationaleId,
      request.tenantId,
      memoryId,
      payload.proposed_memory.project_id,
      request.decisionType ?? payload.proposed_rationale.decision_type,
      request.conclusion ?? payload.proposed_rationale.conclusion,
      request.reasonSummary ?? payload.proposed_rationale.reason_summary,
      request.status ?? payload.proposed_rationale.status,
      confirmationState,
      null,
      payload.proposed_rationale.confidence_score ?? null,
      Date.now(),
      Date.now(),
      null
    )
    .run();

  const finalEntities = request.entities.length > 0 ? request.entities : payload.proposed_entities;
  const finalEvidence = request.evidence.length > 0 ? request.evidence : payload.proposed_evidence;
  let deciderEntityId: string | null = null;
  const decider = finalEntities.find((entity) => entity.role === "decision_maker");
  if (decider) {
    deciderEntityId = await upsertEntity(env, request.tenantId, decider);
  }
  await attachEntitiesAndEvidence(env, {
    tenantId: request.tenantId,
    memoryId,
    rationaleId,
    entities: finalEntities,
    evidence: finalEvidence,
    deciderEntityId
  });
  await consumeConfirmation(env, request.tenantId, request.confirmationToken);

  return {
    tenant_id: request.tenantId,
    approved: true,
    saved: true,
    memory_id: memoryId,
    rationale_id: rationaleId,
    confirmation_state: confirmationState
  };
}

export function parseSearchFilters(rawBody: unknown): SearchFilters {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  return {
    entityId: parseOptionalString(body.entity_id, "entity_id", 64),
    entityRole: parseOptionalString(body.entity_role, "entity_role", 64),
    decisionType: parseOptionalString(body.decision_type, "decision_type", 64),
    decisionStatus: parseOptionalString(body.decision_status, "decision_status", 64),
    confirmationState: parseOptionalString(body.confirmation_state, "confirmation_state", 64),
    reasonText: parseOptionalString(body.reason_text, "reason_text", 240)
  };
}

export async function filterMemorySearchResults(
  env: Env,
  tenantId: string,
  resultIds: string[],
  filters: SearchFilters
): Promise<Set<string>> {
  const hasFilters = Object.values(filters).some(Boolean);
  if (!hasFilters || resultIds.length === 0) return new Set(resultIds);
  const placeholders = resultIds.map(() => "?").join(", ");
  const clauses = ["r.tenant_id = ?", `r.memory_id IN (${placeholders})`];
  const bindings: unknown[] = [tenantId, ...resultIds];
  if (filters.entityId) {
    clauses.push(
      `EXISTS(SELECT 1 FROM memory_entities me WHERE me.tenant_id = r.tenant_id AND me.memory_id = r.memory_id AND me.entity_id = ?${filters.entityRole ? " AND me.role = ?" : ""})`
    );
    bindings.push(filters.entityId);
    if (filters.entityRole) bindings.push(filters.entityRole);
  }
  if (filters.decisionType) {
    clauses.push("r.decision_type = ?");
    bindings.push(filters.decisionType);
  }
  if (filters.decisionStatus) {
    clauses.push("r.status = ?");
    bindings.push(filters.decisionStatus);
  }
  if (filters.confirmationState) {
    clauses.push("r.confirmation_state = ?");
    bindings.push(filters.confirmationState);
  }
  if (filters.reasonText) {
    clauses.push("(LOWER(r.reason_summary) LIKE ? OR LOWER(r.conclusion) LIKE ?)");
    const like = `%${filters.reasonText.toLowerCase()}%`;
    bindings.push(like, like);
  }
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT DISTINCT r.memory_id
     FROM decision_rationales r
     WHERE ${clauses.join(" AND ")}`
  )
    .bind(...bindings)
    .all<{ memory_id: string }>();
  return new Set(rows.results.map((row) => row.memory_id));
}
