import {
  MEMORY_MAP_TRACE_CONTRACT_VERSION,
  type MemoryMapTraceDerived,
  type MemoryMapTraceRationale,
  type MemoryMapTraceResponse
} from "@org-brain/contracts";
import { HttpError } from "@org-brain/shared";
import { getDecisionResourceTrace } from "./resource-decision-service";
import { getMemoryDetails, stableResultReadable, type MemoryDetail } from "./memory-service";
import type { Env } from "./types";

export type MemoryMapTraceOptions = {
  tenantId: string;
  principal: string;
  projectId?: string | null;
  scope: "mine" | "org";
  memoryId?: string | null;
  decisionRationaleId?: string | null;
};

type MemoryAccessRow = {
  id: string;
  project_id: string | null;
  owner_principal: string | null;
  permissions_json: string | null;
  deleted_at: number | null;
  lifecycle_state: string | null;
};

type RationaleParentRow = {
  id: string;
  memory_id: string;
  project_id: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(record: Record<string, unknown> | null, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 20);
}

function alternatives(record: Record<string, unknown> | null) {
  const value = record?.alternatives;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) {
      return [{ alternative: item.trim(), reason_rejected: null }];
    }
    const entry = asRecord(item);
    const alternative = stringValue(entry, "alternative") ?? stringValue(entry, "option");
    if (!alternative) return [];
    return [{
      alternative,
      reason_rejected: stringValue(entry, "reason_rejected") ?? stringValue(entry, "reason")
    }];
  }).slice(0, 20);
}

function parseLearning(raw: unknown): Record<string, unknown> | null {
  if (asRecord(raw)) return asRecord(raw);
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function deriveLearning(learning: Record<string, unknown> | null): MemoryMapTraceDerived {
  return {
    lesson_type: stringValue(learning, "lesson_type"),
    trigger: stringValue(learning, "trigger"),
    question: stringValue(learning, "question"),
    decision_key: stringValue(learning, "decision_key"),
    decision: stringValue(learning, "decision"),
    selected_value: stringValue(learning, "selected_value"),
    rationale: stringValue(learning, "rationale") ?? stringValue(learning, "why_it_worked"),
    alternatives: alternatives(learning),
    constraints: stringList(learning, "constraints"),
    reuse_when: stringValue(learning, "reuse_when") ?? stringValue(learning, "reuse_rule"),
    outcome: stringValue(learning, "outcome") ?? stringValue(learning, "observed_outcome"),
    symptom: stringValue(learning, "symptom"),
    failed_approach: stringValue(learning, "failed_approach"),
    root_cause: stringValue(learning, "root_cause"),
    correction: stringValue(learning, "correction"),
    verified_outcome: stringValue(learning, "verified_outcome"),
    avoidance_rule: stringValue(learning, "avoidance_rule")
  };
}

function safeLearning(learning: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!learning) return null;
  // Keep the memory summary useful without returning selectors, applicability,
  // contract hashes, or any other capture payload that is not part of the
  // trace contract.
  return deriveLearning(learning);
}

async function loadMemoryAccess(env: Env, options: MemoryMapTraceOptions, memoryId: string) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, project_id, owner_principal, permissions_json, deleted_at, lifecycle_state
     FROM memories WHERE tenant_id = ? AND id = ?`
  ).bind(options.tenantId, memoryId).first<MemoryAccessRow>();
  if (!row) throw new HttpError(404, "memory_not_found", "Memory not found");
  if (row.deleted_at !== null || row.lifecycle_state === "suppressed") {
    throw new HttpError(404, "memory_not_found", "Memory not found");
  }
  if (options.projectId && row.project_id !== options.projectId) {
    throw new HttpError(404, "memory_not_found", "Memory not found");
  }
  if (options.scope === "mine" && row.owner_principal !== options.principal) {
    throw new HttpError(404, "memory_not_found", "Memory not found");
  }
  if (!stableResultReadable(row.permissions_json, options.principal)) {
    throw new HttpError(404, "memory_not_found", "Memory not found");
  }
  return row;
}

async function loadRationaleParent(env: Env, options: MemoryMapTraceOptions, rationaleId: string) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT r.id, r.memory_id, r.project_id
     FROM decision_rationales r
     WHERE r.tenant_id = ? AND r.id = ?`
  ).bind(options.tenantId, rationaleId).first<RationaleParentRow>();
  if (!row) throw new HttpError(404, "decision_not_found", "Decision rationale not found");
  await loadMemoryAccess(env, options, row.memory_id);
  if (options.projectId && row.project_id && row.project_id !== options.projectId) {
    throw new HttpError(404, "decision_not_found", "Decision rationale not found");
  }
  return row;
}

async function loadRationaleDetails(
  env: Env,
  tenantId: string,
  memoryId: string,
  rationaleId: string
): Promise<MemoryDetail["rationales"][number]> {
  const rationale = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, decision_type, conclusion, reason_summary, status, confirmation_state,
            confidence_score, created_at, confirmed_at
     FROM decision_rationales
     WHERE tenant_id = ? AND memory_id = ? AND id = ?`
  ).bind(tenantId, memoryId, rationaleId).first<Omit<MemoryDetail["rationales"][number], "evidence">>();
  if (!rationale) throw new HttpError(404, "decision_not_found", "Decision rationale not found");
  const evidence = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, evidence_type, evidence_ref, relation, note, weight_score,
            content_hash, observed_at, attestation_ref
     FROM decision_evidence
     WHERE tenant_id = ? AND rationale_id = ?
     ORDER BY created_at DESC
     LIMIT 100`
  ).bind(tenantId, rationaleId).all<MemoryDetail["rationales"][number]["evidence"][number]>();
  return { ...rationale, evidence: evidence.results };
}

