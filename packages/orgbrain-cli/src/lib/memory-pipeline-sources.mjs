import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { verifiedCandidates } from "../../../shared/src/memory-extraction-verifier-runtime.mjs";
import { wikiStatus } from "./wiki-service.mjs";

const SESSION_POLICY = "session-extraction/v1";
const SESSION_JOB_ID = /^[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SESSION_SUPPORT = 16;
const MAX_WIKI_PAGE_CHARS = 16_000;
const MAX_WIKI_PAGE_BYTES = 64_000;
const MAX_WIKI_SOURCE_REFS = 8;
const MAX_WIKI_SOURCE_CHARS = 16_000;
const MAX_WIKI_SOURCE_BYTES = 64_000;
const MAX_WIKI_SOURCE_TOTAL_BYTES = 512_000;
const SOURCE_SELECTOR = /source:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})@(\d+)(?:#L(\d+)-L(\d+))?/giu;
const SESSION_MODEL_KIND = Object.freeze({ success: "org_knowledge", decision: "decision", failure: "pitfall" });
const SESSION_CLAIM_FIELDS = Object.freeze({
  success: ["procedure", "why_it_worked", "observed_outcome", "reuse_when"],
  decision: ["question", "selected_value", "decision", "constraints", "rationale", "alternatives", "reuse_when"],
  failure: ["symptom", "failed_approach", "root_cause", "correction", "verified_outcome", "avoidance_rule"],
});

function fail(code) {
  throw new Error(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableHash(value) {
  return sha256(stableJson(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function cloneJson(value, code) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") fail(code);
    return JSON.parse(serialized);
  } catch {
    fail(code);
  }
}

function canonicalEvidenceText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function claimValues(value, selectedText) {
  if (typeof value !== "string" || !value.trim()) return [];
  const normalized = canonicalEvidenceText(value);
  if (!normalized) return [];
  if (selectedText.includes(normalized)) return [value];
  if (!value.includes("\n")) return [value];
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => selectedText.includes(canonicalEvidenceText(line)))) return lines;
  return [value];
}

function valuesForField(name, observation, selectedText) {
  const value = observation[name];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return claimValues(item, selectedText);
      if (name === "alternatives" && item && typeof item === "object") {
        return [
          ...claimValues(item.alternative, selectedText),
          ...claimValues(item.reason_rejected, selectedText),
        ];
      }
      return [];
    });
  }
  if (name === "alternatives" && value && typeof value === "object") {
    return [...claimValues(value.alternative, selectedText), ...claimValues(value.reason_rejected, selectedText)];
  }
  return claimValues(value, selectedText);
}

function buildSessionVerifierCandidate(payload, selectedText) {
  const observation = payload.observation;
  const lessonType = observation.lesson_type;
  if (!Object.hasOwn(SESSION_CLAIM_FIELDS, lessonType)) fail("session_candidate_unverified");

  const fields = [];
  for (const name of ["trigger", ...SESSION_CLAIM_FIELDS[lessonType]]) {
    const values = valuesForField(name, observation, selectedText);
    if (values.length) fields.push({ name, values });
  }
  if (Array.isArray(observation.applicability?.target_files)) {
    const values = observation.applicability.target_files.flatMap((value) => claimValues(value, selectedText));
    if (values.length) fields.push({ name: "target_files", values });
  }
  if (observation.reported_verification !== undefined) {
    if (observation.reported_verification?.state !== "unverified") fail("session_candidate_unverified");
    const values = claimValues(observation.reported_verification?.text, selectedText);
    if (!values.length) fail("session_candidate_unverified");
    fields.push({ name: "reported_verification", values });
  }

  fields.push(
    { name: "persistence", values: [payload.persistence] },
    { name: "memory_kind", values: [payload.memory_kind] },
    { name: "action", values: [payload.action] },
  );
  if (payload.target_memory_id !== null && payload.target_memory_id !== undefined) {
    fields.push({ name: "target_memory_id", values: [payload.target_memory_id] });
  }
  if (lessonType === "decision" && observation.decision_type) {
    fields.push({ name: "decision_type", values: [observation.decision_type] });
  }

  return {
    lesson_type: lessonType,
    support_span_ids: [...payload.support_span_ids],
    fields,
    gaps: [...payload.gaps],
  };
}

