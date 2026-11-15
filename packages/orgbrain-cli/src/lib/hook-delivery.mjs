import crypto from "node:crypto";
import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { modernMcpHeaders, modernMcpRequest } from "./mcp-modern-request.mjs";
import { resolveHomePath, withWorkspaceConfigLock } from "./workspace-config.mjs";
import { captureItemPayload, sha256 } from "./hook-candidates.mjs";
import { MEMORY_CONTRACT_V2_PROMPT_ID, MEMORY_CONTRACT_V2_VERIFIER_VERSION } from "../../../shared/src/memory-contract-v2-runtime.mjs";
import { MEMORY_CONTRACT_V2_CONTRACT_HASH, MEMORY_CONTRACT_V2_PROMPT_HASH } from "../../../shared/src/memory-contract-v2-contract.mjs";
const MCP_CAPTURE_TOOL = "orgbrain_memories_capture_rationale";
const MCP_LEARNING_BATCH_TOOL = "orgbrain_learning_batch_ingest";
const MCP_EXTRACTION_ENQUEUE_TOOL = "orgbrain_memory_extraction_enqueue";
const CAPTURE_TIMEOUT_MS = 5_000;
const OUTBOX_CLAIM_STALE_MS = 5 * 60 * 1000;
const validatedMcpConfigurations = new WeakSet();
function safeJsonParse(raw) { try { return JSON.parse(raw); } catch { return null; } }

function buildApiUrl(baseUrl, route) {
  const base = new URL(baseUrl);
  const normalizedRoute = route.replace(/^\/+/, "");
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return new URL(normalizedRoute, `${base.origin}${basePath}`);
}

export function resolveMcpConfig(env = process.env) {
  const url = typeof env.ORGBRAIN_MCP_URL === "string" ? env.ORGBRAIN_MCP_URL.trim() : "";
  const clientId = typeof env.ORGBRAIN_MCP_CLIENT_ID === "string"
    ? env.ORGBRAIN_MCP_CLIENT_ID.trim()
    : "";
  const clientSecret = typeof env.ORGBRAIN_MCP_CLIENT_SECRET === "string"
    ? env.ORGBRAIN_MCP_CLIENT_SECRET.trim()
    : "";
  const installationId = typeof env.ORGBRAIN_CLIENT_INSTALLATION_ID === "string"
    ? env.ORGBRAIN_CLIENT_INSTALLATION_ID.trim()
    : "";
  const configured = Boolean(url || clientId || clientSecret || installationId);
  const missing = configured
    ? [
        !url ? "ORGBRAIN_MCP_URL" : "",
        !clientId ? "ORGBRAIN_MCP_CLIENT_ID" : "",
        !clientSecret ? "ORGBRAIN_MCP_CLIENT_SECRET" : "",
        !installationId ? "ORGBRAIN_CLIENT_INSTALLATION_ID" : ""
      ].filter(Boolean)
    : [];
  return {
    configured,
    complete: configured && missing.length === 0,
    url,
    clientId,
    clientSecret,
    missing,
    installationId,
    outboxFile: resolveHomePath(
      typeof env.ORGBRAIN_HOOK_OUTBOX === "string" && env.ORGBRAIN_HOOK_OUTBOX.trim()
        ? env.ORGBRAIN_HOOK_OUTBOX.trim()
        : "~/.config/org-brain/hook-capture-outbox.jsonl"
    )
  };
}

async function writePrivateOutbox(file, rows) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(staged, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(staged, 0o600);
  await rename(staged, file);
  await chmod(file, 0o600);
}

