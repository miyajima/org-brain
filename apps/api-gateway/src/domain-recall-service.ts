import { domainPackManifestDigest, rankDomainRecallCandidates, type DomainRecallRankingCandidate } from "@org-brain/core";
import { domainPackManifestSchema, type RecallProfileV1 } from "@org-brain/contracts";
import { HttpError, ulid } from "@org-brain/shared";
import { installDomainPacks } from "./domain-pack-service";
import type { Env } from "./types";

type RecallIdentity = {
  ownerPrincipal: string;
  runtimeActor?: string;
  clientInstallationId?: string | null;
  clientName?: string | null;
};

type RecallUnitRow = {
  id: string; tenant_id: string; project_id: string | null; pack_id: string;
  object_type_key: string; object_id: string | null; intent_aliases_json: string; scope_json: string;
  relation: "primary" | "supporting" | "conflict"; decision_json: string; metrics_json: string;
  evidence_json: string; workflow: string | null; follow_up: string | null; evidence_verified: number;
  metric_fresh: number; visibility: "tenant" | "project" | "restricted"; owner_principal: string | null;
  allowed_principals_json: string; valid_until: number | null; updated_at: number; manifest_json: string;
};

const PORTABLE_VERSION = "orgbrain-portable-archive/v1";

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_payload", "request body must be an object");
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string, limit = 256): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new HttpError(400, "invalid_payload", `${field} must be a non-empty string`);
  return value.trim();
}

function identifier(value: unknown, field: string): string {
  const text = optionalString(value, field);
  if (!text || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(text)) throw new HttpError(400, "invalid_payload", `${field} is invalid`);
  return text;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonical(value));

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function recallMode(env: Env): "off" | "shadow" | "on" {
  return env.DOMAIN_RECALL_MODE === "shadow" || env.DOMAIN_RECALL_MODE === "on" ? env.DOMAIN_RECALL_MODE : "off";
}

function evidenceMetadata(raw: string): Array<Record<string, unknown>> {
  return parseJson<Array<Record<string, unknown>>>(raw, []).slice(0, 32).map((item) => ({
    id: item.id,
    title: item.title,
    source: item.source ?? item.source_system,
    resource_kind: item.resource_kind,
    verification_state: item.verification_state,
    observed_at: item.observed_at
  }));
}

function metricsWithoutStaleValues(raw: string, now: number): Array<Record<string, unknown>> {
  return parseJson<Array<Record<string, unknown>>>(raw, []).slice(0, 128).map((metric) => {
    const expiresAt = typeof metric.expires_at === "number" ? metric.expires_at : null;
    const stale = metric.state === "stale" || metric.state === "unknown" || (expiresAt !== null && expiresAt < now);
    return stale ? { ...metric, state: metric.state === "unknown" ? "unknown" : "stale", value: null } : metric;
  });
}