function groundingProjection(observation) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) fail("session_candidate_unverified");
  const projected = { ...observation };
  // Non-v3 session extraction derives this key from the job id and candidate index.
  // The index is not persisted, so validate its format and exclude only this key from re-derivation.
  if (observation.lesson_type === "decision") {
    if (typeof observation.decision_key !== "string" || !/^inferred\.[a-f0-9]{24}$/u.test(observation.decision_key)) {
      fail("session_candidate_unverified");
    }
    delete projected.decision_key;
  }
  return stableJson(projected);
}

function openReadOnlyQueue(queueDir) {
  const root = resolve(queueDir ?? process.env.ORGBRAIN_SESSION_EXTRACTION_QUEUE ?? join(homedir(), ".org-brain/session-extraction"));
  const file = join(root, "queue.sqlite");
  try {
    if (!existsSync(file)) fail("session_queue_unavailable");
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) fail("session_queue_unavailable");
    return new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    if (error?.message === "session_queue_unavailable") throw error;
    fail("session_queue_unavailable");
  }
}

function readCandidate(db, { tenantId, projectId, candidateId }) {
  if (!db || typeof db.prepare !== "function") fail("session_source_invalid");
  if (![tenantId, projectId, candidateId].every((value) => typeof value === "string" && value.trim())) fail("session_source_invalid");
  let row;
  try {
    row = db.prepare(`SELECT id,tenant_id,project_id,task_key,external_key,payload_json,status,reason_codes_json
      FROM memory_learning_candidates WHERE tenant_id=? AND project_id=? AND id=?`).get(tenantId, projectId, candidateId);
  } catch {
    fail("session_candidate_unavailable");
  }
  if (!row) fail("session_candidate_not_found");
  if (row.tenant_id !== tenantId || row.project_id !== projectId) fail("session_candidate_scope_mismatch");
  if (row.status !== "quarantine") fail("session_candidate_not_quarantined");
  const task = /^session-extraction:([a-f0-9]{64})$/u.exec(String(row.task_key ?? ""));
  if (!task) fail("session_task_key_invalid");
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    fail("session_candidate_invalid");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("session_candidate_invalid");
  if (payload.automatic_promotion !== false) fail("session_promotion_opt_out_required");
  if (payload.external_key !== row.external_key) fail("session_candidate_unverified");
  if (!Array.isArray(payload.reason_codes) || !payload.reason_codes.includes("llm_proposed_review_only")) fail("session_candidate_unverified");
  if (row.reason_codes_json) {
    try {
      const storedReasons = JSON.parse(row.reason_codes_json);
      if (!Array.isArray(storedReasons) || stableJson(storedReasons) !== stableJson(payload.reason_codes)) fail("session_candidate_unverified");
    } catch (error) {
      if (error?.message === "session_candidate_unverified") throw error;
      fail("session_candidate_unverified");
    }
  }
  return { row, payload, jobId: task[1] };
}

