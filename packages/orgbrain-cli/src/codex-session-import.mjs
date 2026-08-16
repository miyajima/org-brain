import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  captureItemPayload,
  captureLocalMemories,
  loadEnvFallbacks,
  postLearningBatchViaMcp,
  postMemoryViaMcp,
  postMemoryViaRest,
  prepareMemoryRecordsV2,
  prepareObservedLearningRecords,
  resolveApiBase,
  resolveMcpConfig
} from "./hook-memory-bridge.mjs";
import { DEFAULT_LOCAL_DB, LocalMemoryStore } from "./lib/local-memory-store.mjs";
import { resolveMemoryMode } from "./lib/memory-mode.mjs";
import { TaskCommitmentStore } from "./lib/task-commitment-store.mjs";
import {
  loadWorkspaceConfig,
  normalizeWorkspaceRoot,
  autonomyPolicyFromWorkspaceConfig,
  workspacesFileFromEnv
} from "./lib/workspace-config.mjs";
import { buildProjectCategoryIdentity } from "../../shared/src/memory-capture-v2-runtime.mjs";
import { autonomyPolicyHash, DEFAULT_AUTONOMY_POLICY, evaluateAutonomyConsensus, normalizeAutonomyPolicy } from "../../shared/src/autonomy-policy.mjs";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const DEFAULT_MAX_TURN_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;
const INTERESTING_ROW = /"(?:session_meta|turn_context|user_message|agent_message|mcp_tool_call_end|custom_tool_call|function_call|custom_tool_call_output|function_call_output)"/u;
const REASONING_ROW = /"(?:agent_reasoning|reasoning)"/u;

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function finiteTimestamp(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name}_must_be_iso_8601`);
  return parsed;
}

function defaultOutputPath(projectId) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const safeProject = String(projectId || "global").replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80);
  return path.join(os.homedir(), ".config", "org-brain", "imports", `codex-${safeProject}-${timestamp}.json`);
}

async function writePrivateJson(file, value) {
  const destination = path.resolve(file);
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  return destination;
}

function sanitizedError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\/(?:Users|home|private|var|tmp)\/[^/\s]+(?:\/[^\s`'"),:]+)+/gu, "[REDACTED_PATH]")
    .slice(0, 500);
}

async function listJsonlFiles(root) {
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
    }
  };
  try {
    await visit(path.resolve(root));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("sessions_root_not_found");
    throw error;
  }
  return files.sort();
}

async function gitCommonDirectory(directory) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: directory, encoding: "utf8" }
    );
    return await realpath(stdout.trim());
  } catch {
    return null;
  }
}

async function workspaceIdentity(directory) {
  const normalized = normalizeWorkspaceRoot(directory);
  const resolved = await realpath(normalized).catch(() => normalized);
  const commonDirectory = await gitCommonDirectory(resolved);
  return {
    resolved,
    common_directory: commonDirectory,
    fingerprint: hash(stableJson({ resolved, common_directory: commonDirectory }))
  };
}

async function sameWorkspace(candidate, expected, cache) {
  const normalized = normalizeWorkspaceRoot(candidate);
  if (!normalized) return false;
  let identity = cache.get(normalized);
  if (identity === undefined) {
    const exists = await stat(normalized).then(() => true).catch(() => false);
    identity = exists ? await workspaceIdentity(normalized) : null;
    cache.set(normalized, identity);
  }
  if (!identity) return false;
  if (identity.resolved === expected.resolved) return true;
  return Boolean(identity.common_directory && expected.common_directory && identity.common_directory === expected.common_directory);
}

