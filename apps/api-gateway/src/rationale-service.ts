import {
  CONFIRMATION_STATES,
  DECISION_TYPES,
  ENTITY_ROLES,
  ENTITY_TYPES,
  EVIDENCE_RELATIONS,
  EVIDENCE_TYPES,
  HttpError,
  assessMemoryUsefulnessV1,
  MEMORY_KINDS,
  RATIONALE_STATUSES,
  extractRationaleProposal,
  ulid,
  type ConfirmationState,
  type DecisionType,
  type EntityRole,
  type EntityType,
  type EvidenceRelation,
  type EvidenceType,
  type MemoryKind,
  type ProposedEntity,
  type ProposedEvidence,
  type MemoryWorkType
} from "@org-brain/shared";
import { captureMemoryItems, runBatchChunks } from "./memory-lifecycle-service";
import type { Env } from "./types";
import {
  screenMemoryCaptureText,
  screenMemoryWriteText,
  screenOptionalMemoryWriteText
} from "./memory-screening-service";
import { ensureProjectBusinessCategory, validateBusinessClassification } from "./business-category-service";
import { upsertAutoDecisionMemory } from "./context-engine-service";

const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const CAPTURE_V2_KINDS = ["decision", "constraint", "pitfall", "preference", "fact"] as const;
const CAPTURE_V2_UNRESOLVED_RATIONALE = "Rationale was not extracted; review required.";
const DAY_MS = 24 * 60 * 60 * 1000;
const CAPTURE_V2_TTL_MS: Record<(typeof CAPTURE_V2_KINDS)[number], number> = {
  fact: 90 * DAY_MS,
  decision: 180 * DAY_MS,
  constraint: 180 * DAY_MS,
  pitfall: 180 * DAY_MS,
  preference: 180 * DAY_MS
};

function captureV2DecisionType(kind: MemoryKind, extracted: DecisionType): DecisionType {
  if (kind === "constraint") return "policy";
  if (kind === "decision") return extracted === "workaround" ? "adopt" : extracted;
  if (kind === "pitfall" || kind === "fact") return "diagnose";
  if (kind === "preference") return "prioritize";
  return extracted;
}

type ProposedMemoryInput = {
  external_key?: string;
  content: string;
  summary?: string;
  tags?: string[];
  created_at?: number;
  project_id?: string | null;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
  canonical_key?: string | null;
  kind?: MemoryKind;
  rationale?: string | null;
  reuse_rule?: string | null;
  evidence?: ProposedEvidence[];
  source_references?: Array<Record<string, unknown>>;
  source_refs?: Array<Record<string, unknown>>;
  valid_until?: number | null;
  confidence_score?: number | null;
  utility_score?: number | null;
  visibility?: "tenant" | "project" | "restricted";
  allowed_principals?: string[];
  capture_origin?: "observed" | "synthetic" | "repair" | "legacy";
  capture_route?: "realtime_hook" | "initial_import" | "manual" | "repair" | "legacy";
  capture_batch_id?: string | null;
  verification?: {
    state?: "verified" | "partial" | "unverified" | "rejected";
    verified_at?: number | null;
    attestation_ref?: string | null;
  };
  learning?: Record<string, unknown> | null;
  quality_dimensions?: Record<string, number> | null;
  reason_codes?: string[];
  ai_certification?: string | null;
  judge_consensus?: Record<string, unknown> | null;
};

type ProposeMemoryRequest = {
  tenant_id?: string;
  source?: string;
  actor_type?: string | null;
  actor_id?: string | null;
  item?: ProposedMemoryInput;
  items?: ProposedMemoryInput[];
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

type CaptureCandidateResult = {
  external_key: string | null;
  status: "created" | "updated" | "skipped";
  reason_code?: string;
  memory_id?: string;
  rationale_id?: string | null;
  rationale_skipped?: boolean;
  decision_memory_id?: string | null;
  classification_warning?: string[];
};

type CaptureMemoryWithRationaleResult = {
  tenant_id: string;
  source: string;
  inserted: number;
  updated: number;
  capture: Awaited<ReturnType<typeof captureMemoryItems>>;
  results: CaptureCandidateResult[];
  summary: {
    accepted: number;
    skipped: number;
    created: number;
    updated: number;
  };
  memory_id?: string | null;
  rationale_id?: string | null;
  rationale_skipped?: boolean;
  rationale_skip_reason?: string | null;
  confirmation_state?: "inferred_unconfirmed" | null;
  classification_warning?: string[];
};

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
    business_category_id: string | null;
    work_type: MemoryWorkType | null;
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
      weight_score: parseOptionalNumber(row.weight_score, `${field}[${index}].weight_score`),
      content_hash: parseOptionalString(row.content_hash, `${field}[${index}].content_hash`, 128),
      observed_at: parseOptionalNumber(row.observed_at, `${field}[${index}].observed_at`),
      attestation_ref: parseOptionalString(row.attestation_ref, `${field}[${index}].attestation_ref`, 512)
    };
  });
}

