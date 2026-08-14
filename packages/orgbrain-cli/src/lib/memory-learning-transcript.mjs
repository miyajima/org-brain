import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeMemoryLearningEvent } from "../../../shared/src/memory-learning-runtime.mjs";
import { normalizeMemoryContractV2Event } from "../../../shared/src/memory-contract-v2-runtime.mjs";
import { requestUserInputEvidenceDigest } from "./task-commitment-store.mjs";

const execFileAsync = promisify(execFile);
export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeJson(value) {
  try { return JSON.parse(String(value ?? "")); } catch { return null; }
}

function stringify(value) {
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
}

function unwrapJson(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current && typeof current === "object") return current;
    if (typeof current !== "string") return null;
    const parsed = safeJson(current);
    if (parsed !== null) {
      current = parsed;
      continue;
    }
    const start = current.indexOf("{");
    const end = current.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    current = safeJson(current.slice(start, end + 1));
  }
  return current && typeof current === "object" ? current : null;
}

function verifyCommandAttestation(output, key = process.env.ORGBRAIN_EVIDENCE_ATTESTATION_KEY) {
  const parsed = unwrapJson(output);
  if (!parsed || typeof key !== "string" || key.length < 32) return null;
  const payload = {
    schema_version: parsed.schema_version,
    command_hash: parsed.command_hash,
    exit_code: parsed.exit_code,
    started_at: parsed.started_at,
    completed_at: parsed.completed_at,
    cwd_hash: parsed.cwd_hash
  };
  if (
    payload.schema_version !== 1
    || !/^[a-f0-9]{64}$/u.test(payload.command_hash)
    || !Number.isInteger(payload.exit_code)
    || !Number.isFinite(payload.started_at)
    || !Number.isFinite(payload.completed_at)
    || payload.completed_at < payload.started_at
    || !/^[a-f0-9]{64}$/u.test(payload.cwd_hash)
    || !/^hmac-sha256:[a-f0-9]{64}$/u.test(parsed.attestation_ref ?? "")
  ) return null;
  const expected = crypto.createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
  const actual = String(parsed.attestation_ref).slice("hmac-sha256:".length);
  if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))) return null;
  return { ...payload, attestation_ref: parsed.attestation_ref };
}

async function readTail(file, maxBytes = MAX_TRANSCRIPT_BYTES) {
  const info = await stat(file);
  const size = Math.min(info.size, maxBytes);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, info.size - size);
    let text = buffer.toString("utf8");
    if (info.size > size) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    await handle.close();
  }
}

function payload(row) {
  return row?.payload && typeof row.payload === "object" ? row.payload : row;
}

function currentTurnRows(rows, turnId) {
  let start = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = payload(rows[index]);
    if (item?.type === "turn_context" && (!turnId || item.turn_id === turnId)) {
      start = index;
      break;
    }
  }
  return rows.slice(Math.max(0, start));
}

function textContent(result) {
  const contents = result?.content ?? result?.Ok?.content ?? result?.result?.content;
  if (!Array.isArray(contents)) return null;
  return contents.find((item) => item?.type === "text" && typeof item.text === "string")?.text ?? null;
}

function observeInvocation(item) {
  if (item?.type === "mcp_tool_call_end") {
    const invocation = item.invocation ?? {};
    const tool = invocation.tool ?? invocation.name;
    if (tool !== "orgbrain_memory_observe") return null;
    const input = invocation.arguments ?? invocation.args ?? invocation.input;
    const result = item.result;
    if (result?.Err || item.error) return null;
    return { input, output: safeJson(textContent(result)) };
  }
  if (["function_call", "custom_tool_call"].includes(item?.type) && item.name === "orgbrain_memory_observe") {
    return { input: safeJson(item.arguments ?? item.input), callId: item.call_id, output: null };
  }
  return null;
}

function collectUserText(rows) {
  const values = [];
  for (const row of rows) {
    const item = payload(row);
    if (item?.type === "user_message" && typeof item.message === "string") values.push(item.message);
    if (item?.type === "message" && item.role === "user") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) if (typeof part?.text === "string") values.push(part.text);
    }
  }
  return values.join("\n");
}