async function resolveImportContext(workspaceRoot, env = process.env) {
  await loadEnvFallbacks();
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot || process.cwd());
  const identity = await workspaceIdentity(normalizedRoot);
  const config = await loadWorkspaceConfig(workspacesFileFromEnv(env));
  const mapped = config.workspaces[normalizedRoot] ?? config.workspaces[identity.resolved] ?? null;
  const mode = resolveMemoryMode(env);
  if (mode.configurationError) throw new Error(mode.configurationError);
  const configuredTenant = typeof env.ORGBRAIN_TENANT_ID === "string" && env.ORGBRAIN_TENANT_ID.trim()
    ? env.ORGBRAIN_TENANT_ID.trim().slice(0, 128)
    : null;
  if (mode.orgSharingEnabled && !mapped?.tenant_id && !configuredTenant) {
    throw new Error("tenant_required_for_organization_import");
  }
  const tenantId = mapped?.tenant_id ?? configuredTenant ?? "default";
  const projectId = mapped?.project_id ?? (path.basename(normalizedRoot) || null);
  const categoryDigest = hash(`${tenantId}\0${projectId || "global"}`);
  const category = buildProjectCategoryIdentity(tenantId, projectId, categoryDigest);
  const autonomy = autonomyPolicyFromWorkspaceConfig(mapped, config, tenantId);
  const targetCore = {
    memory_scope: mode.scope,
    cloud_memory_enabled: mode.cloudMemoryEnabled,
    org_sharing_enabled: mode.orgSharingEnabled,
    shared_write: mode.sharedWrite,
    tenant_id: tenantId,
    project_id: projectId,
    workspace_fingerprint: identity.fingerprint,
    autonomy_policy_hash: autonomyPolicyHash(autonomy),
    business_category: category
  };
  return {
    ...targetCore,
    target_fingerprint: hash(stableJson(targetCore)),
    workspace: {
      tenantId,
      projectId,
      businessCategoryId: mapped?.business_category_id ?? category.id,
      workType: mapped?.default_work_type ?? "other",
      sensitiveMemory: mapped?.sensitive_memory ?? { mode: "deny", allowed_principals: [] },
      memoryCaptureV2Mode: mapped?.memory_capture_v2_mode ?? null,
      memoryLearningMode: mapped?.memory_learning_mode ?? "off",
      autonomy,
      workspaceRoot: identity.resolved,
      source: mapped ? "workspace" : "read-only-fallback"
    },
    workspaceIdentity: identity,
    mode
  };
}

function rowPayload(row) {
  return row?.payload && typeof row.payload === "object" ? row.payload : row;
}

function finalAnswer(row) {
  const payload = rowPayload(row);
  if (payload?.type !== "agent_message" || payload?.phase !== "final_answer") return null;
  const text = typeof payload.message === "string" ? payload.message.trim() : "";
  const occurredAt = Date.parse(row?.timestamp);
  return text && Number.isFinite(occurredAt) ? { text, occurredAt } : null;
}

function sessionMeta(row) {
  if (row?.type !== "session_meta" || !row.payload || typeof row.payload !== "object") return null;
  const startedAt = Date.parse(row.timestamp);
  const id = String(row.payload.id ?? "").trim();
  const cwd = String(row.payload.cwd ?? "").trim();
  const threadSource = String(row.payload.thread_source ?? "").trim();
  return id && cwd && Number.isFinite(startedAt) ? { id, cwd, threadSource, startedAt } : null;
}

function turnIdentity(rows, fallbackIndex) {
  const context = rows.find((row) => rowPayload(row)?.type === "turn_context");
  const turnId = String(rowPayload(context)?.turn_id ?? `legacy-${fallbackIndex}`).trim();
  return turnId || `legacy-${fallbackIndex}`;
}

function hasFormalObserveEvent(rows) {
  return rows.some((row) => {
    const item = rowPayload(row);
    if (item?.type === "mcp_tool_call_end") {
      return [item.invocation?.tool, item.invocation?.name].includes("orgbrain_memory_observe");
    }
    return ["function_call", "custom_tool_call"].includes(item?.type) && item.name === "orgbrain_memory_observe";
  });
}

function normalizeObservedRecord(record, occurredAt, externalKey) {
  const evidence = (record.evidence ?? []).map((item) => ({
    ...item,
    observedAt: occurredAt,
    note: typeof item.note === "string"
      ? item.note.replace(/observed_at=\d+/gu, `observed_at=${occurredAt}`)
      : item.note
  }));
  return {
    ...record,
    externalKey,
    createdAt: occurredAt,
    evidence,
    verification: record.verification ? { ...record.verification, verified_at: occurredAt } : record.verification,
    captureRoute: "initial_import",
    tags: [...new Set([...(record.tags ?? []), "codex-initial-import-v2"])]
  };
}

function rewriteReviewCandidate(candidate, externalKey, occurredAt, reasonCodes = []) {
  const normalized = normalizeTemporalFields(candidate, occurredAt);
  return {
    ...normalized,
    external_key: externalKey,
    created_at: occurredAt,
    expires_at: occurredAt + 180 * DAY_MS,
    reason_codes: [...new Set([...(candidate.reason_codes ?? []), ...reasonCodes])]
  };
}