function validateSessionPayload(payload, packet, job, jobId, projectId) {
  if (payload.automatic_promotion !== false || payload.action !== "create" || payload.target_memory_id !== null) fail("session_promotion_opt_out_required");
  if (payload.persistence !== "durable" || payload.memory_kind !== SESSION_MODEL_KIND[payload.observation?.lesson_type]) fail("session_candidate_unverified");
  if (payload.source_client !== job.client || !["codex", "codex-stop", "claude", "cursor"].includes(job.client)) fail("session_candidate_unverified");
  if (payload.observation?.capture_intent !== "review" || payload.observation?.schema_version !== 2) fail("session_candidate_unverified");
  if (payload.observation?.lesson_type === "decision" && (payload.observation.applicability?.components?.length !== 1 || payload.observation.applicability.components[0] !== projectId)) fail("session_candidate_unverified");
  if (!Array.isArray(payload.support_span_ids) || payload.support_span_ids.length === 0 || payload.support_span_ids.length > MAX_SESSION_SUPPORT
      || payload.support_span_ids.some((id) => typeof id !== "string")
      || new Set(payload.support_span_ids).size !== payload.support_span_ids.length) fail("session_support_invalid");
  if (!Array.isArray(packet.snippets)) fail("session_packet_mismatch");
  const byId = new Map();
  for (const snippet of packet.snippets) {
    if (!snippet || typeof snippet.span_id !== "string" || byId.has(snippet.span_id)) fail("session_packet_mismatch");
    byId.set(snippet.span_id, snippet);
  }
  const selected = payload.support_span_ids.map((id) => byId.get(id));
  if (selected.some((snippet) => !snippet || typeof snippet.text !== "string" || typeof snippet.role !== "string" || typeof snippet.source !== "string")) {
    fail("session_support_unresolved");
  }
  const support = new Set(payload.support_span_ids);
  const selectedSnippets = packet.snippets.filter((snippet) => support.has(snippet.span_id));
  if (selectedSnippets.length !== payload.support_span_ids.length) fail("session_support_unresolved");
  const selectedText = selectedSnippets.map((snippet) => canonicalEvidenceText(snippet.text)).join("\n");
  const candidate = buildSessionVerifierCandidate(payload, selectedText);
  const verificationPacket = {
    ...packet,
    snippets: selectedSnippets,
    events: Array.isArray(packet.events) ? packet.events : [],
  };
  return verifiedCandidates({ packet: verificationPacket, project_id: projectId, run_id: jobId }, [candidate])
    .then((verified) => {
      if (verified.candidates.length !== 1 || verified.rejections.length) fail("session_candidate_unverified");
      if (groundingProjection(verified.candidates[0].observation) !== groundingProjection(payload.observation)) fail("session_candidate_unverified");
      const eventHash = stableHash(payload.observation);
      if (payload.external_key !== `memory-extraction:${jobId}:${eventHash}`) fail("session_candidate_unverified");
      return selectedSnippets.map((snippet) => ({
        span_id: snippet.span_id,
        role: snippet.role,
        source: snippet.source,
        text: snippet.text,
        ...(typeof snippet.text_hash === "string" ? { text_hash: snippet.text_hash } : {}),
      }));
    });
}

export async function loadSessionPipelineSource({ db, queueDir, tenantId = "default", projectId, candidateId } = {}) {
  const { row, payload, jobId } = readCandidate(db, { tenantId, projectId, candidateId });
  const queue = openReadOnlyQueue(queueDir);
  let job;
  try {
    job = queue.prepare(`SELECT id,tenant_id,project_id,client,packet_json,packet_hash,status,policy_hash
      FROM jobs WHERE id=? AND tenant_id=? AND project_id=?`).get(jobId, tenantId, projectId);
  } catch {
    queue.close();
    fail("session_job_unavailable");
  }
  queue.close();
  if (!job || job.id !== jobId) fail("session_job_not_found");
  if (job.status !== "completed") fail("session_job_not_completed");
  if (job.tenant_id !== tenantId || job.project_id !== projectId) fail("session_candidate_scope_mismatch");
  if (typeof job.packet_hash !== "string" || !SESSION_JOB_ID.test(job.packet_hash)) fail("session_packet_mismatch");

  let packet;
  try {
    packet = JSON.parse(job.packet_json);
  } catch {
    fail("session_packet_mismatch");
  }
  if (!packet || typeof packet !== "object" || Array.isArray(packet)
      || sha256(JSON.stringify(packet)) !== job.packet_hash
      || packet.policy !== SESSION_POLICY
      || packet.tenant_id !== tenantId
      || packet.project_id !== projectId) fail("session_packet_mismatch");

  const snippets = await validateSessionPayload(payload, packet, job, jobId, projectId);
  const candidateHash = stableHash({ candidate_id: row.id, task_key: row.task_key, payload });
  const base = {
    source_type: "session_extraction",
    source_key: `${jobId}:${job.packet_hash}:${candidateHash}`,
    candidate_id: row.id,
    candidate_hash: candidateHash,
    job_id: jobId,
    packet_hash: job.packet_hash,
    policy_hash: job.policy_hash ?? null,
    tenant_id: tenantId,
    project_id: projectId,
    status: row.status,
    automatic_promotion: false,
    provenance: "retained_packet",
    authorship: "unverified",
    observation: cloneJson(payload.observation, "session_candidate_invalid"),
    support_span_ids: [...payload.support_span_ids],
    snippets,
  };
  return deepFreeze({ ...base, source_hash: stableHash(base) });
}