export async function getDomainRecall(env: Env, raw: unknown, identity: RecallIdentity) {
  const body = objectBody(raw);
  const tenantId = identifier(body.tenant_id, "tenant_id");
  const projectId = optionalString(body.project_id, "project_id", 128);
  const prompt = optionalString(body.query ?? body.prompt ?? body.task_text, "query", 4_000);
  if (!prompt) throw new HttpError(400, "invalid_payload", "query is required");
  const maxTokens = body.max_tokens ?? body.domain_recall_max_tokens ?? 2_000;
  if (!Number.isInteger(maxTokens) || Number(maxTokens) < 256 || Number(maxTokens) > 8_000) {
    throw new HttpError(400, "invalid_payload", "max_tokens must be an integer between 256 and 8000");
  }
  // Four UTF-8 bytes per requested token is a conservative transport budget;
  // the hook's non-negotiable 6 KiB ceiling remains the upper bound.
  const payloadBudgetBytes = Math.min(6 * 1024, Number(maxTokens) * 4);
  if (prompt.length < 4 || /^(ok|はい|うん|了解|ありがとう|thanks)[.!。！\s]*$/iu.test(prompt)) return { mode: recallMode(env), inject: false, bundle: null, skipped: "short_or_acknowledgement" };
  const mode = recallMode(env);
  if (mode === "off") return { mode, inject: false, bundle: null };
  const objectTypeKey = optionalString(body.object_type_key, "object_type_key", 128);
  const objectId = optionalString(body.object_id, "object_id", 128);
  const sessionId = optionalString(body.session_id, "session_id", 256);
  const scope = body.scope && typeof body.scope === "object" && !Array.isArray(body.scope)
    ? Object.fromEntries(Object.entries(body.scope as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT u.*, r.manifest_json
     FROM domain_recall_units u
     JOIN domain_pack_installations i ON i.tenant_id=u.tenant_id AND i.pack_id=u.pack_id AND i.state='installed'
     JOIN domain_pack_releases r ON r.id=i.release_id AND r.status='active'
     WHERE u.tenant_id=? AND (u.project_id IS NULL OR u.project_id=?)
       AND (u.valid_until IS NULL OR u.valid_until>=?)
     ORDER BY u.updated_at DESC, u.id LIMIT 200`
  ).bind(tenantId, projectId, Date.now()).all<RecallUnitRow>();
  const suppressedRows = await env.OPEN_BRAIN_DB.prepare(
    "SELECT candidate_id FROM domain_recall_preferences WHERE tenant_id=? AND principal=? AND state='suppressed'"
  ).bind(tenantId, identity.ownerPrincipal).all<{ candidate_id: string }>();
  const suppressed = new Set(suppressedRows.results.map((row) => row.candidate_id));
  if (sessionId) {
    const sessionRows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT DISTINCT COALESCE(f.candidate_id, c.recall_unit_id) AS candidate_id
       FROM domain_recall_feedback f
       LEFT JOIN domain_recall_event_candidates c
         ON c.tenant_id=f.tenant_id AND c.recall_id=f.recall_id
       WHERE f.tenant_id=? AND f.owner_principal=? AND f.session_id=?
         AND f.effect='session_suppression'`
    ).bind(tenantId, identity.ownerPrincipal, sessionId).all<{ candidate_id: string }>();
    sessionRows.results.forEach((row) => suppressed.add(row.candidate_id));
  }
  const ranked = rows.results.flatMap((row) => {
    const allowed = row.visibility === "tenant"
      || row.owner_principal === identity.ownerPrincipal
      || parseJson<string[]>(row.allowed_principals_json, []).includes(identity.ownerPrincipal);
    const manifest = parseJson<{ recall_profile?: RecallProfileV1 }>(row.manifest_json, {});
    if (!manifest.recall_profile) return [];
    const candidate: DomainRecallRankingCandidate = {
      id: row.id, tenant_id: row.tenant_id, project_id: row.project_id, object_type_key: row.object_type_key,
      object_id: row.object_id, intent_aliases: parseJson(row.intent_aliases_json, []), scope: parseJson(row.scope_json, {}),
      relation: row.relation, has_decision_link: Boolean(parseJson<{ id?: string }>(row.decision_json, {}).id),
      decision_state: parseJson<{ confirmation_state?: DomainRecallRankingCandidate["decision_state"] }>(row.decision_json, {}).confirmation_state ?? "proposal",
      evidence_verified: Boolean(row.evidence_verified), metric_fresh: Boolean(row.metric_fresh), acl_allowed: allowed,
      personally_suppressed: suppressed.has(row.id)
    };
    return rankDomainRecallCandidates(manifest.recall_profile, { tenant_id: tenantId, project_id: projectId, prompt, object_type_key: objectTypeKey, object_id: objectId, scope }, [candidate])
      .map((item) => ({ item, row }));
  }).sort((left, right) => right.item.score.total - left.item.score.total || left.item.id.localeCompare(right.item.id));
  const now = Date.now();
  const publicCandidate = ({ item, row }: (typeof ranked)[number], role = row.relation) => ({
    recall_unit_id: row.id,
    role,
    why_recalled: item.why_recalled,
    scope: parseJson(row.scope_json, {}),
    score: item.score,
    decision: parseJson(row.decision_json, {}),
    metrics: metricsWithoutStaleValues(row.metrics_json, now),
    evidence: evidenceMetadata(row.evidence_json),
    workflow: row.workflow,
    follow_up: row.follow_up
  });
  const ordinary = ranked.filter(({ row }) => row.relation !== "conflict");
  const primary = ordinary[0] ? publicCandidate(ordinary[0], "primary") : null;
  const supporting = ordinary.slice(1, 3).map((candidate) => publicCandidate(candidate, "supporting"));
  const conflicts = ranked.filter(({ row }) => row.relation === "conflict").slice(0, 2).map((candidate) => publicCandidate(candidate, "conflict"));
  const queryHash = await sha256(prompt);
  const selectedIds = [primary, ...supporting, ...conflicts].filter(Boolean).map((item) => item!.recall_unit_id);
  const id = `recall-${(await sha256(`${tenantId}:${projectId ?? ""}:${identity.ownerPrincipal}:${queryHash}:${selectedIds.join(":")}`)).slice(0, 24)}`;
  let bundle: Record<string, unknown> = {
    contract_version: "domain-recall/v1", id, generated_at: now, query_hash: queryHash, primary, supporting, conflicts,
    warnings: [primary, ...supporting, ...conflicts].filter(Boolean).flatMap((candidate) => candidate!.metrics.some((metric) => metric.state !== "measured") ? [`${candidate!.recall_unit_id}:stale_or_unknown_metric`] : []),
    trace_url: `/domain-recalls/${id}?tenant_id=${encodeURIComponent(tenantId)}`,
    summary: primary ? `OrgBrainから想起: ${String((primary.decision as Record<string, unknown>).statement ?? "Decision")}` : "関連度Gateを満たすOrgBrain Recallはありません"
  };
  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > payloadBudgetBytes) bundle = { ...bundle, supporting: [], conflicts: [], primary: primary ? { ...primary, metrics: [], evidence: primary.evidence.slice(0, 3) } : null, warnings: [...bundle.warnings as string[], "payload_truncated"] };
  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > payloadBudgetBytes) bundle = {
    ...bundle,
    primary: null,
    supporting: [],
    conflicts: [],
    summary: "関連候補はありますが、指定されたtoken上限では安全なRecall cardを返せません。",
    warnings: ["payload_truncated", "token_budget_too_small"]
  };
  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > payloadBudgetBytes) throw new HttpError(500, "payload_budget_exceeded", `Domain Recall payload exceeds ${payloadBudgetBytes} bytes`);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT OR REPLACE INTO domain_recall_events(id, tenant_id, project_id, owner_principal, runtime_actor,
      client_installation_id, client_name, query_hash, candidate_count, mode, bundle_json, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, projectId, identity.ownerPrincipal, identity.runtimeActor ?? identity.ownerPrincipal,
    identity.clientInstallationId ?? null, identity.clientName ?? null, queryHash, selectedIds.length, mode, JSON.stringify(bundle), now).run();
  const rowById = new Map(ranked.map(({ row }) => [row.id, row]));
  const eventCandidates = [primary, ...supporting, ...conflicts].filter((candidate): candidate is NonNullable<typeof primary> => Boolean(candidate));
  if (eventCandidates.length) {
    await env.OPEN_BRAIN_DB.batch(eventCandidates.flatMap((candidate, rank) => {
      const source = rowById.get(candidate.recall_unit_id);
      return source ? [env.OPEN_BRAIN_DB.prepare(
        `INSERT OR REPLACE INTO domain_recall_event_candidates(
          recall_id, tenant_id, recall_unit_id, pack_id, role, rank, score, created_at
        ) VALUES(?,?,?,?,?,?,?,?)`
      ).bind(id, tenantId, candidate.recall_unit_id, source.pack_id, candidate.role, rank, candidate.score.total, now)] : [];
    }));
  }
  return { mode, inject: mode === "on", bundle };
}