function normalizeTemporalFields(value, occurredAt) {
  if (Array.isArray(value)) return value.map((item) => normalizeTemporalFields(item, occurredAt));
  if (!value || typeof value !== "object") {
    return typeof value === "string"
      ? value.replace(/observed_at=\d+/gu, `observed_at=${occurredAt}`)
      : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (["observed_at", "verified_at"].includes(key) && Number.isFinite(item)) return [key, occurredAt];
    return [key, normalizeTemporalFields(item, occurredAt)];
  }));
}

function semanticCandidateHash(candidate) {
  const projection = { ...candidate };
  delete projection.external_key;
  delete projection.externalKey;
  delete projection.import_batch_hash;
  return hash(stableJson(projection));
}

function hasAutonomousConsensus(item, policy = DEFAULT_AUTONOMY_POLICY) {
  const certification = item?.ai_certification ?? item?.verification?.ai_certification;
  const consensus = item?.judge_consensus ?? item?.verification?.judge_consensus;
  if (certification !== "ai_consensus_certified" || !consensus || typeof consensus !== "object") return false;
  const normalized = normalizeAutonomyPolicy(policy);
  return evaluateAutonomyConsensus(consensus.judgments, {
    requiredJudges: normalized.judge.active_consensus,
    minimumModelFamilies: normalized.judge.minimum_model_families,
    minimumConfidence: normalized.judge.minimum_confidence,
    requireSignatures: true
  }).pass === true;
}

function requireAutonomousActiveEvidence(planCore, policy = DEFAULT_AUTONOMY_POLICY) {
  const missing = planCore.batches
    .flatMap((batch) => batch.active ?? [])
    .filter((item) => !hasAutonomousConsensus(item, policy))
    .length;
  if (missing > 0) throw new Error(`autonomous_active_consensus_missing:${missing}`);
}

export function attachAutonomousConsensus(report, consensus) {
  if (!consensus || consensus.pass !== true) return report;
  const source = report?.plan ?? report;
  const batches = source.batches.map((batch) => ({
    ...batch,
    active: batch.active.map((item) => ({
      ...item,
      ai_certification: "ai_consensus_certified",
      judge_consensus: consensus,
      verification: {
        ...(item.verification && typeof item.verification === "object" ? item.verification : {}),
        ai_certification: "ai_consensus_certified",
        judge_consensus: consensus
      }
    }))
  }));
  const plan = { ...source, batches };
  const planHash = hash(stableJson(plan));
  return {
    schema_version: 2,
    generated_at: report?.generated_at ?? Date.now(),
    mode: report?.mode ?? "planned",
    plan_hash: planHash,
    summary: summarize(plan),
    plan,
    results: []
  };
}