export async function loadSessionPipelinePacket({ queueDir, tenantId = "default", projectId, jobId } = {}) {
  if (![tenantId, projectId, jobId].every((value) => typeof value === "string" && value.trim())
      || !SESSION_JOB_ID.test(jobId)) fail("session_source_invalid");

  const queue = openReadOnlyQueue(queueDir);
  let job;
  try {
    job = queue.prepare(`SELECT id,tenant_id,project_id,packet_json,packet_hash,status,policy_hash
      FROM jobs WHERE id=? AND tenant_id=? AND project_id=?`).get(jobId, tenantId, projectId);
  } catch {
    queue.close();
    fail("session_job_unavailable");
  }
  queue.close();
  if (!job || job.id !== jobId) fail("session_job_not_found");
  if (job.status !== "completed") fail("session_job_not_completed");
  if (job.tenant_id !== tenantId || job.project_id !== projectId) fail("session_candidate_scope_mismatch");
  if (typeof job.packet_hash !== "string" || !SHA256.test(job.packet_hash)) fail("session_packet_mismatch");

  let packet;
  try {
    packet = JSON.parse(job.packet_json);
  } catch {
    fail("session_packet_mismatch");
  }
  if (!packet || typeof packet !== "object" || Array.isArray(packet)
      || sha256(JSON.stringify(packet)) !== job.packet_hash
      || packet.policy !== SESSION_POLICY
      || packet.tenant_id !== tenantId
      || packet.project_id !== projectId
      || !Array.isArray(packet.snippets)
      || !Array.isArray(packet.events)) fail("session_packet_mismatch");

  const spanIds = new Set();
  for (const snippet of packet.snippets) {
    if (!snippet || typeof snippet !== "object" || Array.isArray(snippet)
        || typeof snippet.span_id !== "string" || !snippet.span_id.trim() || spanIds.has(snippet.span_id)
        || typeof snippet.text !== "string" || !snippet.text.trim()
        || snippet.text_hash !== undefined && snippet.text_hash !== null
          && (typeof snippet.text_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(snippet.text_hash)
            || snippet.text_hash !== `sha256:${sha256(snippet.text)}`)) fail("session_snippet_mismatch");
    spanIds.add(snippet.span_id);
  }

  const base = {
    source_type: "session_extraction",
    source_key: `packet:${jobId}:${job.packet_hash}`,
    job_id: jobId,
    packet_hash: job.packet_hash,
    policy_hash: job.policy_hash ?? null,
    tenant_id: tenantId,
    project_id: projectId,
    provenance: "retained_packet",
    authorship: "unverified",
    support_span_ids: packet.snippets.map((snippet) => snippet.span_id),
    snippets: cloneJson(packet.snippets, "session_packet_mismatch"),
    events: cloneJson(packet.events, "session_packet_mismatch"),
    ...(packet.coverage ? {coverage:cloneJson(packet.coverage,"session_packet_mismatch")} : {}),
  };
  return deepFreeze({ ...base, source_hash: stableHash(base) });
}