function parseStringList(raw: unknown, field: string, maxItems = 64, maxLength = 128): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "invalid_payload", `${field} must be an array`);
  return [...new Set(raw.map((item, index) => parseString(item, `${field}[${index}]`, maxLength)))].slice(0, maxItems);
}

function parseSourceReferences(raw: unknown, field: string): Array<Record<string, unknown>> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "invalid_payload", `${field} must be an array`);
  return raw.slice(0, 32).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, "invalid_payload", `${field}[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    return {
      type: parseString(row.type, `${field}[${index}].type`, 80),
      ref: parseString(row.ref, `${field}[${index}].ref`, 512),
      ...(row.title === undefined ? {} : { title: parseOptionalString(row.title, `${field}[${index}].title`, 240) }),
      ...(row.summary === undefined ? {} : { summary: parseOptionalString(row.summary, `${field}[${index}].summary`, 240) }),
      ...(row.content_hash === undefined ? {} : { content_hash: parseOptionalString(row.content_hash, `${field}[${index}].content_hash`, 80) }),
      ...(row.digest === undefined ? {} : { digest: parseOptionalString(row.digest, `${field}[${index}].digest`, 80) }),
      ...(row.captured_at === undefined ? {} : { captured_at: parseOptionalNumber(row.captured_at, `${field}[${index}].captured_at`) })
    };
  });
}

type ParsedCaptureItem = ConfirmationPayload["proposed_memory"] & {
  canonical_key: string | null;
  kind: MemoryKind;
  rationale: string | null;
  reuse_rule: string | null;
  evidence: ProposedEvidence[];
  source_references: Array<Record<string, unknown>>;
  valid_until: number | null;
  confidence_score: number | null;
  utility_score: number | null;
  visibility: "tenant" | "project" | "restricted";
  allowed_principals: string[];
  capture_origin: "observed" | "synthetic" | "repair" | "legacy";
  capture_route: "realtime_hook" | "initial_import" | "manual" | "repair" | "legacy";
  capture_batch_id: string | null;
  verification: {
    state: "verified" | "partial" | "unverified" | "rejected";
    verified_at: number | null;
    attestation_ref: string | null;
  };
  learning: Record<string, unknown> | null;
  quality_dimensions: Record<string, number> | null;
  reason_codes: string[];
  ai_certification: string | null;
  judge_consensus: Record<string, unknown> | null;
};

function parseRecordObject(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_payload", `${field} must be an object`);
  return value as Record<string, unknown>;
}

function parseQualityDimensions(value: unknown, field: string): Record<string, number> | null {
  const record = parseRecordObject(value, field);
  if (!record) return null;
  return Object.fromEntries(Object.entries(record).map(([key, raw]) => {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 100) {
      throw new HttpError(400, "invalid_payload", `${field}.${key} must be between 0 and 100`);
    }
    return [key.slice(0, 80), raw];
  }));
}

export function captureRequestClaimsVerified(rawBody: unknown): boolean {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return false;
  const body = rawBody as Record<string, unknown>;
  const rows = Array.isArray(body.items) ? body.items : body.item ? [body.item] : [];
  return rows.some((item) => item && typeof item === "object" && !Array.isArray(item) &&
    (item as Record<string, unknown>).verification &&
    typeof (item as Record<string, unknown>).verification === "object" &&
    ((item as Record<string, unknown>).verification as Record<string, unknown>).state === "verified");
}

function parseCaptureItem(item: ProposedMemoryInput, field: string, options: { requireExternalKey: boolean }): ParsedCaptureItem {
  if (!item || typeof item !== "object") throw new HttpError(400, "invalid_payload", `${field} must be an object`);
  const projectId = parseOptionalString(item.project_id, `${field}.project_id`, 128);
  const visibility = item.visibility === "restricted" || item.visibility === "project" || item.visibility === "tenant"
    ? item.visibility
    : projectId ? "project" : "tenant";
  const allowedPrincipals = parseStringList(item.allowed_principals, `${field}.allowed_principals`);
  if (visibility === "restricted" && allowedPrincipals.length === 0) {
    throw new HttpError(400, "restricted_principals_required", `${field}.allowed_principals is required for restricted visibility`);
  }
  const confidence = parseOptionalNumber(item.confidence_score, `${field}.confidence_score`);
  const utility = parseOptionalNumber(item.utility_score, `${field}.utility_score`);
  if (confidence !== null && (confidence < 0 || confidence > 1)) {
    throw new HttpError(400, "invalid_payload", `${field}.confidence_score must be between 0 and 1`);
  }
  if (utility !== null && (utility < 0 || utility > 1)) {
    throw new HttpError(400, "invalid_payload", `${field}.utility_score must be between 0 and 1`);
  }
  const kind = item.kind === undefined
    ? "semantic"
    : options.requireExternalKey
      ? parseEnum(item.kind, `${field}.kind`, CAPTURE_V2_KINDS, "fact")
      : parseEnum(item.kind, `${field}.kind`, MEMORY_KINDS, "semantic");
  const externalKey = parseOptionalString(item.external_key, `${field}.external_key`, 256);
  if (options.requireExternalKey && !externalKey) {
    throw new HttpError(400, "external_key_required", `${field}.external_key is required for batch capture`);
  }
  const verificationRaw = parseRecordObject(item.verification, `${field}.verification`);
  const verificationState = parseEnum(
    verificationRaw?.state,
    `${field}.verification.state`,
    ["verified", "partial", "unverified", "rejected"] as const,
    "unverified"
  );
  const captureOrigin = parseEnum(
    item.capture_origin,
    `${field}.capture_origin`,
    ["observed", "synthetic", "repair", "legacy"] as const,
    "legacy"
  );
  const captureRoute = parseEnum(
    item.capture_route,
    `${field}.capture_route`,
    ["realtime_hook", "initial_import", "manual", "repair", "legacy"] as const,
    "legacy"
  );
  const learning = parseRecordObject(item.learning, `${field}.learning`);
  const verifiedAt = parseOptionalNumber(verificationRaw?.verified_at, `${field}.verification.verified_at`);
  const attestationRef = parseOptionalString(verificationRaw?.attestation_ref, `${field}.verification.attestation_ref`, 512);
  if (verificationState === "verified" && (captureOrigin !== "observed" || !learning || !verifiedAt || !attestationRef)) {
    throw new HttpError(400, "invalid_verified_learning", `${field} verified learning requires observed origin, learning, verified_at, and attestation_ref`);
  }
  return {
    external_key: externalKey,
    content: parseString(item.content, `${field}.content`, 20_000),
    summary: parseOptionalString(item.summary, `${field}.summary`, 1_000),
    tags: parseTags(item.tags, `${field}.tags`),
    created_at: parseOptionalNumber(item.created_at, `${field}.created_at`) ?? Date.now(),
    project_id: projectId,
    business_category_id: parseOptionalString(item.business_category_id, `${field}.business_category_id`, 128),
    work_type: item.work_type ?? null,
    canonical_key: parseOptionalString(item.canonical_key, `${field}.canonical_key`, 256),
    kind,
    rationale: parseOptionalString(item.rationale, `${field}.rationale`, 4_000),
    reuse_rule: parseOptionalString(item.reuse_rule, `${field}.reuse_rule`, 1_000),
    evidence: parseEvidence(item.evidence, `${field}.evidence`),
    source_references: parseSourceReferences(
      item.source_refs ?? item.source_references,
      item.source_refs === undefined ? `${field}.source_references` : `${field}.source_refs`
    ),
    valid_until: parseOptionalNumber(item.valid_until, `${field}.valid_until`),
    confidence_score: confidence,
    utility_score: utility,
    visibility,
    allowed_principals: allowedPrincipals
    , capture_origin: captureOrigin
    , capture_route: captureRoute
    , capture_batch_id: parseOptionalString(item.capture_batch_id, `${field}.capture_batch_id`, 128)
    , verification: { state: verificationState, verified_at: verifiedAt, attestation_ref: attestationRef }
    , learning
    , quality_dimensions: parseQualityDimensions(item.quality_dimensions, `${field}.quality_dimensions`)
    , reason_codes: parseStringList(item.reason_codes, `${field}.reason_codes`, 32, 128)
    , ai_certification: parseOptionalString(item.ai_certification, `${field}.ai_certification`, 128)
    , judge_consensus: parseRecordObject(item.judge_consensus, `${field}.judge_consensus`)
  };
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
      project_id: parseOptionalString(item.project_id, "item.project_id", 128),
      business_category_id: parseOptionalString(item.business_category_id, "item.business_category_id", 128),
      work_type: item.work_type ?? null
    },
    entities: parseEntities(body.entities, "entities"),
    evidence: parseEvidence(body.evidence, "evidence")
  };
}

function parseCaptureWithRationaleRequest(rawBody: unknown): {
  tenantId: string;
  source: string;
  actorType: string | null;
  actorId: string | null;
  items: ParsedCaptureItem[];
  entities: ProposedEntity[];
  evidence: ProposedEvidence[];
  legacySingle: boolean;
} {
  if (!rawBody || typeof rawBody !== "object") throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = rawBody as CaptureMemoryWithRationaleRequest;
  const hasItem = Boolean(body.item);
  const hasItems = body.items !== undefined;
  if (hasItem === hasItems) {
    throw new HttpError(400, "invalid_payload", "exactly one of item or items is required");
  }
  if (hasItems && (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 3)) {
    throw new HttpError(400, "invalid_payload", "items must contain between 1 and 3 entries");
  }
  const rawItems = hasItems ? body.items! : [body.item!];
  return {
    tenantId: parseOptionalString(body.tenant_id, "tenant_id", 128) ?? "default",
    source: parseOptionalString(body.source, "source", 64) ?? "openclaw",
    actorType: parseOptionalString(body.actor_type, "actor_type", 64),
    actorId: parseOptionalString(body.actor_id, "actor_id", 128),
    items: rawItems.map((item, index) => parseCaptureItem(
      item,
      hasItems ? `items[${index}]` : "item",
      { requireExternalKey: hasItems }
    )),
    entities: parseEntities(body.entities, "entities"),
    evidence: parseEvidence(body.evidence, "evidence"),
    legacySingle: hasItem
  };
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
        `INSERT INTO decision_evidence(
          id, tenant_id, rationale_id, evidence_type, evidence_ref, relation, note, weight_score, created_at,
          content_hash, observed_at, attestation_ref
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        ulid(),
        args.tenantId,
        args.rationaleId,
        evidence.evidence_type,
        evidence.evidence_ref,
        evidence.relation,
        evidence.note ?? null,
        evidence.weight_score ?? null,
        Date.now(),
        evidence.content_hash ?? null,
        evidence.observed_at ?? null,
        evidence.attestation_ref ?? null
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
  const { tenantId, source, actorType, actorId, item: parsedItem, entities, evidence } = parseProposeRequest(rawBody);
  const classification = await validateBusinessClassification(
    env,
    tenantId,
    parsedItem.business_category_id,
    parsedItem.work_type,
    { required: env.MEMORY_CLASSIFICATION_MODE === "require" }
  );
  const item = {
    ...parsedItem,
    business_category_id: classification.business_category_id,
    work_type: classification.work_type,
    content: screenMemoryWriteText(parsedItem.content, "item.content"),
    summary: screenOptionalMemoryWriteText(parsedItem.summary, "item.summary")
  };
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
    proposed_evidence: extracted.evidence,
    ...(classification.classification_warning
      ? { classification_warning: classification.classification_warning }
      : {})
  };
}

