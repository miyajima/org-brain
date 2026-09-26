import { HttpError, ulid } from "@org-brain/shared";
import type { Env } from "./types";
import { suppressMemory } from "./memory-lifecycle-service";
import { assertPermission } from "./rbac-service";
import { evaluateResourceRead, loadAccessPolicies, loadPrincipalGroupIds } from "./access-policy-service";
import { screenMemoryCaptureText } from "./memory-screening-service";

type MemoryIdentity = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  current_version: number;
  owner_principal: string | null;
  actor_id: string | null;
  kind: string | null;
};
type FeedbackKind = "stale" | "wrong";
type RelationKind = "contradicts" | "fixes";
type ReviewDecision = "confirm" | "reject" | "resolve";

export async function annotateMemorySearchIntegrity<T extends { kind: string; id: string; current_version?: number; integrity_warnings?: string[] }>(
  env: Env, tenantId: string, rows: T[]
): Promise<T[]> {
  return Promise.all(rows.map(async (row) => {
    if (row.kind !== "memory" || !row.current_version) return row;
    const match = await env.OPEN_BRAIN_DB.prepare(`SELECT 1 AS found FROM memory_integrity_relations r
      JOIN memories a ON a.tenant_id=r.tenant_id AND a.id=r.from_memory_id
      JOIN memories b ON b.tenant_id=r.tenant_id AND b.id=r.to_memory_id
      WHERE r.tenant_id=? AND r.status='confirmed' AND r.relation='contradicts'
        AND a.current_version=r.from_version AND b.current_version=r.to_version
        AND ((r.from_memory_id=? AND r.from_version=?) OR (r.to_memory_id=? AND r.to_version=?)) LIMIT 1`)
      .bind(tenantId, row.id, row.current_version, row.id, row.current_version).first();
    return match ? { ...row, integrity_warnings: ["unresolved_contradiction"] } : row;
  }));
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "invalid_payload", "Object required");
  return input as Record<string, unknown>;
}
function shortText(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new HttpError(400, "invalid_payload", `${name} is invalid`);
  return value.trim();
}
function version(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new HttpError(400, "invalid_payload", "version must be a positive integer");
  return Number(value);
}
function evidence(value: unknown): Array<{ type: string; ref: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new HttpError(400, "evidence_required", "1-16 references required");
  return value.map((raw) => {
    const item = object(raw);
    return { type: shortText(item.type, "evidence.type", 32), ref: screenMemoryCaptureText(shortText(item.ref, "evidence.ref", 256), "evidence.ref") };
  });
}
async function memory(env: Env, tenantId: string, id: string): Promise<MemoryIdentity> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, tenant_id, project_id, current_version, owner_principal, actor_id, kind FROM memories WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL"
  ).bind(tenantId, id).first<MemoryIdentity>();
  if (!row) throw new HttpError(404, "memory_not_found", "Memory not found");
  return row;
}
function assertOwner(row: MemoryIdentity, principal: string) {
  if (principal !== (row.owner_principal || row.actor_id)) throw new HttpError(403, "reviewer_not_authorized", "Owner review required");
}
function requireOwnerForSensitiveMemory(row: MemoryIdentity, principal: string) {
  if (["decision", "preference", "constraint"].includes(row.kind ?? "")) assertOwner(row, principal);
}