function uniqueMissing(values: Array<MemoryMapTraceResponse["completeness"]["missing"][number]>) {
  return [...new Set(values)];
}

function buildCompleteness(
  memory: NonNullable<MemoryMapTraceResponse["memory"]>,
  rationales: MemoryMapTraceRationale[],
  rationaleTruncated: boolean,
  resourceTruncated: boolean
): MemoryMapTraceResponse["completeness"] {
  const missing: Array<MemoryMapTraceResponse["completeness"]["missing"][number]> = [];
  if (rationales.length === 0) missing.push("decision");
  let evidenceCount = 0;
  let sourceCount = 0;
  let artifactCount = 0;
  for (const rationale of rationales) {
    if (!rationale.conclusion && !rationale.derived.decision && !rationale.derived.correction) missing.push("decision");
    if (!rationale.reason_summary && !rationale.derived.rationale && !rationale.derived.root_cause) missing.push("reason");
    if (rationale.derived.lesson_type === "decision" && rationale.derived.alternatives.length === 0) missing.push("alternative");
    evidenceCount += rationale.evidence.length;
    sourceCount += rationale.resources.sources.length;
    artifactCount += rationale.resources.artifacts.length;
    if (rationale.evidence.length === 0) missing.push("evidence");
    if (rationale.resources.artifacts.length === 0) missing.push("artifact");
  }
  if (memory.verification_state !== "verified") missing.push("verification");
  const truncated = rationaleTruncated || resourceTruncated;
  return {
    rationale_count: rationales.length,
    evidence_count: evidenceCount,
    source_count: sourceCount,
    artifact_count: artifactCount,
    missing: uniqueMissing(missing),
    partial: missing.length > 0 || truncated,
    truncated
  };
}

export async function getMemoryMapTrace(
  env: Env,
  options: MemoryMapTraceOptions
): Promise<MemoryMapTraceResponse> {
  if (Boolean(options.memoryId) === Boolean(options.decisionRationaleId)) {
    throw new HttpError(400, "invalid_query", "exactly one selected node is required");
  }

  const parent = options.decisionRationaleId
    ? await loadRationaleParent(env, options, options.decisionRationaleId)
    : null;
  const memoryId = parent?.memory_id ?? options.memoryId;
  if (!memoryId) throw new HttpError(400, "invalid_query", "memory_id or decision_rationale_id is required");
  await loadMemoryAccess(env, options, memoryId);

  const details = await getMemoryDetails(env, options.tenantId, memoryId, {
    actorPrincipal: options.principal,
    recordUsage: false
  });
  if (!details.memory) throw new HttpError(404, "memory_not_found", "Memory not found");

  const selectedRationale = parent?.id
    ? await loadRationaleDetails(env, options.tenantId, memoryId, parent.id)
    : null;
  const sourceRationales = selectedRationale
    ? [selectedRationale]
    : details.rationales;
  const rationales = selectedRationale
    ? [...sourceRationales, ...details.rationales.filter((rationale) => rationale.id !== selectedRationale.id)]
    : details.rationales;
  const limitedRationales = rationales.slice(0, 20);
  const selectedRationaleId = parent?.id ?? null;
  const learning = parseLearning(details.memory?.learning);
  const resourceProjectId = options.projectId ?? details.memory.project_id;
  const traces = await Promise.all(limitedRationales.map(async (rationale) => {
    const resources = await getDecisionResourceTrace(env, options.tenantId, {
      source_type: "decision_rationale",
      source_id: rationale.id
    }, {
      principal: options.principal,
      projectId: resourceProjectId
    });
    return {
      id: rationale.id,
      decision_type: rationale.decision_type,
      conclusion: rationale.conclusion,
      reason_summary: rationale.reason_summary,
      status: rationale.status,
      confirmation_state: rationale.confirmation_state,
      confidence_score: rationale.confidence_score,
      created_at: rationale.created_at,
      confirmed_at: rationale.confirmed_at,
      derived: deriveLearning(learning),
      evidence: rationale.evidence,
      resources: {
        sources: resources.sources,
        artifacts: resources.artifacts
      },
      resourceTruncated: resources.truncated
    };
  }));
  const resourceTruncated = traces.some((trace) => trace.resourceTruncated);
  const normalizedRationales: MemoryMapTraceRationale[] = traces.map(({ resourceTruncated: _resourceTruncated, ...rationale }) => rationale);
  const memory = {
    id: details.memory.id,
    project_id: details.memory.project_id,
    kind: details.memory.kind,
    summary: details.memory.summary,
    lifecycle_state: details.memory.lifecycle_state,
    verification_state: details.memory.verification_state,
    verified_at: details.memory.verified_at,
    reuse_rule: details.memory.reuse_rule,
    learning: safeLearning(learning),
    versions: details.versions
  };
  return {
    contract_version: MEMORY_MAP_TRACE_CONTRACT_VERSION,
    selected: {
      node_type: selectedRationaleId ? "decision" : "memory",
      id: selectedRationaleId ?? memoryId,
      memory_id: memoryId,
      decision_rationale_id: selectedRationaleId
    },
    memory,
    selected_rationale_id: selectedRationaleId,
    rationales: normalizedRationales,
    completeness: buildCompleteness(memory, normalizedRationales, rationales.length > 20, resourceTruncated)
  };
}