export async function enqueueHookCapture(config, tenantId, sourceName, record, errorCode = "delivery_failed") {
  const file = config.outboxFile;
  const identityResolved = Boolean(config.installationId) && errorCode !== "identity_unresolved";
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withWorkspaceConfigLock(file, async () => {
    await appendFile(file, `${JSON.stringify({
      schema_version: 1,
      queued_at: Date.now(),
      tenant_id: tenantId,
      source: sourceName,
      installation_id: config.installationId || null,
      identity_state: identityResolved ? "resolved" : "identity_unresolved",
      error_code: errorCode,
      record
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
  });
}

function parseOutboxRows(raw) {
  return raw.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const parsed = safeJsonParse(line);
    return parsed && typeof parsed === "object" ? [parsed] : [];
  });
}

async function readOutboxRows(file) {
  const raw = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return parseOutboxRows(raw);
}

export async function claimHookCaptureRows(config, limit, options = {}) {
  const file = config.outboxFile;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return withWorkspaceConfigLock(file, async () => {
    const now = Date.now();
    const prefix = `${path.basename(file)}.claim-`;
    const entries = await readdir(path.dirname(file), { withFileTypes: true }).catch(() => []);
    const staleClaims = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".jsonl")) continue;
      const claimFile = path.join(path.dirname(file), entry.name);
      const claimStat = await stat(claimFile).catch(() => null);
      if (claimStat && now - claimStat.mtimeMs >= OUTBOX_CLAIM_STALE_MS) staleClaims.push(claimFile);
    }
    const recovered = [];
    for (const claimFile of staleClaims) recovered.push(...await readOutboxRows(claimFile));
    const rows = [...recovered, ...await readOutboxRows(file)];
    if (rows.length === 0) return { rows: [], claimFile: null };
    const count = Math.max(1, Math.min(100, limit));
    const attempted = rows.slice(0, count);
    const claimFile = `${file}.claim-${now}-${process.pid}-${crypto.randomUUID()}.jsonl`;
    // Persist the claim before removing anything from the primary outbox. A crash
    // in the following rewrite can cause an idempotent retry, but cannot lose a row.
    await writePrivateOutbox(claimFile, attempted);
    await options.onClaimPersisted?.({ claimFile, rows: attempted });
    await writePrivateOutbox(file, rows.slice(count));
    await Promise.all(staleClaims.map((stale) => unlink(stale).catch(() => undefined)));
    return { rows: attempted, claimFile };
  });
}

async function releaseHookCaptureClaim(config, claimFile, unsent) {
  if (!claimFile) return;
  await withWorkspaceConfigLock(config.outboxFile, async () => {
    if (unsent.length > 0) {
      const current = await readOutboxRows(config.outboxFile);
      await writePrivateOutbox(config.outboxFile, [...unsent, ...current]);
    }
    await unlink(claimFile).catch(() => undefined);
  });
}

export async function validateMcpInstallation(config) {
  if (!config.installationId) return false;
  const target = new URL(config.url);
  target.pathname = `${target.pathname.replace(/\/+$/u, "")}/client-installations/status`;
  const response = await fetch(target, {
    method: "GET",
    headers: {
      accept: "application/json",
      "CF-Access-Client-Id": config.clientId,
      "CF-Access-Client-Secret": config.clientSecret
    }
  });
  const body = await response.json().catch(() => null);
  const valid = Boolean(response.ok && body?.ok && body.data?.id === config.installationId);
  if (valid) validatedMcpConfigurations.add(config);
  else validatedMcpConfigurations.delete(config);
  return valid;
}

async function ensureMcpInstallationIdentity(config) {
  if (validatedMcpConfigurations.has(config)) return;
  if (!await validateMcpInstallation(config)) {
    throw new Error("org-brain MCP hook identity validation failed (403): installation mismatch or revocation");
  }
}

export async function flushHookCaptureOutbox(config, limit = 100) {
  const claimed = await claimHookCaptureRows(config, limit);
  const attempted = claimed.rows;
  if (attempted.length === 0) return { attempted: 0, sent: 0, pending: 0 };
  const remaining = [];
  let sent = 0;
  let identityValidated;
  for (let index = 0; index < attempted.length; index += 1) {
    let item = attempted[index];
    if (
      item.identity_state === "identity_unresolved" &&
      item.installation_id &&
      config.installationId &&
      item.installation_id === config.installationId
    ) {
      identityValidated ??= await validateMcpInstallation(config).catch(() => false);
      if (identityValidated) {
        item = { ...item, identity_state: "resolved", error_code: "identity_revalidated" };
      }
    }
    if (
      item.identity_state !== "resolved" ||
      !item.installation_id ||
      !config.installationId ||
      item.installation_id !== config.installationId
    ) {
      remaining.push(item);
      continue;
    }
    try {
      await postMemoryViaMcp(config, item.tenant_id, item.source, item.record);
      sent += 1;
    } catch (error) {
      const errorCode = hookDeliveryErrorCode(error);
      if (errorCode === "identity_unresolved") {
        remaining.push({
          ...item,
          identity_state: "identity_unresolved",
          error_code: errorCode
        });
        remaining.push(...attempted.slice(index + 1));
      } else {
        remaining.push(...attempted.slice(index));
      }
      break;
    }
  }
  await releaseHookCaptureClaim(config, claimed.claimFile, remaining);
  return {
    attempted: attempted.length,
    sent,
    pending: (await readOutboxRows(config.outboxFile)).length
  };
}

export function buildMcpCaptureRequest(tenantId, sourceName, recordOrRecords) {
  const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
  const argumentsPayload = Array.isArray(recordOrRecords)
    ? { items: records.map(captureItemPayload) }
    : { item: captureItemPayload(records[0]) };
  return modernMcpRequest({
    id: `hook:${records[0]?.externalKey ?? sha256(JSON.stringify(argumentsPayload)).slice(0, 24)}`,
    method: "tools/call",
    name: MCP_CAPTURE_TOOL,
    clientName: "orgbrain-hook-memory-bridge",
    params: {
      arguments: {
        tenant_id: tenantId,
        source: sourceName,
        ...argumentsPayload
      }
    }
  });
}

export function buildMcpLearningBatchRequest(tenantId, sourceName, input = {}) {
  const verifiedItems = Array.isArray(input.aiCertifiedRecords)
    ? input.aiCertifiedRecords.map(captureItemPayload)
    : [];
  const deterministicItems = Array.isArray(input.deterministicallyVerifiedItems)
    ? input.deterministicallyVerifiedItems.map(captureItemPayload)
    : Array.isArray(input.records)
      ? input.records.map(captureItemPayload)
      : [];
  const reviewCandidates = Array.isArray(input.reviewCandidates)
    ? input.reviewCandidates.slice(0, 3).map((candidate) => ({
      ...candidate,
      prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
      prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
      contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
      verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION
      }))
    : [];
  const quarantineCandidates = Array.isArray(input.quarantineCandidates)
    ? input.quarantineCandidates.slice(0, 3).map((candidate) => ({
      ...candidate,
      prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
      prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
      contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
      verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION
    }))
    : [];
  const semanticAliases = Array.isArray(input.semanticAliases) ? input.semanticAliases.slice(0, 16) : [];
  return modernMcpRequest({
    id: `learning:${sha256(JSON.stringify({ tenantId, sourceName, verifiedItems, reviewCandidates, semanticAliases })).slice(0, 40)}`,
    method: "tools/call",
    name: MCP_LEARNING_BATCH_TOOL,
    clientName: "orgbrain-hook-memory-bridge",
    params: {
      arguments: {
        tenant_id: tenantId,
        source: sourceName,
        project_id: input.projectId ?? null,
        task_key: input.taskKey ?? null,
        commitments: Array.isArray(input.commitments) ? input.commitments.slice(0, 16) : [],
        prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
        prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
        contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
        verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
        verified_items: verifiedItems,
        deterministically_verified_items: deterministicItems,
        review_candidates: reviewCandidates,
        quarantine_candidates: quarantineCandidates,
        semantic_aliases: semanticAliases
      }
    }
  });
}

export function buildMcpMemoryExtractionRequest(tenantId, extractionRequest, projectId) {
  return modernMcpRequest({
    id: `memory-extraction:${extractionRequest.packet_hash.slice(-40)}`,
    method: "tools/call",
    name: MCP_EXTRACTION_ENQUEUE_TOOL,
    clientName: "orgbrain-hook-memory-bridge",
    params: {
      arguments: {
        tenant_id: tenantId,
        project_id: projectId,
        provider: extractionRequest.provider,
        model: extractionRequest.model,
        session_hash: extractionRequest.packet.session_hash,
        turn_hash: extractionRequest.packet.turn_hash,
        packet: extractionRequest.packet,
        packet_hash: extractionRequest.packet_hash,
        tier: "tier2",
        retention_class: extractionRequest.packet.snippets?.some?.((item) => item.text?.includes?.("[REDACTED_"))
          ? "restricted"
          : "standard"
      }
    }
  });
}

export function hookCaptureLogFields(captureV2Mode, records, report, memoryIds = []) {
  if (captureV2Mode !== "off") {
    return {
      candidate_count: records.length,
      candidate_hashes: report?.candidate_hashes ?? []
    };
  }
  return {
    external_keys: records.map((record) => record.externalKey),
    ...(memoryIds.length ? { memory_ids: memoryIds } : {})
  };
}

async function postMcpToolCall(config, tenantId, { label, tool, buildRequest }) {
  await ensureMcpInstallationIdentity(config);
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      ...modernMcpHeaders("tools/call", tool),
      "CF-Access-Client-Id": config.clientId,
      "CF-Access-Client-Secret": config.clientSecret,
      "x-orgbrain-tenant": tenantId
    },
    body: JSON.stringify(buildRequest()),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error || body.result?.isError) {
    if (response.status === 401 || response.status === 403) validatedMcpConfigurations.delete(config);
    const detail = body?.error?.message || body?.result?.content?.[0]?.text || "unexpected MCP response";
    throw new Error(`org-brain MCP ${label} failed (${response.status}): ${detail}`);
  }
  const text = body.result?.content?.find?.((entry) => entry?.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`org-brain MCP ${label} returned no text result`);
  return text;
}

export async function postMemoryViaMcp(config, tenantId, sourceName, recordOrRecords) {
  const text = await postMcpToolCall(config, tenantId, {
    label: "hook capture",
    tool: MCP_CAPTURE_TOOL,
    buildRequest: () => buildMcpCaptureRequest(tenantId, sourceName, recordOrRecords)
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("org-brain MCP hook capture returned invalid JSON");
  }
}

export async function postLearningBatchViaMcp(config, tenantId, sourceName, input) {
  const text = await postMcpToolCall(config, tenantId, {
    label: "learning batch",
    tool: MCP_LEARNING_BATCH_TOOL,
    buildRequest: () => buildMcpLearningBatchRequest(tenantId, sourceName, input)
  });
  return JSON.parse(text);
}

export async function postMemoryExtractionViaMcp(config, tenantId, extractionRequest, projectId) {
  const text = await postMcpToolCall(config, tenantId, {
    label: "memory extraction enqueue",
    tool: MCP_EXTRACTION_ENQUEUE_TOOL,
    buildRequest: () => buildMcpMemoryExtractionRequest(tenantId, extractionRequest, projectId)
  });
  return JSON.parse(text);
}

export function hookDeliveryErrorCode(error) {
  return error instanceof Error && /\(40[13]\)/u.test(error.message)
    ? "identity_unresolved"
    : "delivery_failed";
}

export async function postMemoryViaRest(apiBase, apiKey, tenantId, sourceName, recordOrRecords) {
  const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
  const itemPayload = Array.isArray(recordOrRecords)
    ? { items: records.map(captureItemPayload) }
    : { item: captureItemPayload(records[0]) };
  const res = await fetch(buildApiUrl(apiBase, "/v1/memories/capture-rationale"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      source: sourceName,
      actor_type: records[0]?.actorType ?? "system",
      actor_id: records[0]?.actorId ?? sourceName,
      ...itemPayload
    }),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS)
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`org-brain hook capture-rationale failed (${res.status})`);
  }
  return body.data;
}

export async function postMemory(apiBase, apiKey, tenantId, sourceName, recordOrRecords) {
  return postMemoryViaRest(apiBase, apiKey, tenantId, sourceName, recordOrRecords);
}

