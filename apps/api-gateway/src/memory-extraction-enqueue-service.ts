import {
  assertMemoryExtractionInputWithinCeiling,
  validateV3Packet,
  assertV3ProviderProfile,
  buildMemoryExtractionPrompt,
  HttpError,
  MEMORY_EXTRACTION_TOKEN_PROFILE,
  MEMORY_CONTRACT_V2_CONTRACT_HASH,
  type Envelope,
  screenSensitiveMemory,
  sha256,
  type TaskCreatedPayload,
  ulid
} from "@org-brain/shared";
import type { Env } from "./types";

const RESERVED_TOKENS = 2_800;
const TIER2_LIMIT = 500_000;
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const STANDARD_CAPSULE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const RESTRICTED_CAPSULE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROMPT_VERSION = "memory-extraction-prompt/v2";
const REDACTION_VERSION = "turn-evidence-redaction/v1";
const PREFILTER_VERSION = "memory-extraction-router/v2";
const SCHEMA_VERSION = "learning-extraction-proposal/v2";
const ACCEPTED_PACKET_SCHEMAS = new Set(["learning-extraction-proposal/v1", SCHEMA_VERSION, "learning-extraction-proposal/v3"]);

type EnqueueInput = {
  project_id: string;
  provider: "openai" | "gemini" | "anthropic";
  model: string;
  session_hash: string;
  turn_hash: string;
  packet: Record<string, unknown>;
  packet_hash?: string;
  tier?: "tier2" | "tier3";
  retention_class?: "standard" | "restricted";
  schema_version?: string;
  prompt_version?: string;
  redaction_version?: string;
  prefilter_version?: string;
};

type EnqueueOptions = {
  tenantId: string;
  principal: string;
  installationId: string;
};

type HmacKey = { version: string; key: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, field: string, limit = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new HttpError(400, "invalid_payload", `${field} is required`);
  return value.trim();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function parseInput(raw: unknown): EnqueueInput {
  const value = asRecord(raw);
  const provider = text(value.provider, "provider", 32);
  if (!(["openai", "gemini", "anthropic"] as string[]).includes(provider)) throw new HttpError(400, "invalid_payload", "provider must be openai, gemini, or anthropic");
  const tier = value.tier ?? "tier2";
  if (tier !== "tier2") throw new HttpError(400, "tier3_requires_certification_pipeline", "this extraction route is Tier 2 only");
  const retentionClass = value.retention_class ?? "standard";
  if (retentionClass !== "standard" && retentionClass !== "restricted") throw new HttpError(400, "invalid_payload", "retention_class is invalid");
  const packet = asRecord(value.packet);
  if (!ACCEPTED_PACKET_SCHEMAS.has(String(packet.schema))) {
    throw new HttpError(400, "invalid_payload", "packet must use learning-extraction-proposal/v1 or v2");
  }
  const limits = asRecord(packet.limits);
  if (packet.schema === "learning-extraction-proposal/v3") {
    try { validateV3Packet(packet); } catch (error) {
      throw new HttpError(400, "invalid_payload", error instanceof Error ? error.message : "v3_packet_invalid");
    }
    // No verified provider request token profile has been installed for v3.
    try { assertV3ProviderProfile(); } catch {
      throw new HttpError(503, "unsupported_token_profile", "v3 is offline shadow only until its provider profile is verified");
    }
  }
  if (limits.input_tokens !== 2_000 || limits.output_tokens !== 800 || limits.candidates !== 3 || limits.calls !== 1) {
    throw new HttpError(400, "invalid_payload", "packet token and call limits must match the server contract");
  }
  try {
    assertMemoryExtractionInputWithinCeiling(buildMemoryExtractionPrompt(packet));
  } catch {
    throw new HttpError(413, "memory_extraction_input_too_large", "redacted extraction evidence exceeds the 2000-token ceiling");
  }
  return {
    project_id: text(value.project_id, "project_id", 128),
    provider: provider as EnqueueInput["provider"],
    model: text(value.model, "model", 128),
    session_hash: text(value.session_hash, "session_hash", 128),
    turn_hash: text(value.turn_hash, "turn_hash", 128),
    packet,
    packet_hash: typeof value.packet_hash === "string" ? value.packet_hash : undefined,
    tier,
    retention_class: retentionClass,
    schema_version: typeof value.schema_version === "string" ? value.schema_version : SCHEMA_VERSION,
    prompt_version: typeof value.prompt_version === "string" ? value.prompt_version : PROMPT_VERSION,
    redaction_version: typeof value.redaction_version === "string" ? value.redaction_version : REDACTION_VERSION,
    prefilter_version: typeof value.prefilter_version === "string" ? value.prefilter_version : PREFILTER_VERSION
  };
}

function hmacKeys(env: Env): { active: HmacKey; previous: HmacKey | null } {
  if (!env.MEMORY_EXTRACTION_HMAC_KEYS_JSON?.trim()) throw new HttpError(503, "memory_extraction_not_configured", "memory extraction HMAC keys are not configured");
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(env.MEMORY_EXTRACTION_HMAC_KEYS_JSON));
  } catch {
    throw new HttpError(503, "memory_extraction_not_configured", "memory extraction HMAC key configuration is invalid");
  }
  const parseKey = (value: unknown): HmacKey | null => {
    const row = asRecord(value);
    return typeof row.version === "string" && row.version.trim() && typeof row.key === "string" && row.key.length >= 32
      ? { version: row.version.trim().slice(0, 64), key: row.key }
      : null;
  };
  const active = parseKey(parsed.active);
  if (!active) throw new HttpError(503, "memory_extraction_not_configured", "active memory extraction HMAC key is invalid");
  return { active, previous: parseKey(parsed.previous) };
}