function parseSourceSelectors(text) {
  const sources = [];
  const seen = new Set();
  const pattern = new RegExp(SOURCE_SELECTOR.source, SOURCE_SELECTOR.flags);
  for (const match of text.matchAll(pattern)) {
    const sourceId = match[1].toLowerCase();
    const version = Number(match[2]);
    const lineStart = match[3] === undefined ? null : Number(match[3]);
    const lineEnd = match[4] === undefined ? null : Number(match[4]);
    if (!Number.isSafeInteger(version) || version < 1
        || (lineStart !== null && (!Number.isSafeInteger(lineStart) || lineStart < 1 || !Number.isSafeInteger(lineEnd) || lineEnd < lineStart))) {
      fail("wiki_source_selector_invalid");
    }
    const ref = match[0];
    if (seen.has(ref)) continue;
    seen.add(ref);
    sources.push({ ref, sourceId, version, lineStart, lineEnd });
  }
  if (sources.length > MAX_WIKI_SOURCE_REFS) fail("wiki_source_limit");
  return sources;
}

function validateWikiPath(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\\") || isAbsolute(value)) fail("wiki_page_path_invalid");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) fail("wiki_page_path_invalid");
  return value;
}

async function readWikiPage(wikiService, selector, tenantId, projectId) {
  const result = await wikiService.request({ wiki_id: "personal", op: "read", ...selector, tenant_id: tenantId, project_id: projectId, max_chars: MAX_WIKI_PAGE_CHARS });
  if (!result || typeof result !== "object" || Array.isArray(result)) fail("wiki_page_unavailable");
  if (result.deleted === true || result.deleted === 1) fail("wiki_page_unavailable");
  if (result.project_id !== projectId) fail("wiki_scope_mismatch");
  if (typeof result.page_id !== "string" || !result.page_id || typeof result.path !== "string" || typeof result.content !== "string") fail("wiki_page_unavailable");
  if (result.truncated === true || [...result.content].length > MAX_WIKI_PAGE_CHARS || Buffer.byteLength(result.content, "utf8") > MAX_WIKI_PAGE_BYTES) fail("wiki_page_too_large");
  if (typeof result.hash !== "string" || !SHA256.test(result.hash) || typeof result.content_hash !== "string" || result.content_hash !== sha256(result.content)) fail("wiki_page_digest_mismatch");
  return result;
}

async function readWikiSource(wikiService, resolveSource, selector, tenantId, projectId) {
  let source;
  try {
    source = resolveSource
      ? await resolveSource({ wikiService, tenantId, projectId, ref: selector.ref, sourceId: selector.sourceId, version: selector.version, maxChars: MAX_WIKI_SOURCE_CHARS })
      : await wikiService.request({
        wiki_id: "personal",
        op: "source_read",
        tenant_id: tenantId,
        project_id: projectId,
        source_id: selector.sourceId,
        version: selector.version,
        max_chars: MAX_WIKI_SOURCE_CHARS,
      });
  } catch {
    fail("wiki_source_unresolved");
  }
  if (!source || source.source_id !== selector.sourceId || source.version !== selector.version || typeof source.text !== "string") fail("wiki_source_unresolved");
  const sourceBytes = Buffer.byteLength(source.text, "utf8");
  if (source.truncated === true || source.next_char_offset != null || [...source.text].length > MAX_WIKI_SOURCE_CHARS || sourceBytes > MAX_WIKI_SOURCE_BYTES) fail("wiki_source_too_large");
  if (typeof source.hash !== "string" || !SHA256.test(source.hash)
      || typeof source.extraction_hash !== "string" || source.extraction_hash !== sha256(source.text)) fail("wiki_source_digest_mismatch");
  const lines = source.text.split(/\r?\n/u);
  if (selector.lineStart !== null && (selector.lineEnd > lines.length || selector.lineStart > lines.length)) fail("wiki_source_range_invalid");
  return {
    source_id: selector.sourceId,
    version: selector.version,
    hash: source.hash,
    source_hash: source.hash,
    extraction_hash: source.extraction_hash,
    text: source.text,
    text_hash: sha256(source.text),
  };
}

function selectSourceExcerpt(source, selector) {
  const lines = source.text.split(/\r?\n/u);
  if (selector.lineStart !== null && (selector.lineEnd > lines.length || selector.lineStart > lines.length)) fail("wiki_source_range_invalid");
  const excerpt = selector.lineStart === null ? source.text : lines.slice(selector.lineStart - 1, selector.lineEnd).join("\n");
  return {
    ref: selector.ref,
    source_id: source.source_id,
    version: source.version,
    hash: source.hash,
    source_hash: source.source_hash,
    extraction_hash: source.extraction_hash,
    line_start: selector.lineStart,
    line_end: selector.lineEnd,
    text: excerpt,
    text_hash: sha256(excerpt),
  };
}