async function routeTurn({ meta, rows, index, context }) {
  const final = [...rows].reverse().map(finalAnswer).find(Boolean) ?? null;
  const occurredAt = final?.occurredAt ?? meta.startedAt + index;
  const turnId = turnIdentity(rows, index);
  const sessionHash = hash(meta.id);
  const turnHash = hash(turnId);
  const baseExternalKey = `codex-import:v2:${sessionHash}:${turnHash}`;
  const hasObserve = hasFormalObserveEvent(rows);
  const excluded = [];
  const active = [];
  const quarantine = [];

  if (hasObserve) {
    const observed = await prepareObservedLearningRecords({
      sourceName: "codex",
      externalKey: `${baseExternalKey}:observe`,
      createdAt: occurredAt,
      cwd: context.workspace.workspaceRoot,
      projectId: context.project_id,
      projectIdExplicit: true,
      businessCategoryId: context.workspace.businessCategoryId,
      workType: context.workspace.workType,
      eventType: "HistoricalImport",
      metadata: { sessionId: sessionHash, turnId: turnHash }
    }, context.workspace, context.tenant_id, { rows });
    for (const record of observed.records.slice(0, 3)) {
      const normalized = captureItemPayload(normalizeObservedRecord(record, occurredAt, record.externalKey));
      const semanticHash = semanticCandidateHash(normalized);
      const externalKey = `${baseExternalKey}:${semanticHash}`;
      active.push({ ...normalized, external_key: externalKey });
    }
    for (const candidate of (observed.reviewCandidates ?? []).slice(0, Math.max(0, 3 - active.length))) {
      const normalized = rewriteReviewCandidate(candidate, candidate.external_key, occurredAt);
      const semanticHash = semanticCandidateHash(normalized);
      quarantine.push({ ...normalized, external_key: `${baseExternalKey}:${semanticHash}` });
    }
    if (active.length === 0 && quarantine.length === 0) {
      excluded.push(...(observed.report.review_reason_codes.length
        ? observed.report.review_reason_codes
        : ["observe_not_accepted"]));
    }
  } else if (final) {
    const fallback = await prepareMemoryRecordsV2({
      sourceName: "codex",
      externalKey: `${baseExternalKey}:fallback`,
      createdAt: occurredAt,
      cwd: context.workspace.workspaceRoot,
      projectId: context.project_id,
      projectIdExplicit: true,
      businessCategoryId: context.workspace.businessCategoryId,
      workType: context.workspace.workType,
      assistantText: final.text,
      eventType: "HistoricalImport",
      metadata: { sessionHash, turnHash }
    }, context.workspace, context.tenant_id);
    for (const record of fallback.records.slice(0, 3)) {
      const item = captureItemPayload({
        ...record,
        captureRoute: "initial_import",
        tags: [...new Set([...(record.tags ?? []), "codex-initial-import-v2"])]
      });
      const semanticHash = semanticCandidateHash(item);
      const externalKey = `${baseExternalKey}:${semanticHash}`;
      item.external_key = externalKey;
      quarantine.push(rewriteReviewCandidate({
        item,
        capture_intent: "review",
        verification: { state: "unverified", verified_at: null },
        evidence: item.evidence ?? []
      }, externalKey, occurredAt, ["historical_final_answer_unverified"]));
    }
    if (quarantine.length === 0) excluded.push(...(fallback.report.excluded_reasons.length
      ? fallback.report.excluded_reasons
      : ["non_durable_turn"]));
  } else {
    excluded.push("final_answer_missing");
  }

  const batch = {
    session_hash: sessionHash,
    turn_hash: turnHash,
    occurred_at: occurredAt,
    task_key: `codex:${sessionHash}:${turnHash}`,
    active,
    quarantine,
    excluded_reason_codes: [...new Set(excluded)].sort()
  };
  Object.defineProperty(batch, "review", { value: quarantine, enumerable: false, writable: false });
  return batch;
}

async function scanSession(file, context, options, workspaceCache) {
  const before = await stat(file);
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let meta = null;
  let eligible = null;
  let currentRows = [];
  let currentTurnBytes = 0;
  let currentTurnOversized = false;
  let turnIndex = 0;
  let malformedRows = 0;
  const batches = [];

  const flush = async () => {
    if (!eligible || (currentRows.length === 0 && !currentTurnOversized) || !meta) {
      currentRows = [];
      currentTurnBytes = 0;
      currentTurnOversized = false;
      return;
    }
    turnIndex += 1;
    const batch = currentTurnOversized
      ? {
          session_hash: hash(meta.id),
          turn_hash: hash(turnIdentity(currentRows, turnIndex)),
          occurred_at: meta.startedAt + turnIndex,
          task_key: `codex:${hash(meta.id)}:${hash(turnIdentity(currentRows, turnIndex))}`,
          active: [],
          quarantine: [],
          excluded_reason_codes: ["turn_size_limit_exceeded"]
        }
      : await routeTurn({ meta, rows: currentRows, index: turnIndex, context });
    if (!Object.hasOwn(batch, "review")) Object.defineProperty(batch, "review", { value: batch.quarantine, enumerable: false, writable: false });
    if (batch.occurred_at >= options.since && batch.occurred_at <= options.until) batches.push(batch);
    currentRows = [];
    currentTurnBytes = 0;
    currentTurnOversized = false;
  };

  for await (const line of lines) {
    if (!line || REASONING_ROW.test(line)) continue;
    if (!meta && !line.includes('"session_meta"')) continue;
    if (meta && eligible === false) continue;
    if (meta && !INTERESTING_ROW.test(line)) continue;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > (options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
      if (meta && eligible) currentTurnOversized = true;
      continue;
    }
    const row = safeJson(line);
    if (!row) {
      malformedRows += 1;
      continue;
    }
    if (!meta) {
      meta = sessionMeta(row);
      if (!meta) continue;
      eligible = !options.excludedSessionIds.has(meta.id) &&
        meta.threadSource === "user" &&
        await sameWorkspace(meta.cwd, context.workspaceIdentity, workspaceCache);
      continue;
    }
    const payload = rowPayload(row);
    if (payload?.type === "turn_context") await flush();
    currentTurnBytes += lineBytes;
    if (currentTurnBytes > (options.maxTurnBytes ?? DEFAULT_MAX_TURN_BYTES)) {
      currentTurnOversized = true;
      if (payload?.type === "turn_context") currentRows.push(row);
      continue;
    }
    currentRows.push(row);
  }
  await flush();
  const after = await stat(file);
  const changed = before.size !== after.size || before.mtimeMs !== after.mtimeMs;
  if (changed) return { eligible: false, reason: "session_changed_during_scan", malformedRows, batches: [] };
  if (!meta) return { eligible: false, reason: "session_metadata_missing", malformedRows, batches: [] };
  if (!eligible) return {
    eligible: false,
    reason: options.excludedSessionIds.has(meta.id)
      ? "explicitly_excluded_session"
      : meta.threadSource === "user"
        ? "workspace_mismatch"
        : "non_user_session",
    malformedRows,
    batches: []
  };
  return {
    eligible: true,
    source: { session_hash: hash(meta.id), source_path_hash: hash(path.resolve(file)), size: after.size, mtime_ms: Math.floor(after.mtimeMs) },
    malformedRows,
    batches
  };
}