async function hmac(key: HmacKey, value: string): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", new TextEncoder().encode(key.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function providerAllowed(env: Env, provider: string, model: string): boolean {
  if (!env.MEMORY_EXTRACTION_PROVIDER_MODELS_JSON?.trim()) return false;
  try {
    const parsed = JSON.parse(env.MEMORY_EXTRACTION_PROVIDER_MODELS_JSON) as unknown;
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(asRecord(parsed).entries) ? asRecord(parsed).entries as unknown[] : [];
    return entries.map(asRecord).some((entry) => entry.provider === provider
      && entry.model === model
      && entry.zero_retention === true
      && entry.strict_json_schema === true
      && entry.input_token_profile === MEMORY_EXTRACTION_TOKEN_PROFILE);
  } catch {
    return false;
  }
}

function tierLimit(env: Env, tier: "tier2" | "tier3"): number {
  const configured = Number(tier === "tier2" ? env.MEMORY_EXTRACTION_TIER2_MONTHLY_TOKENS : env.MEMORY_EXTRACTION_TIER3_MONTHLY_TOKENS);
  if (Number.isSafeInteger(configured) && configured >= 0) return configured;
  return tier === "tier2" ? TIER2_LIMIT : 0;
}

function utcMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

async function existingByKeys(env: Env, tenantId: string, keys: string[]) {
  for (const key of keys) {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, task_id, execution_status, outcome, reserved_tokens, cache_hit
       FROM memory_extraction_runs WHERE tenant_id = ? AND cache_key = ?`
    ).bind(tenantId, key).first<{ id: string; task_id: string; execution_status: string; outcome: string | null; reserved_tokens: number; cache_hit: number }>();
    if (row) return row;
  }
  return null;
}

function response(row: { id: string; task_id: string; execution_status: string; outcome: string | null; reserved_tokens: number }, cacheHit: boolean) {
  return {
    run_id: row.id,
    task_id: row.task_id,
    execution_status: row.execution_status,
    outcome: row.outcome,
    reserved_tokens: cacheHit ? 0 : row.reserved_tokens,
    cache_hit: cacheHit
  };
}

async function insertTerminalRun(env: Env, args: {
  runId: string; taskId: string; tenantId: string; projectId: string; installationId: string;
  provider: string; model: string; packetHash: string; cacheKey: string; keyVersion: string;
  schemaVersion: string; promptVersion: string; redactionVersion: string; prefilterVersion: string;
  outcome: "hard_excluded" | "model_unavailable" | "no_candidate"; errorCode: string | null; now: number; capsuleExpiresAt: number;
}) {
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO memory_extraction_runs(
       id, tenant_id, project_id, installation_id, task_id, execution_status, outcome,
       provider, model, packet_hash, cache_key, key_version, schema_version, contract_hash,
       prompt_version, redaction_version, prefilter_version, reserved_tokens, charged_tokens,
       staging_r2_key, error_code, created_at, updated_at, settled_at, staging_expires_at, capsule_expires_at
     ) VALUES(?,?,?,?,?,'settled',?,?,?,?,?,?,?,?,?,?,?,0,0,'',?,?,?,?,?,?)`
  ).bind(
    args.runId, args.tenantId, args.projectId, args.installationId, args.taskId, args.outcome,
    args.provider, args.model, args.packetHash, args.cacheKey, args.keyVersion, args.schemaVersion,
    MEMORY_CONTRACT_V2_CONTRACT_HASH, args.promptVersion, args.redactionVersion, args.prefilterVersion,
    args.errorCode, args.now, args.now, args.now, args.now + STAGING_TTL_MS, args.capsuleExpiresAt
  ).run();
}