export async function reportMemoryFeedback(env: Env, tenantId: string, raw: unknown, reporter: string) {
  const input = object(raw);
  const memoryId = shortText(input.memory_id, "memory_id", 128);
  const targetVersion = version(input.memory_version);
  if (input.kind !== "stale" && input.kind !== "wrong") throw new HttpError(400, "invalid_payload", "kind must be stale or wrong");
  const kind = input.kind as FeedbackKind;
  const row = await memory(env, tenantId, memoryId);
  await assertPermission(env, { tenantId, projectId: row.project_id ?? undefined, principal: reporter, permission: "read" });
  if (row.current_version !== targetVersion) {
    const prior = await env.OPEN_BRAIN_DB.prepare("SELECT 1 FROM memory_versions WHERE tenant_id = ? AND memory_id = ? AND version = ?")
      .bind(tenantId, memoryId, targetVersion).first();
    if (!prior) throw new HttpError(404, "memory_version_not_found", "Memory version not found");
  }
  const item = { id: ulid(), tenant_id: tenantId, memory_id: memoryId, memory_version: targetVersion, kind,
    reason: screenMemoryCaptureText(shortText(input.reason, "reason", 1000), "reason"), evidence: evidence(input.evidence),
    reporter_principal: reporter, status: "reported" as const, created_at: Date.now() };
  await env.OPEN_BRAIN_DB.prepare(`INSERT INTO memory_quality_feedback
    (id,tenant_id,memory_id,memory_version,kind,reason,evidence_json,reporter_principal,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(item.id, tenantId, memoryId, targetVersion, kind, item.reason,
    JSON.stringify(item.evidence), reporter, item.status, item.created_at).run();
  return item;
}

export async function reviewMemoryFeedback(env: Env, tenantId: string, feedbackId: string, decision: ReviewDecision, reviewer: string) {
  if (decision !== "confirm" && decision !== "reject") throw new HttpError(400, "invalid_payload", "Invalid decision");
  const item = await env.OPEN_BRAIN_DB.prepare("SELECT * FROM memory_quality_feedback WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, feedbackId).first<{ id: string; memory_id: string; memory_version: number; kind: FeedbackKind; status: string }>();
  if (!item || item.status !== "reported") throw new HttpError(409, "feedback_not_reported", "Feedback is not pending");
  const row = await memory(env, tenantId, item.memory_id);
  await assertPermission(env, { tenantId, projectId: row.project_id ?? undefined, principal: reviewer, permission: "write" });
  requireOwnerForSensitiveMemory(row, reviewer);
  const status = decision === "confirm" ? "confirmed" : "rejected";
  const now = Date.now();
  if (status === "confirmed" && item.kind === "wrong" && row.current_version === item.memory_version) {
    await suppressMemory(env, { tenantId, memoryId: item.memory_id, reason: "verified_wrong", actorType: "principal", actorId: reviewer,
      expectedVersion: item.memory_version, markCompacted: false });
  }
  await env.OPEN_BRAIN_DB.prepare("UPDATE memory_quality_feedback SET status = ?, reviewer_principal = ?, reviewed_at = ? WHERE tenant_id = ? AND id = ? AND status = 'reported'")
    .bind(status, reviewer, now, tenantId, feedbackId).run();
  return { id: feedbackId, status, reviewer_principal: reviewer, reviewed_at: now };
}

export async function proposeMemoryRelation(env: Env, tenantId: string, raw: unknown, proposer: string) {
  const input = object(raw);
  const fromId = shortText(input.from_memory_id, "from_memory_id", 128);
  const toId = shortText(input.to_memory_id, "to_memory_id", 128);
  if (fromId === toId || !["contradicts", "fixes"].includes(String(input.relation))) throw new HttpError(400, "invalid_payload", "Invalid relation");
  const fromVersion = version(input.from_version);
  const toVersion = version(input.to_version);
  const [from, to] = await Promise.all([memory(env, tenantId, fromId), memory(env, tenantId, toId)]);
  await assertPermission(env, { tenantId, projectId: from.project_id ?? undefined, principal: proposer, permission: "read" });
  if (from.project_id !== to.project_id || from.current_version !== fromVersion || to.current_version !== toVersion) {
    throw new HttpError(409, "relation_scope_or_version_mismatch", "Current versions in the same project are required");
  }
  const item = { id: ulid(), tenant_id: tenantId, from_memory_id: fromId, from_version: fromVersion,
    to_memory_id: toId, to_version: toVersion, relation: input.relation as RelationKind,
    evidence: evidence(input.evidence), proposer_principal: proposer, status: "proposed" as const, created_at: Date.now() };
  await env.OPEN_BRAIN_DB.prepare(`INSERT INTO memory_integrity_relations
    (id,tenant_id,from_memory_id,from_version,to_memory_id,to_version,relation,evidence_json,proposer_principal,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(item.id, tenantId, fromId, fromVersion, toId, toVersion,
    item.relation, JSON.stringify(item.evidence), proposer, item.status, item.created_at).run();
  return item;
}

export async function reviewMemoryRelation(env: Env, tenantId: string, relationId: string, decision: ReviewDecision, reviewer: string) {
  if (!["confirm", "reject", "resolve"].includes(decision)) throw new HttpError(400, "invalid_payload", "Invalid decision");
  const relation = await env.OPEN_BRAIN_DB.prepare("SELECT * FROM memory_integrity_relations WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, relationId).first<{ id: string; from_memory_id: string; from_version: number; to_memory_id: string; to_version: number; status: string }>();
  if (!relation) throw new HttpError(404, "relation_not_found", "Relation not found");
  const [from, to] = await Promise.all([memory(env, tenantId, relation.from_memory_id), memory(env, tenantId, relation.to_memory_id)]);
  await assertPermission(env, { tenantId, projectId: from.project_id ?? undefined, principal: reviewer, permission: "write" });
  requireOwnerForSensitiveMemory(from, reviewer);
  requireOwnerForSensitiveMemory(to, reviewer);
  if (decision === "confirm" && (from.current_version !== relation.from_version || to.current_version !== relation.to_version)) {
    throw new HttpError(409, "relation_version_changed", "Review requires the proposed current versions");
  }
  if (decision === "resolve" ? relation.status !== "confirmed" : relation.status !== "proposed") {
    throw new HttpError(409, "relation_invalid_state", "Relation cannot be reviewed in its current state");
  }
  const status = decision === "resolve" ? "resolved" : decision === "confirm" ? "confirmed" : "rejected";
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare("UPDATE memory_integrity_relations SET status = ?, reviewer_principal = ?, reviewed_at = ?, resolved_at = ? WHERE tenant_id = ? AND id = ?")
    .bind(status, reviewer, now, status === "resolved" ? now : null, tenantId, relationId).run();
  return { id: relationId, status, reviewer_principal: reviewer, reviewed_at: now };
}

export async function listMemoryIntegrityIssues(env: Env, tenantId: string, projectId: string, principal: string) {
  const [feedback, relations] = await Promise.all([
    env.OPEN_BRAIN_DB.prepare(`SELECT f.id, f.memory_id, f.memory_version, f.kind, f.status, f.created_at
      FROM memory_quality_feedback f JOIN memories m ON m.tenant_id = f.tenant_id AND m.id = f.memory_id
      WHERE f.tenant_id = ? AND m.project_id = ? AND (f.status = 'reported' OR (f.status = 'confirmed' AND f.kind = 'stale'))
        AND m.current_version = f.memory_version`)
      .bind(tenantId, projectId).all(),
    env.OPEN_BRAIN_DB.prepare(`SELECT r.id, r.from_memory_id, r.to_memory_id, r.relation, r.status, r.created_at
      FROM memory_integrity_relations r
      JOIN memories a ON a.tenant_id = r.tenant_id AND a.id = r.from_memory_id
      JOIN memories b ON b.tenant_id = r.tenant_id AND b.id = r.to_memory_id
      WHERE r.tenant_id = ? AND a.project_id = ? AND b.project_id = ? AND r.status = 'confirmed'
        AND r.relation = 'contradicts' AND a.current_version = r.from_version AND b.current_version = r.to_version`)
      .bind(tenantId, projectId, projectId).all()
  ]);
  const ids = [...new Set([
    ...feedback.results.map((row) => String((row as { memory_id: string }).memory_id)),
    ...relations.results.flatMap((row) => [String((row as { from_memory_id: string }).from_memory_id), String((row as { to_memory_id: string }).to_memory_id)])
  ])];
  const [policies, groupIds] = await Promise.all([
    loadAccessPolicies(env, tenantId, "memory", ids),
    loadPrincipalGroupIds(env, tenantId, principal)
  ]);
  const readable = (id: string) => {
    const policy = policies.get(id);
    return !policy || evaluateResourceRead(policy, { tenantId, principal, projectId }, groupIds);
  };
  return {
    feedback: feedback.results.filter((row) => readable(String((row as { memory_id: string }).memory_id))),
    contradictions: relations.results.filter((row) => readable(String((row as { from_memory_id: string }).from_memory_id))
      && readable(String((row as { to_memory_id: string }).to_memory_id)))
  };
}