export async function captureMemoryWithInferredRationale(
  env: Env,
  rawBody: unknown,
  options: { canAttest?: boolean } = {}
): Promise<CaptureMemoryWithRationaleResult> {
  const request = parseCaptureWithRationaleRequest(rawBody);
  const prepared: Array<{
    input: ParsedCaptureItem;
    item: ParsedCaptureItem;
    extracted: ReturnType<typeof extractRationaleProposal>;
    entities: ProposedEntity[];
    evidence: ProposedEvidence[];
    warnings: string[];
    captureV2Enabled: boolean;
    qualityRoute: "active" | "quarantine";
  }> = [];
  const skipped: CaptureCandidateResult[] = [];

  for (const [index, parsedItem] of request.items.entries()) {
    const field = request.legacySingle ? "item" : `items[${index}]`;
    try {
      if (parsedItem.verification.state === "verified" && !options.canAttest) {
        throw new HttpError(403, "memory_attestation_required", "memory:attest permission is required for verified learning");
      }
      const captureV2Enabled = !request.legacySingle || env.ORGBRAIN_MEMORY_CAPTURE_V2_MODE === "on";
      // The hook sends the deterministic project-category ID so Local, Cloud,
      // and cap-runner candidate JSON stays identical. Ensure that category
      // before validating the supplied ID; an unrelated/invalid explicit ID
      // still fails validation instead of being silently replaced.
      const ensuredCategory = captureV2Enabled
        ? await ensureProjectBusinessCategory(env, request.tenantId, parsedItem.project_id)
        : null;
      const classification = await validateBusinessClassification(
        env,
        request.tenantId,
        parsedItem.business_category_id ?? ensuredCategory?.id,
        parsedItem.work_type ?? (captureV2Enabled ? "other" : null),
        { required: captureV2Enabled || env.MEMORY_CLASSIFICATION_MODE === "require" }
      );
      const content = screenMemoryCaptureText(parsedItem.content, `${field}.content`, {
        visibility: parsedItem.visibility,
        allowedPrincipals: parsedItem.allowed_principals
      });
      const screen = (value: string, nestedField: string) => screenMemoryCaptureText(value, nestedField, {
        visibility: parsedItem.visibility,
        allowedPrincipals: parsedItem.allowed_principals
      });
      const summary = parsedItem.summary == null
        ? null
        : screen(parsedItem.summary, `${field}.summary`);
      const rationale = parsedItem.rationale == null
        ? null
        : screen(parsedItem.rationale, `${field}.rationale`);
      const reuseRule = parsedItem.reuse_rule == null
        ? null
        : screen(parsedItem.reuse_rule, `${field}.reuse_rule`);
      const learning = parsedItem.learning == null
        ? null
        : JSON.parse(screen(JSON.stringify(parsedItem.learning), `${field}.learning`)) as Record<string, unknown>;
      const tags = parsedItem.tags.map((tag, tagIndex) => screen(tag, `${field}.tags[${tagIndex}]`));
      const itemEvidence = (parsedItem.evidence.length > 0 ? parsedItem.evidence : request.evidence)
        .map((entry, evidenceIndex) => ({
          ...entry,
          evidence_ref: screen(entry.evidence_ref, `${field}.evidence[${evidenceIndex}].evidence_ref`),
          note: entry.note == null ? null : screen(entry.note, `${field}.evidence[${evidenceIndex}].note`)
        }));
      const sourceReferences = parsedItem.source_references.map((entry, referenceIndex) => ({
        ...entry,
        type: screen(String(entry.type), `${field}.source_refs[${referenceIndex}].type`),
        ref: screen(String(entry.ref), `${field}.source_refs[${referenceIndex}].ref`),
        ...(typeof entry.title === "string"
          ? { title: screen(entry.title, `${field}.source_refs[${referenceIndex}].title`) }
          : {}),
        ...(typeof entry.summary === "string"
          ? { summary: screen(entry.summary, `${field}.source_refs[${referenceIndex}].summary`) }
          : {})
      }));
      const entities = request.entities.map((entity, entityIndex) => ({
        ...entity,
        name: screen(entity.name, `${field}.entities[${entityIndex}].name`),
        external_ref: entity.external_ref == null
          ? null
          : screen(entity.external_ref, `${field}.entities[${entityIndex}].external_ref`)
      }));
      const restrictedText = JSON.stringify({
        content, summary, rationale, reuseRule, learning, tags, itemEvidence, sourceReferences, entities
      });
      const containsRestrictedRedaction = /\[REDACTED_(?:EMAIL|PHONE|SENSITIVE)\]/u.test(restrictedText);
      const defaultValidUntil = captureV2Enabled && CAPTURE_V2_KINDS.includes(parsedItem.kind as (typeof CAPTURE_V2_KINDS)[number])
        ? parsedItem.created_at + CAPTURE_V2_TTL_MS[parsedItem.kind as (typeof CAPTURE_V2_KINDS)[number]]
        : null;
      const requestedValidUntil = parsedItem.valid_until ?? defaultValidUntil;
      const validUntil = containsRestrictedRedaction
        ? Math.min(
          requestedValidUntil ?? Number.POSITIVE_INFINITY,
          parsedItem.created_at + 7 * DAY_MS,
          Date.now() + 7 * DAY_MS
        )
        : requestedValidUntil;
      // Every persistent capture is assessed, including legacy payloads that
      // do not carry a learning object.  Missing v2 fields must lower the
      // route rather than silently bypassing the contract.
      const usefulness = assessMemoryUsefulnessV1({
        content,
        summary,
        rationale,
        reuse_rule: reuseRule,
        learning,
        evidence: itemEvidence as unknown as Array<Record<string, unknown>>,
        source_references: sourceReferences,
        quality_dimensions: parsedItem.quality_dimensions,
        capture_origin: parsedItem.capture_origin,
        verification_state: parsedItem.verification.state,
        verified_at: parsedItem.verification.verified_at,
        valid_until: typeof validUntil === "number" && Number.isFinite(validUntil) ? validUntil : null,
        reason_codes: parsedItem.reason_codes,
        ai_certification: parsedItem.ai_certification,
        judge_consensus: parsedItem.judge_consensus
      });
      if (usefulness.route === "excluded") {
        throw new HttpError(
          422,
          "memory_usefulness_excluded",
          [...usefulness.hard_violations, ...usefulness.reason_codes].join(",") || "memory usefulness gate rejected the candidate"
        );
      }
      const extracted = extractRationaleProposal({
        content,
        summary,
        projectId: parsedItem.project_id,
        entities,
        evidence: itemEvidence
      });
      prepared.push({
        input: parsedItem,
        item: {
          ...parsedItem,
          tags,
          business_category_id: classification.business_category_id,
          work_type: classification.work_type,
          content,
          summary,
          rationale,
          reuse_rule: reuseRule,
          learning,
          evidence: itemEvidence,
          source_references: sourceReferences,
          valid_until: typeof validUntil === "number" && Number.isFinite(validUntil) ? validUntil : null,
          quality_dimensions: usefulness.quality_dimensions
        },
        extracted,
        entities,
        evidence: itemEvidence,
        warnings: [
          ...(classification.classification_warning ?? []),
          ...(captureV2Enabled && !rationale ? ["rationale_missing_review_required"] : []),
          ...(usefulness.route === "quarantine" ? usefulness.reason_codes : [])
        ],
        captureV2Enabled,
        qualityRoute: usefulness.route
      });
    } catch (error) {
      if (request.legacySingle || !(error instanceof HttpError)) throw error;
      skipped.push({
        external_key: parsedItem.external_key,
        status: "skipped",
        reason_code: error.code
      });
    }
  }

  const capture = prepared.length > 0
    ? await captureMemoryItems(env, {
      tenantId: request.tenantId,
      source: request.source,
      items: prepared.map(({ item, extracted, evidence, captureV2Enabled, qualityRoute }) => ({
        external_key: item.external_key,
        content: item.content,
        summary: item.summary,
        tags: item.tags,
        created_at: item.created_at,
        project_id: item.project_id,
        actor_type: request.actorType,
        actor_id: request.actorId,
        kind: item.kind,
        lifecycle_state: qualityRoute === "quarantine" ? "suppressed" : "active",
        business_category_id: item.business_category_id,
        work_type: item.work_type,
        canonical_key: item.canonical_key,
        valid_from: item.created_at,
        valid_until: item.valid_until,
        expires_at: item.valid_until,
        confidence_score: item.confidence_score,
        utility_score: item.quality_dimensions
          ? Math.min(...Object.values(item.quality_dimensions)) / 100
          : item.utility_score,
        rationale: captureV2Enabled ? item.rationale : item.rationale ?? extracted.rationale.reason_summary,
        reuse_rule: item.reuse_rule,
        evidence: item.evidence,
        source_references: item.source_references.length > 0
          ? item.source_references
          : evidence.map((entry) => ({
            type: entry.evidence_type,
            ref: entry.evidence_ref,
            title: entry.note ?? undefined
          })),
        permissions: item.visibility === "restricted"
          ? item.allowed_principals.map((principalId) => ({
            principal_type: "principal",
            principal_id: principalId,
            permissions: ["read"]
          }))
          : [],
        capture_origin: item.capture_origin,
        capture_route: item.capture_route,
        capture_batch_id: item.capture_batch_id,
        verification_state: item.verification.state,
        verified_at: item.verification.verified_at,
        learning: item.learning,
        quality_dimensions: item.quality_dimensions
      })),
      operation: "capture"
    })
    : { tenant_id: request.tenantId, source: request.source, inserted: 0, updated: 0, items: [] };

  const results: CaptureCandidateResult[] = [];
  let deduplicatedCount = 0;
  for (const [index, entry] of prepared.entries()) {
    const captured = capture.items[index];
    if (!captured?.memory_id) throw new HttpError(500, "memory_capture_failed", "Failed to persist memory");
    if (captured.deduplicated) {
      deduplicatedCount += 1;
      results.push({
        external_key: entry.item.external_key,
        status: "skipped",
        reason_code: "duplicate_canonical_key",
        memory_id: captured.memory_id,
        rationale_id: null,
        rationale_skipped: true,
        decision_memory_id: null
      });
      continue;
    }
    const effectiveRationale = entry.item.rationale ?? (
      entry.captureV2Enabled
        ? CAPTURE_V2_UNRESOLVED_RATIONALE
        : entry.extracted.rationale.reason_summary
    );
    const rationale = await persistInferredRationale(env, {
      tenantId: request.tenantId,
      memoryId: captured.memory_id,
      projectId: entry.item.project_id,
      rationale: {
        ...entry.extracted.rationale,
        ...(entry.captureV2Enabled
          ? { decision_type: captureV2DecisionType(entry.item.kind, entry.extracted.rationale.decision_type) }
          : {}),
        reason_summary: effectiveRationale,
        ...(entry.item.confidence_score !== null ? { confidence_score: entry.item.confidence_score } : {})
      },
      entities: entry.entities.length > 0 ? entry.entities : entry.extracted.entities,
      evidence: entry.evidence.length > 0 ? entry.evidence : entry.extracted.evidence
    });
    const decision = (env.ORGBRAIN_MEMORY_CAPTURE_V2_MODE === "on" || entry.item.verification.state === "verified") &&
      (entry.item.kind === "decision" || entry.item.kind === "constraint")
      ? await upsertAutoDecisionMemory(env, {
        tenantId: request.tenantId,
        memoryId: captured.memory_id,
        source: request.source,
        externalKey: entry.item.external_key,
        projectId: entry.item.project_id,
        businessCategoryId: entry.item.business_category_id,
        workType: entry.item.work_type,
        kind: entry.item.kind,
        title: entry.item.summary ?? entry.item.content,
        decision: entry.item.content,
        rationale: effectiveRationale,
        evidence: entry.evidence,
        sourceReferences: entry.item.source_references.length > 0
          ? entry.item.source_references
          : entry.evidence.map((evidence) => ({
            type: evidence.evidence_type,
            ref: evidence.evidence_ref,
            title: evidence.note ?? undefined
          })),
        validFrom: entry.item.created_at,
        validUntil: entry.item.valid_until,
        confidence: entry.item.confidence_score ?? entry.extracted.rationale.confidence_score ?? 0.5,
        visibility: entry.item.visibility,
        allowedPrincipals: entry.item.allowed_principals,
        principal: request.actorId
      })
      : null;
    results.push({
      external_key: entry.item.external_key,
      status: captured.created ? "created" : "updated",
      reason_code: captured.created ? "captured" : "idempotent_update",
      memory_id: captured.memory_id,
      rationale_id: rationale.rationale_id,
      rationale_skipped: rationale.skipped,
      decision_memory_id: decision?.decisionMemory.id ?? null,
      ...(entry.warnings.length ? { classification_warning: entry.warnings } : {})
    });
  }
  results.push(...skipped);

  const response: CaptureMemoryWithRationaleResult = {
    tenant_id: request.tenantId,
    source: request.source,
    inserted: capture.inserted,
    updated: capture.updated,
    capture,
    results,
    summary: {
      accepted: prepared.length - deduplicatedCount,
      skipped: skipped.length + deduplicatedCount,
      created: capture.inserted,
      updated: capture.updated
    }
  };
  if (!request.legacySingle) return response;
  const first = results[0] ?? {};
  return {
    ...response,
    memory_id: first.memory_id ?? null,
    rationale_id: first.rationale_id ?? null,
    rationale_skipped: first.rationale_skipped ?? false,
    rationale_skip_reason: null,
    confirmation_state: first.rationale_skipped ? null : "inferred_unconfirmed",
    ...(first.classification_warning ? { classification_warning: first.classification_warning } : {})
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
    business_category_id: payload.proposed_memory.business_category_id,
    work_type: payload.proposed_memory.work_type,
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