export async function getDomainRecallById(env: Env, tenantId: string, recallId: string, principal: string, includeAll = false) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT bundle_json FROM domain_recall_events
     WHERE tenant_id=? AND id=? AND (?=1 OR owner_principal=?)`
  ).bind(tenantId, recallId, includeAll ? 1 : 0, principal).first<{ bundle_json: string }>();
  if (!row) throw new HttpError(404, "not_found", "Domain Recall not found");
  return parseJson(row.bundle_json, {});
}

export async function recordDomainRecallFeedback(env: Env, tenantId: string, recallId: string, raw: unknown, identity: RecallIdentity) {
  const body = objectBody(raw);
  const feedback = optionalString(body.feedback, "feedback", 64);
  const effects: Record<string, string> = { useful: "none", dismiss_for_session: "session_suppression", not_relevant: "personal_suppression", wrong_scope: "personal_suppression", outdated: "team_review_proposal", incorrect_relation: "team_review_proposal" };
  const effect = feedback ? effects[feedback] : null;
  if (!feedback || !effect) throw new HttpError(400, "invalid_payload", "invalid feedback");
  const candidateId = optionalString(body.candidate_id, "candidate_id", 256);
  const sessionId = optionalString(body.session_id, "session_id", 256);
  if (effect === "session_suppression" && !sessionId) throw new HttpError(400, "invalid_payload", "session_id is required");
  const existing = await env.OPEN_BRAIN_DB.prepare("SELECT id FROM domain_recall_events WHERE tenant_id=? AND id=? AND owner_principal=?")
    .bind(tenantId, recallId, identity.ownerPrincipal).first();
  if (!existing) throw new HttpError(404, "not_found", "Domain Recall not found");
  if (candidateId) {
    const selected = await env.OPEN_BRAIN_DB.prepare(
      "SELECT recall_unit_id FROM domain_recall_event_candidates WHERE tenant_id=? AND recall_id=? AND recall_unit_id=?"
    ).bind(tenantId, recallId, candidateId).first();
    if (!selected) throw new HttpError(400, "invalid_candidate", "candidate_id was not selected for this Recall");
  }
  const now = Date.now();
  const id = ulid(now);
  const statements = [env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO domain_recall_feedback(id, tenant_id, recall_id, candidate_id, owner_principal, runtime_actor,
      client_installation_id, session_id, feedback, effect, note, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, recallId, candidateId, identity.ownerPrincipal, identity.runtimeActor ?? identity.ownerPrincipal,
    identity.clientInstallationId ?? null, sessionId, feedback, effect, optionalString(body.note, "note", 2_000), now)];
  if (effect === "personal_suppression" && candidateId) statements.push(env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO domain_recall_preferences(tenant_id, principal, candidate_id, state, reason, updated_at)
     VALUES(?,?,?,'suppressed',?,?) ON CONFLICT(tenant_id, principal, candidate_id)
     DO UPDATE SET state='suppressed', reason=excluded.reason, updated_at=excluded.updated_at`
  ).bind(tenantId, identity.ownerPrincipal, candidateId, feedback, now));
  if (effect === "team_review_proposal") statements.push(env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO domain_recall_review_proposals(id, tenant_id, recall_id, candidate_id, proposal_type,
      proposed_by_principal, note, created_at) VALUES(?,?,?,?,?,?,?,?)`
  ).bind(ulid(now + 1), tenantId, recallId, candidateId, feedback, identity.ownerPrincipal, optionalString(body.note, "note", 2_000), now));
  await env.OPEN_BRAIN_DB.batch(statements);
  return { id, feedback, effect, assertion_mutated: false };
}

export async function createPortableImport(env: Env, tenantId: string, ownerPrincipal: string, raw: unknown) {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const now = Date.now();
  const id = ulid(now);
  const expectedDigest = optionalString(body.expected_digest, "expected_digest", 64);
  if (expectedDigest && !/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new HttpError(400, "invalid_payload", "expected_digest must be SHA-256");
  await env.OPEN_BRAIN_DB.prepare("INSERT INTO portable_imports(id, tenant_id, owner_principal, state, expected_digest, created_at, updated_at) VALUES(?,?,?,'uploading',?,?,?)")
    .bind(id, tenantId, ownerPrincipal, expectedDigest, now, now).run();
  return { id, state: "uploading", expected_digest: expectedDigest };
}

export async function putPortableImportChunk(env: Env, tenantId: string, importId: string, sequence: number, raw: unknown) {
  const body = objectBody(raw);
  const chunk = optionalString(body.chunk, "chunk", 1_000_000);
  if (!chunk || !Number.isInteger(sequence) || sequence < 0) throw new HttpError(400, "invalid_payload", "valid sequence and chunk are required");
  const digest = await sha256(chunk);
  if (body.digest !== undefined && body.digest !== digest) throw new HttpError(409, "digest_mismatch", "chunk digest does not match");
  const parent = await env.OPEN_BRAIN_DB.prepare("SELECT state FROM portable_imports WHERE tenant_id=? AND id=?").bind(tenantId, importId).first<{ state: string }>();
  if (!parent) throw new HttpError(404, "not_found", "Portable import not found");
  if (parent.state !== "uploading") throw new HttpError(409, "invalid_state", "Portable import no longer accepts chunks");
  await env.OPEN_BRAIN_DB.prepare("INSERT INTO portable_import_chunks(import_id, tenant_id, sequence, chunk_text, chunk_digest, created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(import_id, sequence) DO UPDATE SET chunk_text=excluded.chunk_text, chunk_digest=excluded.chunk_digest")
    .bind(importId, tenantId, sequence, chunk, digest, Date.now()).run();
  return { import_id: importId, sequence, digest };
}

async function loadPortableArchive(env: Env, tenantId: string, importId: string) {
  const chunks = await env.OPEN_BRAIN_DB.prepare("SELECT sequence, chunk_text FROM portable_import_chunks WHERE tenant_id=? AND import_id=? ORDER BY sequence")
    .bind(tenantId, importId).all<{ sequence: number; chunk_text: string }>();
  if (!chunks.results.length || chunks.results.some((row, index) => row.sequence !== index)) throw new HttpError(409, "chunks_incomplete", "Portable import chunks must be contiguous from sequence 0");
  const lines = chunks.results.map((row) => row.chunk_text).join("").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = lines[0]; const footer = lines.at(-1); const records = lines.slice(1, -1);
  if (header?.contract_version !== PORTABLE_VERSION || header.record_type !== "header" || footer?.record_type !== "footer" || header.archive_id !== footer.archive_id || records.length !== footer.record_count) throw new HttpError(400, "invalid_archive", "Portable archive envelope is invalid");
  const digest = await sha256(records.map((record) => `${canonicalJson(record)}\n`).join(""));
  if (digest !== footer.content_digest) throw new HttpError(409, "digest_mismatch", "Portable archive digest does not match footer");
  return { header, footer, records, digest };
}

export async function planPortableImport(env: Env, tenantId: string, importId: string) {
  const archive = await loadPortableArchive(env, tenantId, importId);
  const actions = [];
  for (const record of archive.records) {
    const section = String(record.section); const recordId = String(record.id); const digest = String(record.digest);
    if (await sha256(canonicalJson(record.payload)) !== digest) throw new HttpError(409, "digest_mismatch", `Portable record digest mismatch: ${section}/${recordId}`);
    const existing = await env.OPEN_BRAIN_DB.prepare("SELECT digest FROM portable_import_records WHERE tenant_id=? AND section=? AND record_id=? ORDER BY applied_at DESC LIMIT 1")
      .bind(tenantId, section, recordId).first<{ digest: string }>();
    actions.push({ section, id: recordId, digest, action: !existing ? "apply" : existing.digest === digest ? "skip_same_digest" : "reject_digest_conflict" });
  }
  const plan = { import_id: importId, archive_id: archive.header.archive_id, content_digest: archive.digest, record_count: archive.records.length, actions, applicable: !actions.some((action) => action.action === "reject_digest_conflict") };
  await env.OPEN_BRAIN_DB.prepare("UPDATE portable_imports SET state=?, record_count=?, plan_json=?, updated_at=? WHERE tenant_id=? AND id=?")
    .bind(plan.applicable ? "planned" : "rejected", plan.record_count, JSON.stringify(plan), Date.now(), tenantId, importId).run();
  return plan;
}

async function materializePortableRecord(env: Env, tenantId: string, ownerPrincipal: string, record: Record<string, unknown>, now: number) {
  const section = String(record.section);
  const payload = objectBody(record.payload);
  if (section === "domain_pack_installations") {
    const manifest = domainPackManifestSchema.parse(typeof payload.manifest_json === "string" ? JSON.parse(payload.manifest_json) : payload.manifest_json);
    const manifestDigest = await domainPackManifestDigest(manifest);
    if (payload.manifest_digest !== manifestDigest) throw new HttpError(409, "digest_mismatch", `Pack manifest digest mismatch: ${manifest.pack_id}`);
    if (!manifest.pack_id.startsWith("function.")) {
      const releaseId = `portable:${tenantId}:${manifest.pack_id}:${manifest.version}:${manifestDigest.slice(0, 12)}`;
      await env.OPEN_BRAIN_DB.prepare(
        `INSERT OR IGNORE INTO domain_pack_releases(
          id, owner_tenant_id, pack_id, version, classification, visibility, manifest_digest,
          manifest_json, publisher_id, license_id, status, created_at
        ) VALUES(?,?,?,?,?,'private',?,?,?,?, 'active',?)`
      ).bind(releaseId, tenantId, manifest.pack_id, manifest.version, manifest.classification, manifestDigest,
        canonicalJson(manifest), tenantId, "portable-import", now).run();
    }
    await installDomainPacks({ ...env, DOMAIN_PACKS_MODE: "install" }, tenantId, ownerPrincipal, { pack_ids: [manifest.pack_id] });
    return;
  }
  if (["memories", "memory_versions", "decisions", "decision_versions", "knowledge_resources"].includes(section)) {
    const table = ({
      memories: "memories",
      memory_versions: "memory_versions",
      decisions: "decision_memories",
      decision_versions: "decision_memory_versions",
      knowledge_resources: "knowledge_resources"
    } as const)[section as "memories" | "memory_versions" | "decisions" | "decision_versions" | "knowledge_resources"];
    const columns = await env.OPEN_BRAIN_DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const allowed = new Set(columns.results.map((column) => column.name));
    const mapped: Record<string, unknown> = { ...payload, tenant_id: tenantId };
    const names = Object.keys(mapped).filter((name) => allowed.has(name) && /^[a-z_][a-z0-9_]*$/u.test(name));
    if (!names.length || !names.includes("id")) throw new HttpError(400, "invalid_archive", `${section} record has no materializable ID`);
    await env.OPEN_BRAIN_DB.prepare(`INSERT OR IGNORE INTO ${table}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`)
      .bind(...names.map((name) => mapped[name])).run();
    if (section === "memories") {
      await env.OPEN_BRAIN_DB.prepare("INSERT OR REPLACE INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)")
        .bind(String(payload.id), tenantId, String(payload.content ?? "")).run();
    }
    return;
  }
  if (section === "managed_objects") {
    const type = await env.OPEN_BRAIN_DB.prepare("SELECT id FROM managed_object_types WHERE tenant_id=? AND type_key=?")
      .bind(tenantId, String(payload.object_type_key)).first<{ id: string }>();
    if (!type) throw new HttpError(409, "portable_dependency_missing", `Managed object type is not installed: ${String(payload.object_type_key)}`);
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT OR IGNORE INTO managed_objects(
        id, tenant_id, project_id, object_type_id, object_key, name, attributes_json,
        visibility, owner_principal, created_by, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(String(payload.id), tenantId, payload.project_id ?? null, type.id, String(payload.id), String(payload.name),
      String(payload.attributes_json ?? "{}"), String(payload.visibility ?? "tenant"), payload.owner_principal ?? null,
      ownerPrincipal, Number(payload.created_at ?? now), Number(payload.updated_at ?? now)).run();
    return;
  }
  if (section === "metric_definitions") {
    const metricKey = String(payload.metric_key);
    const existing = await env.OPEN_BRAIN_DB.prepare("SELECT id FROM metric_definitions WHERE tenant_id=? AND metric_key=?")
      .bind(tenantId, metricKey).first<{ id: string }>();
    if (existing) return;
    const definitionJson = String(payload.definition_json);
    const version = Number(payload.version ?? 1);
    await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO metric_definitions(
          id, tenant_id, metric_key, current_version, origin_type, origin_pack_id,
          origin_pack_version, promoted_release_id, created_by, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(String(payload.id), tenantId, metricKey, version, String(payload.origin_type ?? "custom"), payload.pack_id ?? null,
        null, null, ownerPrincipal, Number(payload.created_at ?? now), Number(payload.updated_at ?? now)),
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO metric_definition_versions(
          id, tenant_id, metric_definition_id, version, definition_json, definition_digest, created_by, created_at
        ) VALUES(?,?,?,?,?,?,?,?)`
      ).bind(`portable-version:${String(payload.id)}:${version}`, tenantId, String(payload.id), version, definitionJson,
        await sha256(definitionJson), ownerPrincipal, Number(payload.created_at ?? now))
    ]);
    return;
  }
  if (section === "metric_snapshots") {
    const definition = await env.OPEN_BRAIN_DB.prepare("SELECT id FROM metric_definitions WHERE tenant_id=? AND metric_key=?")
      .bind(tenantId, String(payload.metric_key)).first<{ id: string }>();
    if (!definition) throw new HttpError(409, "portable_dependency_missing", `Metric definition is not installed: ${String(payload.metric_key)}`);
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT OR IGNORE INTO metric_snapshots(
        id, tenant_id, metric_definition_id, binding_id, value, state, dimensions_json,
        observed_at, expires_at, evidence_ref, query_digest, idempotency_key, recorded_by, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(String(payload.id), tenantId, definition.id, null, payload.value ?? null, String(payload.state),
      String(payload.dimensions_json ?? "{}"), Number(payload.observed_at), Number(payload.expires_at),
      payload.evidence_ref ?? null, null, String(payload.idempotency_key), ownerPrincipal, Number(payload.created_at ?? now)).run();
    return;
  }
  if (section === "metric_targets") {
    const definitionId = String(payload.metric_definition_id);
    const definition = await env.OPEN_BRAIN_DB.prepare("SELECT id FROM metric_definitions WHERE tenant_id=? AND id=?")
      .bind(tenantId, definitionId).first<{ id: string }>();
    if (!definition) throw new HttpError(409, "portable_dependency_missing", `Metric definition is not installed: ${definitionId}`);
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT OR IGNORE INTO metric_targets(
        id, tenant_id, metric_definition_id, binding_id, target_value, target_min,
        target_max, direction, effective_from, effective_to, reason, set_by, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(String(payload.id), tenantId, definition.id, payload.binding_id ?? null, payload.target_value ?? null,
      payload.target_min ?? null, payload.target_max ?? null, String(payload.direction), Number(payload.effective_from),
      payload.effective_to ?? null, payload.reason ?? null, ownerPrincipal, Number(payload.created_at ?? now)).run();
    return;
  }
  if (section === "decision_domain_links") {
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT OR IGNORE INTO knowledge_assertions(
        id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
        object_type, object_ref, resource_id, object_value, context_json, confidence,
        confirmation_state, idempotency_key, valid_from, valid_until, actor_principal,
        reviewed_by_principal, created_at, updated_at
      ) VALUES(?,?,NULL,'relation',?,?,?,?,?,NULL,NULL,'{}',1,?,?,?,?,?,NULL,?,?)`
    ).bind(String(payload.id), tenantId, String(payload.decision_source_type), String(payload.decision_source_id),
      String(payload.relation), String(payload.object_type), String(payload.object_id), String(payload.confirmation_state),
      `portable:${String(payload.id)}`, Number(payload.created_at ?? now), null, ownerPrincipal,
      Number(payload.created_at ?? now), Number(payload.created_at ?? now)).run();
    return;
  }
  if (section === "recall_preferences") {
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO domain_recall_preferences(tenant_id, principal, candidate_id, state, reason, updated_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id, principal, candidate_id) DO UPDATE SET
       state=excluded.state, reason=excluded.reason, updated_at=excluded.updated_at`
    ).bind(tenantId, String(payload.principal), String(payload.candidate_id), String(payload.state),
      payload.reason ?? null, Number(payload.updated_at ?? now)).run();
    return;
  }
  throw new HttpError(400, "invalid_archive", `Unsupported portable section: ${section}`);
}