function summarize(planCore) {
  const batches = planCore.batches;
  const activeItems = batches.flatMap((batch) => batch.active);
  const reviews = batches.flatMap((batch) => batch.quarantine ?? batch.review ?? []);
  const reasons = batches.flatMap((batch) => batch.excluded_reason_codes);
  const countBy = (values) => Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));
  return {
    sessions_scanned: planCore.sources.length,
    turns_scanned: batches.length,
    active_count: activeItems.length,
    review_count: reviews.length,
    quarantine_count: reviews.length,
    excluded_turn_count: batches.filter((batch) => batch.active.length === 0 && (batch.quarantine ?? batch.review ?? []).length === 0).length,
    lesson_type_counts: countBy(activeItems.map((item) => item.learning?.lesson_type ?? "unknown")),
    excluded_reason_counts: countBy(reasons)
  };
}

export async function buildCodexSessionImportPlan(options = {}) {
  const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot ?? process.cwd());
  const context = await resolveImportContext(workspaceRoot, options.env ?? process.env);
  const allFiles = await listJsonlFiles(options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT);
  const files = Number.isInteger(options.limitSessions) && options.limitSessions > 0
    ? allFiles.slice(-options.limitSessions)
    : allFiles;
  const workspaceCache = new Map();
  const sources = [];
  const batches = [];
  const scanExclusions = {};
  const scanExclusionHashes = [];
  let malformedRows = 0;
  for (const file of files) {
    const scanned = await scanSession(file, context, {
      since: options.since ?? Number.NEGATIVE_INFINITY,
      until: options.until ?? Number.POSITIVE_INFINITY,
      excludedSessionIds: options.excludedSessionIds instanceof Set ? options.excludedSessionIds : new Set(),
      maxLineBytes: options.maxLineBytes,
      maxTurnBytes: options.maxTurnBytes
    }, workspaceCache);
    malformedRows += scanned.malformedRows;
    if (!scanned.eligible) {
      scanExclusions[scanned.reason] = (scanExclusions[scanned.reason] ?? 0) + 1;
      scanExclusionHashes.push({ source_path_hash: hash(path.resolve(file)), reason: scanned.reason });
      continue;
    }
    sources.push(scanned.source);
    batches.push(...scanned.batches);
  }
  sources.sort((left, right) => left.session_hash.localeCompare(right.session_hash));
  batches.sort((left, right) => left.occurred_at - right.occurred_at || left.turn_hash.localeCompare(right.turn_hash));
  const importBatchId = hash(stableJson({ target: context.target_fingerprint, sources }));
  for (const batch of batches) {
    for (const item of batch.active) {
      item.tags = [...new Set([...(item.tags ?? []), `import-batch:${importBatchId.slice(0, 24)}`])];
      item.capture_route = "initial_import";
      item.capture_batch_id = importBatchId;
    }
    for (const candidate of (batch.quarantine ?? batch.review ?? [])) candidate.import_batch_hash = importBatchId;
  }
  const planCore = {
    schema_version: 2,
    source: "codex-sessions",
    target: {
      memory_scope: context.memory_scope,
      cloud_memory_enabled: context.cloud_memory_enabled,
      org_sharing_enabled: context.org_sharing_enabled,
      shared_write: context.shared_write,
      tenant_id: context.tenant_id,
      project_id: context.project_id,
      workspace_fingerprint: context.workspace_fingerprint,
      autonomy_policy_hash: context.autonomy_policy_hash,
      target_fingerprint: context.target_fingerprint,
      business_category: context.business_category
    },
    import_batch_id: importBatchId,
    sources,
    scan_exclusion_hashes: scanExclusionHashes.sort((left, right) => left.source_path_hash.localeCompare(right.source_path_hash)),
    batches,
    privacy: {
      raw_transcript_persisted: false,
      reasoning_read: false,
      absolute_source_paths_persisted: false,
      command_output_persisted: false
    }
  };
  return {
    planHash: hash(stableJson(planCore)),
    planCore,
    summary: {
      ...summarize(planCore),
      malformed_rows: malformedRows,
      scan_exclusion_counts: Object.fromEntries(Object.entries(scanExclusions).sort())
    },
    context
  };
}