function commandExecutions(rows, attestationKey) {
  const calls = new Map();
  const executions = [];
  for (const row of rows) {
    const item = payload(row);
    if (["custom_tool_call", "function_call"].includes(item?.type) && /(?:^|\.)(?:exec|exec_command)$/u.test(String(item.name ?? ""))) {
      const rawInput = item.input ?? item.arguments ?? "";
      const parsedInput = typeof rawInput === "string" ? safeJson(rawInput) : rawInput;
      calls.set(item.call_id, typeof parsedInput?.cmd === "string" ? parsedInput.cmd : stringify(rawInput));
    }
    if (["custom_tool_call_output", "function_call_output"].includes(item?.type)) {
      const commandInput = calls.get(item.call_id);
      if (!commandInput) continue;
      const output = stringify(item.output ?? item.content ?? "");
      const exitMatch = output.match(/(?:exit[_ ]code|Process exited with code)\D{0,8}(-?\d+)/iu);
      const exitCode = exitMatch ? Number(exitMatch[1]) : /Script completed|completed successfully/iu.test(output) ? 0 : null;
      const attestation = verifyCommandAttestation(item.output ?? item.content ?? "", attestationKey);
      const requiresAttestation = /(?:^|\s)evidence\s+run\s+--(?:\s|$)/u.test(commandInput);
      executions.push({
        input: commandInput,
        output,
        exit_code: requiresAttestation && !attestation ? null : attestation?.exit_code ?? exitCode,
        observed_at: attestation?.completed_at ?? Date.now(),
        content_hash: attestation?.command_hash ?? hash(commandInput),
        normalized_command_hash: hash(normalizeCommand(commandInput)),
        attested_command_hash: attestation?.command_hash ?? null,
        attestation_ref: attestation?.attestation_ref ?? (requiresAttestation ? null : `transcript:${exitCode}`),
        attestation_required: requiresAttestation,
        attestation_verified: Boolean(attestation)
      });
    }
  }
  return executions;
}