export async function enqueueMemoryExtraction(env: Env, raw: unknown, options: EnqueueOptions) {
  const mode = env.ORGBRAIN_MEMORY_EXTRACTION_MODE ?? "off";
  if (mode === "off" || mode === "shadow") {
    throw new HttpError(409, "memory_extraction_not_executable", `memory extraction enqueue is disabled in ${mode} mode`);
  }
  const input = parseInput(raw);
  const packetJson = stableJson(input.packet);
  const packetHash = `sha256:${await sha256(packetJson)}`;
  if (input.packet_hash && input.packet_hash !== packetHash) throw new HttpError(409, "packet_hash_mismatch", "memory extraction packet hash does not match");
  if (input.packet.project_id !== input.project_id) throw new HttpError(403, "project_scope_mismatch", "packet project does not match the authorized project");
  if (input.packet.provider !== input.provider || input.packet.model !== input.model) {
    throw new HttpError(409, "provider_model_mismatch", "packet provider/model does not match the requested provider/model");
  }
  if (input.packet.session_hash !== input.session_hash || input.packet.turn_hash !== input.turn_hash) {
    throw new HttpError(409, "turn_identity_mismatch", "packet session/turn hashes do not match the request identity");
  }
  const screened = screenSensitiveMemory(packetJson, { mode: "deny", allowed_principals: [] });
  const keys = hmacKeys(env);
  const identity = stableJson({
    tenant: options.tenantId,
    project: input.project_id,
    session: input.session_hash,
    turn: input.turn_hash,
    packet: packetHash,
    schema: input.schema_version,
    contract: MEMORY_CONTRACT_V2_CONTRACT_HASH,
    prompt: input.prompt_version,
    redaction: input.redaction_version,
    prefilter: input.prefilter_version,
    provider: input.provider,
    model: input.model
  });
  const activeCacheKey = await hmac(keys.active, identity);
  const lookupKeys = [activeCacheKey];
  if (keys.previous) lookupKeys.push(await hmac(keys.previous, identity));
  const existing = await existingByKeys(env, options.tenantId, lookupKeys);
  if (existing) return response(existing, true);

  const now = Date.now();
  const runId = ulid(now);
  const taskId = ulid(now + 1);
  const capsuleExpiresAt = now + (input.retention_class === "restricted" ? RESTRICTED_CAPSULE_TTL_MS : STANDARD_CAPSULE_TTL_MS);
  const common = {
    runId, taskId, tenantId: options.tenantId, projectId: input.project_id,
    installationId: options.installationId, provider: input.provider, model: input.model,
    packetHash, cacheKey: activeCacheKey, keyVersion: keys.active.version,
    schemaVersion: input.schema_version ?? SCHEMA_VERSION, promptVersion: input.prompt_version ?? PROMPT_VERSION,
    redactionVersion: input.redaction_version ?? REDACTION_VERSION, prefilterVersion: input.prefilter_version ?? PREFILTER_VERSION,
    now, capsuleExpiresAt
  };
  if (!screened.allowed) {
    await insertTerminalRun(env, { ...common, outcome: "hard_excluded", errorCode: screened.reason ?? "sensitive_content" });
    return response({ id: runId, task_id: taskId, execution_status: "settled", outcome: "hard_excluded", reserved_tokens: 0 }, false);
  }
  const ruleProposals = Array.isArray(input.packet.rule_proposals) ? input.packet.rule_proposals : [];
  const routing = asRecord(input.packet.routing);
  const decisions = asRecord(routing.decisions);
  const routedToLlm = routing.llm_recommended === true
    || decisions.durable_candidate === true
    || routing.disposition === "llm_candidate";
  if (ruleProposals.length === 0 && !routedToLlm) {
    await insertTerminalRun(env, { ...common, outcome: "no_candidate", errorCode: null });
    return response({ id: runId, task_id: taskId, execution_status: "settled", outcome: "no_candidate", reserved_tokens: 0 }, false);
  }
  if (!providerAllowed(env, input.provider, input.model)) {
    await insertTerminalRun(env, { ...common, outcome: "model_unavailable", errorCode: "same_model_not_allowlisted" });
    return response({ id: runId, task_id: taskId, execution_status: "settled", outcome: "model_unavailable", reserved_tokens: 0 }, false);
  }

  const stagingKey = `tenants/${options.tenantId}/memory-extraction/staging/${runId}.json`;
  const storedInput = {
    schema_version: 1,
    run_id: runId,
    tenant_id: options.tenantId,
    project_id: input.project_id,
    installation_id: options.installationId,
    provider: input.provider,
    model: input.model,
    tier: input.tier ?? "tier2",
    packet_hash: packetHash,
    contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
    prompt_version: input.prompt_version ?? PROMPT_VERSION,
    redaction_version: input.redaction_version ?? REDACTION_VERSION,
    prefilter_version: input.prefilter_version ?? PREFILTER_VERSION,
    capsule_expires_at: capsuleExpiresAt,
    packet: input.packet
  };
  await env.OPEN_BRAIN_BUCKET.put(stagingKey, JSON.stringify(storedInput), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { tenant_id: options.tenantId, run_id: runId, packet_hash: packetHash }
  });

  const month = utcMonth(now);
  const limit = tierLimit(env, input.tier ?? "tier2");
  const idem = `memory-extraction:${activeCacheKey}`;
  const envelope: Envelope<TaskCreatedPayload> = {
    message_id: ulid(now + 2),
    tenant_id: options.tenantId,
    project_id: input.project_id,
    trace_id: runId,
    type: "task.created",
    ts: now,
    idempotency_key: idem,
    payload: {
      task_id: taskId,
      capability: "memory_extraction",
      priority: 0,
      input_ref: `r2://${stagingKey}`,
      constraints: { reserved_tokens: RESERVED_TOKENS, calls: 1 },
      wait_event_type: "memory.extraction.settled"
    }
  };
  const outboxId = ulid(now + 3);
  let results: D1Result[];
  try {
    results = await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      `INSERT OR IGNORE INTO memory_extraction_token_buckets(
         tenant_id, utc_month, tier, token_limit, reserved_tokens, consumed_tokens, updated_at
       ) VALUES(?,?,?,?,0,0,?)`
    ).bind(options.tenantId, month, input.tier ?? "tier2", limit, now),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_extraction_runs(
         id, tenant_id, project_id, installation_id, task_id, execution_status, outcome,
         provider, model, packet_hash, cache_key, key_version, schema_version, contract_hash,
         prompt_version, redaction_version, prefilter_version, reserved_tokens, charged_tokens,
         staging_r2_key, created_at, updated_at, staging_expires_at, capsule_expires_at
       ) VALUES(?,?,?,?,?,'planned',NULL,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?)`
    ).bind(
      runId, options.tenantId, input.project_id, options.installationId, taskId,
      input.provider, input.model, packetHash, activeCacheKey, keys.active.version,
      input.schema_version ?? SCHEMA_VERSION, MEMORY_CONTRACT_V2_CONTRACT_HASH,
      input.prompt_version ?? PROMPT_VERSION, input.redaction_version ?? REDACTION_VERSION,
      input.prefilter_version ?? PREFILTER_VERSION, stagingKey, now, now, now + STAGING_TTL_MS, capsuleExpiresAt
    ),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_extraction_token_reservations(
         tenant_id, run_id, utc_month, tier, reserved_tokens, applied, settled, created_at
       )
       SELECT ?,?,?,?,?,0,0,?
       WHERE EXISTS (
         SELECT 1 FROM memory_extraction_token_buckets
         WHERE tenant_id = ? AND utc_month = ? AND tier = ?
           AND consumed_tokens + reserved_tokens + ? <= token_limit
       )`
    ).bind(options.tenantId, runId, month, input.tier ?? "tier2", RESERVED_TOKENS, now, options.tenantId, month, input.tier ?? "tier2", RESERVED_TOKENS),
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_extraction_token_buckets SET reserved_tokens = reserved_tokens + ?, updated_at = ?
       WHERE tenant_id = ? AND utc_month = ? AND tier = ?
         AND EXISTS (SELECT 1 FROM memory_extraction_token_reservations WHERE tenant_id = ? AND run_id = ? AND applied = 0)`
    ).bind(RESERVED_TOKENS, now, options.tenantId, month, input.tier ?? "tier2", options.tenantId, runId),
    env.OPEN_BRAIN_DB.prepare(
      "UPDATE memory_extraction_token_reservations SET applied = 1 WHERE tenant_id = ? AND run_id = ? AND applied = 0"
    ).bind(options.tenantId, runId),
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_extraction_runs SET execution_status = 'reserved', reserved_tokens = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?
         AND EXISTS (SELECT 1 FROM memory_extraction_token_reservations WHERE tenant_id = ? AND run_id = ? AND applied = 1)`
    ).bind(RESERVED_TOKENS, now, options.tenantId, runId, options.tenantId, runId),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO tasks(id, tenant_id, project_id, capability, status, priority, input_ref,
         idempotency_key, trace_id, wait_event_type, created_by_principal, created_at, updated_at)
       SELECT ?,?,?, 'memory_extraction','created',0,?,?,?,?,?,?,?
       WHERE EXISTS (SELECT 1 FROM memory_extraction_runs WHERE tenant_id = ? AND id = ? AND execution_status = 'reserved')`
    ).bind(taskId, options.tenantId, input.project_id, `r2://${stagingKey}`, idem, runId, "memory.extraction.settled", options.principal, now, now, options.tenantId, runId),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO task_events(id, tenant_id, task_id, kind, payload, created_at)
       SELECT ?,?,?, 'created',?,?
       WHERE EXISTS (SELECT 1 FROM tasks WHERE tenant_id = ? AND id = ?)`
    ).bind(ulid(now + 4), options.tenantId, taskId, JSON.stringify({ capability: "memory_extraction", run_id: runId }), now, options.tenantId, taskId),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_extraction_outbox(id, tenant_id, run_id, task_id, envelope_json, state, attempts, available_at, created_at, updated_at)
       SELECT ?,?,?,?,?, 'pending',0,?,?,?
       WHERE EXISTS (SELECT 1 FROM tasks WHERE tenant_id = ? AND id = ?)`
    ).bind(outboxId, options.tenantId, runId, taskId, JSON.stringify(envelope), now, now, now, options.tenantId, taskId)
    ]);
  } catch (error) {
    await env.OPEN_BRAIN_BUCKET.delete(stagingKey).catch(() => undefined);
    const concurrentWinner = await existingByKeys(env, options.tenantId, lookupKeys);
    if (concurrentWinner) return response(concurrentWinner, true);
    throw error;
  }
  if (Number(results[5]?.meta.changes ?? 0) !== 1) {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_extraction_runs SET execution_status = 'settled', outcome = 'budget_exhausted', error_code = 'monthly_token_budget_exhausted', settled_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND execution_status = 'planned'`
    ).bind(now, now, options.tenantId, runId).run();
    await env.OPEN_BRAIN_BUCKET.delete(stagingKey).catch(() => undefined);
    return response({ id: runId, task_id: taskId, execution_status: "settled", outcome: "budget_exhausted", reserved_tokens: 0 }, false);
  }
  await env.ORG_BUS_OUT.send(envelope, { contentType: "json" });
  await env.OPEN_BRAIN_DB.prepare(
    "UPDATE memory_extraction_outbox SET state = 'sent', sent_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND state = 'pending'"
  ).bind(Date.now(), Date.now(), options.tenantId, outboxId).run();
  return response({ id: runId, task_id: taskId, execution_status: "reserved", outcome: null, reserved_tokens: RESERVED_TOKENS }, false);
}

export async function dispatchMemoryExtractionOutbox(env: Env, now = Date.now()) {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, run_id, envelope_json, attempts
     FROM memory_extraction_outbox
     WHERE state IN ('pending','failed') AND available_at <= ?
     ORDER BY created_at ASC LIMIT 20`
  ).bind(now).all<{ id: string; tenant_id: string; run_id: string; envelope_json: string; attempts: number }>();
  let sent = 0;
  for (const row of rows.results) {
    const claimed = await env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_extraction_outbox SET state = 'sending', claimed_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND state IN ('pending','failed')`
    ).bind(now, now, row.id, row.tenant_id).run();
    if (Number(claimed.meta.changes ?? 0) !== 1) continue;
    const run = await env.OPEN_BRAIN_DB.prepare(
      "SELECT execution_status, tombstoned_at FROM memory_extraction_runs WHERE tenant_id = ? AND id = ?"
    ).bind(row.tenant_id, row.run_id).first<{ execution_status: string; tombstoned_at: number | null }>();
    if (!run || run.tombstoned_at || run.execution_status === "settled") {
      await env.OPEN_BRAIN_DB.prepare(
        "UPDATE memory_extraction_outbox SET state = 'canceled', updated_at = ? WHERE tenant_id = ? AND id = ?"
      ).bind(Date.now(), row.tenant_id, row.id).run();
      continue;
    }
    try {
      const envelope = JSON.parse(row.envelope_json) as Envelope<TaskCreatedPayload>;
      await env.ORG_BUS_OUT.send(envelope, { contentType: "json" });
      await env.OPEN_BRAIN_DB.prepare(
        "UPDATE memory_extraction_outbox SET state = 'sent', sent_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
      ).bind(Date.now(), Date.now(), row.tenant_id, row.id).run();
      sent += 1;
    } catch {
      const attempts = row.attempts + 1;
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE memory_extraction_outbox SET state = 'failed', available_at = ?, last_error_code = 'queue_send_failed', updated_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).bind(now + Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8)), Date.now(), row.tenant_id, row.id).run();
    }
  }
  return { examined: rows.results.length, sent };
}

export async function reconcileMemoryExtractionReservations(env: Env, now = Date.now()) {
  const expiredRows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, task_id, execution_status
     FROM memory_extraction_runs
     WHERE execution_status IN ('planned','reserved','running') AND staging_expires_at <= ?
     ORDER BY staging_expires_at ASC LIMIT 100`
  ).bind(now).all<{ id: string; tenant_id: string; task_id: string; execution_status: string }>();
  let expired = 0;
  for (const row of expiredRows.results) {
    const unknown = row.execution_status === "running";
    const results = await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE memory_extraction_runs
         SET execution_status = 'settled', outcome = ?, charged_tokens = ?, error_code = ?, settled_at = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND execution_status = ?`
      ).bind(
        unknown ? "outcome_unknown" : "expired",
        unknown ? RESERVED_TOKENS : 0,
        unknown ? "running_reservation_expired" : "unexecuted_reservation_expired",
        now, now, row.tenant_id, row.id, row.execution_status
      ),
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE memory_extraction_outbox SET state = 'canceled', updated_at = ?
         WHERE tenant_id = ? AND run_id = ? AND state <> 'sent'
           AND EXISTS (SELECT 1 FROM memory_extraction_runs WHERE tenant_id = ? AND id = ? AND settled_at = ? AND error_code = ?)`
      ).bind(now, row.tenant_id, row.id, row.tenant_id, row.id, now, unknown ? "running_reservation_expired" : "unexecuted_reservation_expired"),
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE tasks SET status = 'failed', updated_at = ?
         WHERE tenant_id = ? AND id = ? AND status <> 'succeeded'
           AND EXISTS (SELECT 1 FROM memory_extraction_runs WHERE tenant_id = ? AND id = ? AND settled_at = ? AND error_code = ?)`
      ).bind(now, row.tenant_id, row.task_id, row.tenant_id, row.id, now, unknown ? "running_reservation_expired" : "unexecuted_reservation_expired")
    ]);
    if (Number(results[0]?.meta.changes ?? 0) === 1) expired += 1;
  }
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT r.tenant_id, r.run_id, r.utc_month, r.tier, r.reserved_tokens, x.charged_tokens
     FROM memory_extraction_token_reservations r
     JOIN memory_extraction_runs x ON x.id = r.run_id AND x.tenant_id = r.tenant_id
     WHERE r.applied = 1 AND r.settled = 0 AND x.execution_status = 'settled'
     ORDER BY r.created_at ASC LIMIT 100`
  ).all<{ tenant_id: string; run_id: string; utc_month: string; tier: string; reserved_tokens: number; charged_tokens: number }>();
  let settled = 0;
  for (const row of rows.results) {
    const results = await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE memory_extraction_token_buckets
         SET reserved_tokens = MAX(0, reserved_tokens - ?), consumed_tokens = consumed_tokens + ?, updated_at = ?
         WHERE tenant_id = ? AND utc_month = ? AND tier = ?
           AND EXISTS (
             SELECT 1 FROM memory_extraction_token_reservations
             WHERE tenant_id = ? AND run_id = ? AND applied = 1 AND settled = 0
           )`
      ).bind(row.reserved_tokens, row.charged_tokens, now, row.tenant_id, row.utc_month, row.tier, row.tenant_id, row.run_id),
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE memory_extraction_token_reservations
         SET settled = 1, charged_tokens = ?, settled_at = ?
         WHERE tenant_id = ? AND run_id = ? AND applied = 1 AND settled = 0`
      ).bind(row.charged_tokens, now, row.tenant_id, row.run_id)
    ]);
    if (Number(results[1]?.meta.changes ?? 0) === 1) settled += 1;
  }
  return { examined: rows.results.length, settled, expired };
}