function planRecordForLocal(item, category) {
  return {
    ...item,
    businessCategory: category,
    captureOrigin: item.capture_origin ?? "observed",
    captureRoute: item.capture_route ?? "initial_import",
    captureBatchId: item.capture_batch_id ?? null,
    verification: item.verification ?? {
      state: item.verification_state ?? "verified",
      verified_at: item.verified_at ?? null
    },
    qualityDimensions: item.quality_dimensions ?? null,
    evidence: (item.evidence ?? []).map((evidence) => ({
      type: evidence.type ?? evidence.evidence_type,
      ref: evidence.ref ?? evidence.evidence_ref,
      note: evidence.note ?? null,
      weight: evidence.weight ?? evidence.weight_score ?? null,
      contentHash: evidence.content_hash ?? null,
      observedAt: evidence.observed_at ?? null,
      attestationRef: evidence.attestation_ref ?? null
    }))
  };
}

async function validateTarget(planCore, options) {
  const context = await resolveImportContext(options.workspaceRoot ?? process.cwd(), options.env ?? process.env);
  if (context.target_fingerprint !== planCore.target.target_fingerprint) throw new Error("import_target_changed");
  return context;
}

async function applyLocal(planCore, context, options) {
  const store = options.store ?? new LocalMemoryStore(options.dbPath ?? process.env.ORGBRAIN_LOCAL_DB ?? DEFAULT_LOCAL_DB);
  const candidateStore = new TaskCommitmentStore(store.dbPath);
  const results = [];
  for (const batch of planCore.batches) {
    try {
      const activeResults = batch.active.length
        ? await captureLocalMemories("codex", context.tenant_id, batch.active.map((item) => planRecordForLocal(item, planCore.target.business_category)), { store })
        : [];
      const quarantineCandidates = batch.quarantine ?? batch.review;
      const reviewResults = quarantineCandidates.length
        ? await candidateStore.saveLearningCandidates({
          tenantId: context.tenant_id,
          projectId: context.project_id,
          taskKey: batch.task_key,
          candidates: quarantineCandidates,
          expireAfterDays: options.quarantineExpireAfterDays
        })
        : [];
      results.push({
        turn_hash: batch.turn_hash,
        status: "completed",
        active: activeResults.map((item) => ({
          memory_id: item.memory_id,
          created: item.created,
          deduplicated: item.deduplicated ?? false
        })),
        review: reviewResults,
        quarantine: reviewResults
      });
    } catch (error) {
      results.push({ turn_hash: batch.turn_hash, status: "failed", error: sanitizedError(error) });
      break;
    }
  }
  return results;
}