function normalizeCommand(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function successfulFetches(rows) {
  const results = [];
  for (const row of rows) {
    const item = payload(row);
    if (item?.type !== "mcp_tool_call_end" || item?.result?.Err) continue;
    const tool = String(item?.invocation?.tool ?? item?.invocation?.name ?? "");
    if (!/(?:open|fetch|web|browser)/iu.test(tool)) continue;
    const args = stringify(item?.invocation?.arguments ?? item?.invocation?.args ?? {});
    const result = stringify(item.result?.Ok ?? item.result);
    results.push({ args, result, content_hash: hash(result) });
  }
  return results;
}

function requestUserInputResults(rows) {
  const results = [];
  for (const row of rows) {
    const item = payload(row);
    if (item?.type !== "mcp_tool_call_end" || item?.result?.Err) continue;
    const invocation = item.invocation ?? {};
    const tool = invocation.tool ?? invocation.name;
    if (!/(?:^|[.:/])request_user_input$/u.test(String(tool ?? ""))) continue;
    const input = invocation.arguments ?? invocation.args ?? invocation.input ?? {};
    const result = item.result?.Ok ?? item.result;
    results.push({
      digest: requestUserInputEvidenceDigest(input, result),
      observed_at: Date.now(),
      result
    });
  }
  return results;
}

async function fileEvidence(workspaceRoot, ref, conclusion, expectedDigest = null) {
  if (!workspaceRoot || path.isAbsolute(ref) || ref.includes("..")) return { ok: false, reason: "file_scope_invalid" };
  const absolute = path.resolve(workspaceRoot, ref);
  if (!absolute.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`)) return { ok: false, reason: "file_scope_invalid" };
  let content;
  try {
    const handle = await open(absolute, "r");
    try { content = await handle.readFile(); } finally { await handle.close(); }
  } catch {
    return { ok: false, reason: "file_not_found" };
  }
  const fileHash = hash(content);
  if (expectedDigest && expectedDigest !== `sha256:${fileHash}`) {
    return { ok: false, reason: "file_content_hash_mismatch" };
  }
  let head = null;
  let dirty = false;
  let diffHash = null;
  try {
    const [{ stdout: headOut }, { stdout: statusOut }, { stdout: diffOut }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, encoding: "utf8" }),
      execFileAsync("git", ["status", "--short", "--", ref], { cwd: workspaceRoot, encoding: "utf8" }),
      execFileAsync("git", ["diff", "--no-ext-diff", "HEAD", "--", ref], { cwd: workspaceRoot, encoding: "utf8" })
    ]);
    head = headOut.trim() || null;
    dirty = Boolean(statusOut.trim());
    diffHash = hash(diffOut);
  } catch {
    return { ok: false, reason: "git_evidence_unavailable" };
  }
  const identifiers = String(conclusion ?? "").match(/[A-Za-z_][A-Za-z0-9_.-]{4,}/gu) ?? [];
  const hasIdentifier = identifiers.some((identifier) => content.includes(identifier));
  if (!dirty && !hasIdentifier) return { ok: false, reason: "file_not_relevant" };
  return {
    ok: true,
    evidence: {
      type: "file", ref, content_hash: fileHash, observed_at: Date.now(),
      diff_hash: diffHash,
      attestation_ref: `git:${head ?? "unknown"}:${dirty ? "dirty" : "clean"}`
    },
    changed: dirty
  };
}

function qualityDimensions(event, evidence) {
  const scope = event.applicability.target_files.length + event.applicability.components.length > 0 ? 100 : 0;
  const isV2 = event.schema_version === 2;
  return {
    atomicity: 100,
    conclusion: event.conclusion ? 100 : 0,
    rationale: (event.rationale || (isV2 && event.lesson_type === "decision" && event.decision_type === "user_choice")) ? 100 : 0,
    reuse_or_avoidance: event.reuse_rule ? 100 : 0,
    outcome: (event.outcome || event.lesson_type === "decision") ? 100 : 0,
    evidence_support: evidence.length > 0 ? 100 : 0,
    scope
  };
}

export async function verifyLearningEvent(event, context) {
  const evidence = [];
  const reasons = [];
  let changedFile = false;
  let successfulCommand = false;
  let failedCommand = false;
  const executions = commandExecutions(context.rows, context.attestationKey);
  const fetches = successfulFetches(context.rows);
  const requestResults = requestUserInputResults(context.rows);
  const v2 = event.schema_version === 2;
  for (const selector of event.evidence_selectors) {
    if (selector.type === "command") {
      const expectedDigest = typeof selector.digest === "string"
        ? (selector.digest.startsWith("sha256:") ? selector.digest.slice("sha256:".length) : selector.digest)
        : v2 ? hash(normalizeCommand(selector.ref)) : null;
      const matches = executions.filter((execution) => {
        if (expectedDigest && (v2
          ? execution.normalized_command_hash === expectedDigest
          : execution.content_hash === expectedDigest)) return true;
        if (v2) return false;
        return execution.input.includes(selector.ref);
      });
      const execution = matches.at(-1);
      if (!execution || execution.exit_code === null) {
        reasons.push(execution?.attestation_required ? "command_attestation_invalid" : "command_not_observed");
        continue;
      }
      successfulCommand ||= execution.exit_code === 0;
      failedCommand ||= execution.exit_code !== 0;
      evidence.push({
        type: "command", ref: selector.ref ?? `sha256:${expectedDigest}`, observed_at: execution.observed_at,
        content_hash: v2 ? `sha256:${execution.normalized_command_hash}` : execution.content_hash,
        attestation_ref: execution.attestation_ref,
        exit_code: execution.exit_code
      });
      continue;
    }
    if (selector.type === "file" || (selector.type === "doc" && !/^https?:\/\//iu.test(selector.ref))) {
      const expectedDigest = v2 && typeof selector.digest === "string"
        ? (selector.digest.startsWith("sha256:") ? selector.digest : `sha256:${selector.digest}`)
        : null;
      const verified = await fileEvidence(context.workspaceRoot, selector.ref, event.conclusion, expectedDigest);
      if (!verified.ok) reasons.push(verified.reason);
      else {
        evidence.push(verified.evidence);
        changedFile ||= verified.changed;
      }
      continue;
    }
    if (selector.type === "doc") {
      const fetched = fetches.find((item) => item.args.includes(selector.ref));
      if (!fetched) reasons.push("doc_not_fetched");
      else evidence.push({ type: "doc", ref: selector.ref, content_hash: fetched.content_hash, observed_at: Date.now(), attestation_ref: "transcript:fetch" });
      continue;
    }
    if (selector.type === "user_statement") {
      if (!context.userText.includes(selector.ref)) reasons.push("user_statement_not_observed");
      else evidence.push({ type: "user_statement", ref: `sha256:${hash(selector.ref)}`, content_hash: hash(context.userText), observed_at: Date.now(), attestation_ref: "transcript:user" });
      continue;
    }
    if (selector.type === "tool_result") {
      const expectedDigest = typeof selector.digest === "string"
        ? (selector.digest.startsWith("sha256:") ? selector.digest : `sha256:${selector.digest}`)
        : null;
      const match = expectedDigest ? requestResults.find((item) => item.digest === expectedDigest) : null;
      if (!match) reasons.push(expectedDigest ? "tool_result_digest_not_observed" : "tool_result_digest_required");
      else evidence.push({ type: "tool_result", ref: expectedDigest, content_hash: expectedDigest.slice("sha256:".length), observed_at: match.observed_at, attestation_ref: "transcript:request_user_input" });
    }
  }
  if (event.gaps.length > 0) reasons.push("gaps_present");
  if (event.applicability.target_files.length + event.applicability.components.length === 0) reasons.push("scope_missing");
  const independentTypes = new Set(evidence.map((item) => item.type));
  if (event.lesson_type === "success" && (!changedFile || !successfulCommand || (v2 && (!event.procedure || !event.why_it_worked || !event.observed_outcome || !event.reuse_when)))) reasons.push("success_requires_change_and_verification");
  if (event.lesson_type === "failure" && (!failedCommand || !successfulCommand || !event.rationale || !event.reuse_rule || (v2 && (!event.symptom || !event.root_cause || !event.correction || !event.verified_outcome || !event.avoidance_rule)))) {
    reasons.push("failure_chain_incomplete");
  }
  if (v2 && event.lesson_type === "decision" && !["user_choice", "preference"].includes(event.decision_type) && independentTypes.size < 2) reasons.push("decision_requires_two_evidence_types");
  if (!v2 && ["decision", "constraint"].includes(event.kind) && independentTypes.size < 2) reasons.push("decision_requires_two_evidence_types");
  if (v2 && event.lesson_type === "decision" && !evidence.some((item) => ["user_statement", "tool_result"].includes(item.type))) reasons.push("decision_confirmation_evidence_required");
  if (v2 && event.capture_intent === "review") reasons.push("review_intent");
  const verified = reasons.length === 0;
  const dimensions = qualityDimensions(event, evidence);
  return {
    verification_state: verified ? "verified" : evidence.length > 0 ? "partial" : "unverified",
    verified_at: verified ? Date.now() : null,
    evidence,
    quality_dimensions: dimensions,
    quality_score: Math.min(...Object.values(dimensions)),
    reason_codes: [...new Set(reasons)]
  };
}

export async function collectVerifiedLearningEvents(options) {
  if (!options.transcriptPath) return { events: [], reviews: [{ reason_codes: ["transcript_path_missing"] }] };
  const raw = await readTail(options.transcriptPath, options.maxBytes ?? MAX_TRANSCRIPT_BYTES);
  const rows = raw.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const parsed = safeJson(line);
    return parsed ? [parsed] : [];
  });
  const turnRows = currentTurnRows(rows, options.turnId);
  const userText = collectUserText(turnRows);
  const toolResults = turnRows.map((row) => stringify(payload(row))).join("\n");
  const observations = [];
  const pending = new Map();
  for (const row of turnRows) {
    const item = payload(row);
    const invocation = observeInvocation(item);
    if (invocation?.callId) pending.set(invocation.callId, invocation);
    if (invocation?.input && invocation.output?.accepted) observations.push(invocation);
    if (["custom_tool_call_output", "function_call_output"].includes(item?.type)) {
      const prior = pending.get(item.call_id);
      const output = safeJson(typeof item.output === "string" ? item.output : textContent(item.output));
      if (prior && output?.accepted) observations.push({ ...prior, output });
    }
  }
  const events = [];
  const reviews = [];
  for (const observation of observations.slice(-3)) {
    const normalized = observation.input?.schema_version === 2
      ? await normalizeMemoryContractV2Event(observation.input, {
        workspaceRoot: options.workspaceRoot,
        sensitivePolicy: options.sensitivePolicy ?? { mode: "deny", allowed_principals: [] }
      })
      : await normalizeMemoryLearningEvent(observation.input, {
      workspaceRoot: options.workspaceRoot,
      sensitivePolicy: options.sensitivePolicy ?? { mode: "deny", allowed_principals: [] }
      });
    if (!normalized.accepted || normalized.event_hash !== observation.output.event_hash) {
      reviews.push({ event_hash: observation.output?.event_hash ?? null, reason_codes: ["observe_attestation_mismatch", ...normalized.reason_codes] });
      continue;
    }
    const verification = await verifyLearningEvent(normalized.event, {
      rows: turnRows,
      userText,
      toolResults,
      workspaceRoot: options.workspaceRoot,
      attestationKey: options.attestationKey
    });
    if (verification.verification_state !== "verified") {
      reviews.push({ event_hash: normalized.event_hash, learning: normalized.event, reason_codes: verification.reason_codes, verification });
      continue;
    }
    events.push({ event_hash: normalized.event_hash, learning: normalized.event, verification });
  }
  return { events, reviews, scanned_bytes: Buffer.byteLength(raw), raw_transcript_persisted: false };
}