export async function applyPortableImport(env: Env, tenantId: string, importId: string) {
  const plan = await planPortableImport(env, tenantId, importId);
  if (!plan.applicable) throw new HttpError(409, "digest_conflict", "Portable import contains an ID with a different digest");
  const archive = await loadPortableArchive(env, tenantId, importId);
  const now = Date.now();
  const owner = await env.OPEN_BRAIN_DB.prepare("SELECT owner_principal FROM portable_imports WHERE tenant_id=? AND id=?")
    .bind(tenantId, importId).first<{ owner_principal: string }>();
  if (!owner) throw new HttpError(404, "not_found", "Portable import not found");
  let appliedCount = 0;
  for (const [index, record] of archive.records.entries()) {
    if (plan.actions[index]?.action !== "apply") continue;
    await materializePortableRecord(env, tenantId, owner.owner_principal, record, now);
    await env.OPEN_BRAIN_DB.prepare(
      "INSERT INTO portable_import_records(import_id, tenant_id, section, record_id, digest, payload_json, applied_at) VALUES(?,?,?,?,?,?,?)"
    ).bind(importId, tenantId, String(record.section), String(record.id), String(record.digest), JSON.stringify(record.payload), now).run();
    appliedCount += 1;
  }
  await env.OPEN_BRAIN_DB.prepare("UPDATE portable_imports SET state='applied', applied_at=?, updated_at=? WHERE tenant_id=? AND id=?")
    .bind(now, now, tenantId, importId).run();
  return { ...plan, applied_count: appliedCount, immutable_records_retained: true, materialized: true, resumable: true };
}