async function applyCloud(planCore, context, options) {
  const mcp = resolveMcpConfig(options.env ?? process.env);
  const hasQuarantine = planCore.batches.some((batch) => (batch.quarantine ?? batch.review ?? []).length > 0);
  const hasActive = planCore.batches.some((batch) => batch.active.length > 0);
  if (hasQuarantine && !mcp.complete) throw new Error("cloud_review_import_requires_complete_mcp_configuration:quarantine");
  const apiBase = mcp.complete ? null : resolveApiBase(options.env ?? process.env);
  const apiKey = options.env?.ORGBRAIN_API_KEY ?? process.env.ORGBRAIN_API_KEY;
  if (hasActive && !mcp.complete && (!apiBase || !apiKey)) throw new Error("cloud_active_import_requires_mcp_or_rest_credentials");
  const results = [];
  for (const batch of planCore.batches) {
    try {
      const activeResult = batch.active.length
        ? mcp.complete
          ? await postMemoryViaMcp(mcp, context.tenant_id, "codex", batch.active)
          : await postMemoryViaRest(apiBase, apiKey, context.tenant_id, "codex", batch.active)
        : null;
        const quarantineCandidates = batch.quarantine ?? batch.review;
        const reviewResult = quarantineCandidates.length
        ? await postLearningBatchViaMcp(mcp, context.tenant_id, "codex", {
          projectId: context.project_id,
          taskKey: batch.task_key,
          records: [],
          quarantineCandidates
        })
        : null;
      results.push({
        turn_hash: batch.turn_hash,
        status: "completed",
        active: activeResult,
        review: reviewResult,
        quarantine: reviewResult
      });
    } catch (error) {
      results.push({ turn_hash: batch.turn_hash, status: "failed", error: sanitizedError(error) });
      break;
    }
  }
  return results;
}

export async function applyCodexSessionImportPlan(report, options = {}) {
  const planCore = report?.plan ?? report;
  if (!planCore || planCore.schema_version !== 2) throw new Error("invalid_codex_import_plan");
  const actualHash = hash(stableJson(planCore));
  if (!options.expectedPlanHash) throw new Error("expected_plan_hash_required_for_execute");
  if (actualHash !== options.expectedPlanHash) throw new Error("plan_hash_mismatch");
  if (options.requireAutonomousConsensus === true) requireAutonomousActiveEvidence(planCore, options.autonomyPolicy ?? DEFAULT_AUTONOMY_POLICY);
  const context = await validateTarget(planCore, options);
  const results = context.mode.cloudWritesAllowed
    ? await applyCloud(planCore, context, options)
    : await applyLocal(planCore, context, options);
  return {
    ok: results.every((item) => item.status === "completed"),
    plan_hash: actualHash,
    import_batch_id: planCore.import_batch_id,
    results
  };
}

export async function createCodexSessionImportReport(options = {}) {
  const built = await buildCodexSessionImportPlan(options);
  return {
    schema_version: 2,
    generated_at: Date.now(),
    mode: "dry-run",
    plan_hash: built.planHash,
    summary: built.summary,
    plan: built.planCore,
    results: []
  };
}

/**
 * Convert active-looking session records to durable quarantine when the
 * session-specific council is unavailable or disagrees. The derived plan
 * receives a new hash, so it cannot be applied under the original active
 * plan's hash by accident.
 */
export function quarantineCodexSessionImportReport(report, options = {}) {
  const source = report?.plan ?? report;
  if (!source || source.schema_version !== 2 || !Array.isArray(source.batches)) {
    throw new Error("invalid_codex_import_plan");
  }
  const reasonCodes = [...new Set((options.reasonCodes ?? ["ai_consensus_required"]).map(String))].slice(0, 16);
  const batches = source.batches.map((batch) => {
    const active = Array.isArray(batch.active) ? batch.active : [];
    const existing = Array.isArray(batch.quarantine) ? batch.quarantine : [];
    const converted = active.map((item) => rewriteReviewCandidate({
      ...item,
      capture_intent: "quarantine",
      route: "quarantine",
      verification_state: "unverified",
      deterministic_verification: item.verification && typeof item.verification === "object"
        ? { ...item.verification }
        : { state: item.verification_state === "verified" ? "verified" : "unverified" },
      verification: { state: "unverified", verified_at: null },
      autonomy: {
        ...(item.autonomy && typeof item.autonomy === "object" ? item.autonomy : {}),
        route: "quarantine",
        reason_codes: reasonCodes
      }
    }, item.external_key, batch.occurred_at, reasonCodes));
    const quarantine = [...existing, ...converted];
    const next = { ...batch, active: [], quarantine };
    Object.defineProperty(next, "review", { value: quarantine, enumerable: false, writable: false });
    return next;
  });
  const plan = { ...source, batches };
  const planHash = hash(stableJson(plan));
  return {
    schema_version: 2,
    generated_at: report?.generated_at ?? Date.now(),
    mode: "quarantine",
    plan_hash: planHash,
    summary: summarize(plan),
    plan,
    results: []
  };
}