export async function sweepMemoryExtractionArtifacts(env: Env, now = Date.now()) {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, staging_r2_key, capsule_r2_key, staging_expires_at, capsule_expires_at
     FROM memory_extraction_runs
     WHERE (staging_r2_key <> '' AND staging_expires_at <= ?)
        OR (capsule_r2_key IS NOT NULL AND capsule_expires_at <= ?)
     LIMIT 100`
  ).bind(now, now).all<{ id: string; tenant_id: string; staging_r2_key: string; capsule_r2_key: string | null; staging_expires_at: number; capsule_expires_at: number }>();
  let stagingDeleted = 0;
  let capsulesDeleted = 0;
  let deleteFailed = 0;
  let orphanStagingExamined = 0;
  let orphanStagingDeleted = 0;
  for (const row of rows.results) {
    if (row.staging_r2_key && row.staging_expires_at <= now) {
      try {
        await env.OPEN_BRAIN_BUCKET.delete(row.staging_r2_key);
        await env.OPEN_BRAIN_DB.prepare("UPDATE memory_extraction_runs SET staging_r2_key = '', updated_at = ? WHERE tenant_id = ? AND id = ?").bind(now, row.tenant_id, row.id).run();
        stagingDeleted += 1;
      } catch {
        deleteFailed += 1;
      }
    }
    if (row.capsule_r2_key && row.capsule_expires_at <= now) {
      await env.OPEN_BRAIN_DB.batch([
        env.OPEN_BRAIN_DB.prepare("UPDATE memory_extraction_runs SET error_code = 'evidence_unavailable', updated_at = ? WHERE tenant_id = ? AND id = ?").bind(now, row.tenant_id, row.id),
        env.OPEN_BRAIN_DB.prepare("UPDATE memory_learning_candidates SET status = 'expired', reason_codes_json = json_insert(reason_codes_json, '$[#]', 'evidence_unavailable'), updated_at = ? WHERE tenant_id = ? AND task_key = ? AND status IN ('review','quarantine')").bind(now, row.tenant_id, `extraction:${row.id}`)
      ]);
      try {
        await env.OPEN_BRAIN_BUCKET.delete(row.capsule_r2_key);
        await env.OPEN_BRAIN_DB.prepare("UPDATE memory_extraction_runs SET capsule_r2_key = NULL, error_code = 'evidence_unavailable', updated_at = ? WHERE tenant_id = ? AND id = ?").bind(now, row.tenant_id, row.id).run();
        capsulesDeleted += 1;
      } catch {
        deleteFailed += 1;
      }
    }
  }
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const listed = await env.OPEN_BRAIN_BUCKET.list({
      prefix: "tenants/",
      cursor,
      limit: 1_000
    });
    for (const object of listed.objects) {
      if (!object.key.includes("/memory-extraction/staging/")) continue;
      if (object.uploaded.getTime() + STAGING_TTL_MS > now) continue;
      orphanStagingExamined += 1;
      const linked = await env.OPEN_BRAIN_DB.prepare(
        "SELECT id FROM memory_extraction_runs WHERE staging_r2_key = ? LIMIT 1"
      ).bind(object.key).first<{ id: string }>();
      if (linked) continue;
      try {
        await env.OPEN_BRAIN_BUCKET.delete(object.key);
        orphanStagingDeleted += 1;
      } catch {
        deleteFailed += 1;
      }
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return {
    examined: rows.results.length,
    staging_deleted: stagingDeleted,
    capsules_deleted: capsulesDeleted,
    orphan_staging_examined: orphanStagingExamined,
    orphan_staging_deleted: orphanStagingDeleted,
    delete_failed: deleteFailed
  };
}

export const __memoryExtractionEnqueueInternals = { parseInput, providerAllowed, tierLimit, stableJson, utcMonth };