export async function loadWikiPipelineSource({ wikiService, path: pagePath, pageId, expectedHash, projectId, tenantId = "default", wikiId = "personal", resolveSource } = {}) {
  if (wikiId !== "personal" || (wikiService?.wikiId ?? wikiService?.wiki_id ?? "personal") !== "personal") fail("wiki_binding_mismatch");
  if (!wikiService || typeof wikiService.request !== "function"
      || typeof projectId !== "string" || !projectId.trim()
      || typeof tenantId !== "string" || !tenantId.trim()) fail("wiki_source_invalid");
  if ((!pagePath && !pageId) || typeof expectedHash !== "string" || !SHA256.test(expectedHash)) fail("wiki_source_invalid");
  if (pagePath !== undefined) pagePath = validateWikiPath(pagePath);
  if (pageId !== undefined && (typeof pageId !== "string" || !pageId.trim())) fail("wiki_source_invalid");

  let status;
  try {
    status = await wikiStatus(wikiService.config);
  } catch {
    fail("wiki_unavailable");
  }
  if (!status.enabled) fail("feature_disabled");

  const selector = pageId ? { page_id: pageId } : { path: pagePath };
  const page = await readWikiPage(wikiService, selector, tenantId, projectId);
  if (pageId && page.page_id !== pageId) fail("wiki_page_moved");
  if (pagePath && page.path !== pagePath) fail("wiki_page_moved");
  if (page.hash !== expectedHash) fail("wiki_page_stale");

  const history = await wikiService.request({ wiki_id: "personal", op: "history", tenant_id: tenantId, project_id: projectId, page_id: page.page_id });
  const revision = (Array.isArray(history?.revisions) ? history.revisions : []).find((item) =>
    item?.hash === page.hash && item?.path === page.path && item.deleted !== true && item.deleted !== 1,
  );
  if (!revision || typeof revision.revision_id !== "string" || !revision.revision_id) fail("wiki_revision_unresolved");

  const selectors = parseSourceSelectors(page.content);
  const resolved = [];
  let sourceBytes = 0;
  const cache = new Map();
  for (const item of selectors) {
    const key = `${item.sourceId}@${item.version}`;
    let fullSource = cache.get(key);
    if (!fullSource) {
      fullSource = await readWikiSource(wikiService, resolveSource, { ...item, lineStart: null, lineEnd: null }, tenantId, projectId);
      cache.set(key, fullSource);
      sourceBytes += Buffer.byteLength(fullSource.text, "utf8");
      if (sourceBytes > MAX_WIKI_SOURCE_TOTAL_BYTES) fail("wiki_source_too_large");
    }
    resolved.push(selectSourceExcerpt(fullSource, item));
  }

  const finalPage = await readWikiPage(wikiService, { page_id: page.page_id }, tenantId, projectId);
  if (finalPage.page_id !== page.page_id || finalPage.hash !== page.hash || finalPage.path !== page.path
      || finalPage.content_hash !== page.content_hash || finalPage.content !== page.content) fail("wiki_page_stale");

  const base = {
    source_type: "personal_wiki",
    source_key: `wiki:personal:${tenantId}:${projectId}:${page.page_id}:${revision.revision_id}:${page.hash}`,
    wiki_id: "personal",
    tenant_id: tenantId,
    project_id: projectId,
    page_id: page.page_id,
    revision_id: revision.revision_id,
    hash: page.hash,
    content_hash: page.content_hash,
    path: page.path,
    text: page.content,
    selectors: selectors.map((item) => item.ref),
    sources: resolved,
    provenance: "wiki_revision_and_immutable_source",
    authorship: "unverified",
  };
  return deepFreeze({ ...base, source_hash: stableHash(base) });
}