export async function executeCodexSessionImportPlanFile(options = {}) {
  const planPath = path.resolve(options.planPath);
  const report = JSON.parse(await readFile(planPath, "utf8"));
  // A dry-run plan is a content-addressed input to execution.  Keep it
  // immutable so the expected hash, rollback audit, and a later retry all
  // refer to the exact same candidate set.  The apply result is written to a
  // sibling report (or the explicitly supplied path) instead.
  const reportPath = path.resolve(options.reportPath ?? `${planPath}.apply-report.json`);
  const writeApplyReport = async (mode, applied = null, error = null) => {
    const planCore = report?.plan ?? report;
    const summary = report?.summary ?? (planCore?.batches ? summarize(planCore) : {});
    const results = applied?.results ?? (error ? [{ status: "failed", error: sanitizedError(error) }] : []);
    const activeCreated = results.flatMap((item) => item?.active ?? []).filter((item) => item?.created === true).length;
    const activeDeduplicated = results.flatMap((item) => item?.active ?? []).filter((item) => item?.deduplicated === true).length;
    const quarantineStored = results.flatMap((item) => item?.quarantine ?? item?.review ?? []).filter(Boolean).length;
    const failed = results.filter((item) => item?.status === "failed").length;
    return writePrivateJson(reportPath, {
      schema_version: 1,
      source: "codex-session-import",
      mode,
      plan_hash: report?.plan_hash ?? hash(stableJson(planCore)),
      import_batch_id: planCore?.import_batch_id ?? null,
      target_fingerprint: planCore?.target?.target_fingerprint ?? null,
      generated_at: report?.generated_at ?? null,
      applied_at: Date.now(),
      summary,
      result_counts: {
        active_created: activeCreated,
        active_deduplicated: activeDeduplicated,
        quarantine_stored: quarantineStored,
        failed
      },
      results,
      privacy: {
        raw_transcript_persisted: false,
        reasoning_persisted: false,
        absolute_source_paths_persisted: false,
        command_output_persisted: false
      }
    });
  };
  let applied;
  try {
    applied = await applyCodexSessionImportPlan(report, options);
  } catch (error) {
    await writeApplyReport("apply-failed", null, error);
    throw error;
  }
  const appliedReportPath = await writeApplyReport(applied.ok ? "applied" : "apply-partial", applied);
  if (!applied.ok) throw new Error("codex_session_import_partially_failed");
  return { ...applied, output: appliedReportPath, plan: planPath };
}

export function importOptionsFromCli(args) {
  const options = {
    workspaceRoot: args.get("--workspace", process.cwd()),
    sessionsRoot: args.get("--sessions-root", DEFAULT_SESSIONS_ROOT),
    since: finiteTimestamp(args.get("--since"), "since") ?? Number.NEGATIVE_INFINITY,
    until: finiteTimestamp(args.get("--until"), "until") ?? Number.POSITIVE_INFINITY,
    outputPath: args.get("--output"),
    reportPath: args.get("--apply-report", args.get("--report")),
    planPath: args.get("--plan"),
    expectedPlanHash: args.get("--expected-plan-hash"),
    execute: args.flags.has("--execute")
  };
  if (options.since > options.until) throw new Error("since_must_not_be_after_until");
  return options;
}

export async function runCodexSessionImportCommand({ store, args, rest = [] }) {
  if (rest[0] !== "codex-sessions") throw new Error("memory import requires codex-sessions");
  const options = importOptionsFromCli(args);
  if (options.execute) {
    if (!options.planPath) throw new Error("plan_required_for_execute");
    return executeCodexSessionImportPlanFile({ ...options, store });
  }
  if (options.planPath) throw new Error("--plan requires --execute");
  const report = await createCodexSessionImportReport(options);
  const output = options.outputPath ?? defaultOutputPath(report.plan.target.project_id);
  await writePrivateJson(output, report);
  return {
    ok: true,
    mode: "dry-run",
    plan_hash: report.plan_hash,
    summary: report.summary,
    output: path.resolve(output)
  };
}

export const codexSessionImportInternals = {
  hash,
  stableJson,
  sameWorkspace,
  workspaceIdentity,
  routeTurn,
  writePrivateJson,
  hasAutonomousConsensus,
  requireAutonomousActiveEvidence,
  attachAutonomousConsensus
};
