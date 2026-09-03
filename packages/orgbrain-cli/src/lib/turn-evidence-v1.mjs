import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import {
  normalizeMemoryPaths,
  screenSensitiveMemory
} from "../../../shared/src/memory-capture-v2-runtime.mjs";
import { normalizeMemoryContractV2Event } from "../../../shared/src/memory-contract-v2-runtime.mjs";

export const TURN_EVIDENCE_V1_SCHEMA = "turn-evidence/v1";
export const LEARNING_EXTRACTION_PROPOSAL_V1_SCHEMA = "learning-extraction-proposal/v1";
export const MEMORY_EXTRACTION_INPUT_TOKEN_LIMIT = 2_000;
export const MEMORY_EXTRACTION_OUTPUT_TOKEN_LIMIT = 800;
export const MEMORY_EXTRACTION_MAX_CANDIDATES = 3;

const MAX_TRANSCRIPT_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TURN_BYTES = 8 * 1024 * 1024;

const DECISION_SIGNAL = /\b(?:decid(?:e|ed)|adopt(?:ed)?|choose|chose|selected|standardize|switch(?:ed)?\s+to|will use|must use)\b|(?:決定(?:した|する)|採用(?:した|する)|選択(?:した|する)|方針(?:とする|にした)|統一(?:する|した)|切り替え(?:る|た)|これで進める)/iu;
const TRANSIENT_CHOICE = /(?:今回だけ|このターン|一時的|ひとまず|今だけ|for now|this time|temporary|one[- ]off)/iu;
const DURABLE_SCOPE = /\b(?:implementation|architecture|api|schema|policy|governance|repository|project|organization|tenant|default|rule)\b|(?:実装|設計|API|スキーマ|方針|ルール|規約|組織|テナント|プロジェクト|既定|デフォルト)/iu;
const FAILURE_SIGNAL = /\b(?:fail(?:ed|ure)?|error|regression|timed? out|did not work|broken|root cause)\b|(?:失敗|エラー|不具合|回帰|動かな(?:い|かった)|原因|タイムアウト)/iu;
const CORRECTION_SIGNAL = /\b(?:fix(?:ed)?|correct(?:ed)?|changed?|switch(?:ed)?|retry|workaround|prevent(?:ed)?)\b|(?:修正|変更|切り替え|対処|解消|回避|再実行|再発防止)/iu;
const SUCCESS_SIGNAL = /\b(?:pass(?:ed)?|succeed(?:ed)?|success|resolved|verified|exit[_ ]?code\s*[=:]?\s*0|2\d\d)\b|(?:成功|通った|解消|確認(?:した|できた|済み)|検証済み|終了コード\s*0)/iu;
const REASON_SIGNAL = /\b(?:because|since|reason|root cause|caused by)\b|(?:理由|なぜなら|原因)/iu;
const REUSE_SIGNAL = /\b(?:when|whenever|next time|reuse|avoid)\b|(?:場合|次回|再利用|回避策|再発時)/iu;
const UNSAFE_SIGNAL = /\b(?:ignore|disregard|override)\b.{0,40}\b(?:previous|system|developer|security)\b|\b(?:reveal|exfiltrate|print)\b.{0,40}\b(?:secret|credential|system prompt)\b|前の指示を無視|秘密.{0,12}(?:表示|送信)/iu;

function sha256(value) {
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

function rowPayload(row) {
  return row?.payload && typeof row.payload === "object" ? row.payload : row;
}

export async function loadTurnEvidenceRows(input = {}) {
  if (typeof input.transcript_path !== "string" || !input.transcript_path.trim()) return [];
  const rows = [];
  let sessionMeta = null;
  let current = [];
  let currentBytes = 0;
  let matched = null;
  const requestedTurn = typeof input.turn_id === "string" ? input.turn_id.trim() : "";
  const stream = createReadStream(input.transcript_path, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const flush = () => {
    if (current.length === 0) return;
    const context = current.find((row) => row?.type === "turn_context" || rowPayload(row)?.type === "turn_context");
    const turnId = String(rowPayload(context)?.turn_id ?? "").trim();
    if (!requestedTurn || requestedTurn === turnId) matched = [...(sessionMeta ? [sessionMeta] : []), ...current];
    current = [];
    currentBytes = 0;
  };
  for await (const line of lines) {
    if (!line || /"(?:agent_reasoning|reasoning)"/u.test(line)) continue;
    if (Buffer.byteLength(line) > MAX_TRANSCRIPT_LINE_BYTES) throw new Error("turn_evidence_line_too_large");
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error("turn_evidence_transcript_corrupt");
    }
    if (row?.type === "session_meta") {
      sessionMeta = row;
      continue;
    }
    const payload = rowPayload(row);
    const isTurnContext = row?.type === "turn_context" || payload?.type === "turn_context";
    if (isTurnContext) flush();
    currentBytes += Buffer.byteLength(line);
    if (currentBytes > MAX_TURN_BYTES) throw new Error("turn_evidence_turn_too_large");
    current.push(row);
  }
  flush();
  if (matched) rows.push(...matched);
  return rows;
}

function clip(value, limit) {
  const text = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (["input_text", "output_text", "text"].includes(item.type) && typeof item.text === "string") return [item.text];
    return [];
  }).join("\n");
}

function messageFromRow(row) {
  const payload = rowPayload(row);
  if (payload?.type === "user_message" && typeof payload.message === "string") {
    return { role: "user", phase: "input", text: payload.message };
  }
  if (payload?.type === "agent_message" && typeof payload.message === "string") {
    return { role: "assistant", phase: payload.phase ?? "unknown", text: payload.message };
  }
  if (payload?.type === "message" && ["user", "assistant"].includes(payload.role)) {
    return { role: payload.role, phase: payload.phase ?? "unknown", text: contentText(payload.content) };
  }
  return null;
}

function toolCallFromRow(row, workspaceRoot) {
  const payload = rowPayload(row);
  const type = payload?.type;
  if (!["function_call", "custom_tool_call", "mcp_tool_call", "mcp_tool_call_end"].includes(type)) return null;
  const invocation = payload.invocation && typeof payload.invocation === "object" ? payload.invocation : {};
  const name = clip(invocation.tool ?? invocation.name ?? payload.name ?? payload.tool_name ?? payload.server ?? "tool", 128);
  const effectiveArguments = invocation.arguments ?? invocation.input ?? payload.arguments ?? payload.input ?? payload.params ?? {};
  const effectiveResult = invocation.result ?? payload.result;
  const serializedArguments = stableJson(effectiveArguments);
  const normalizedArguments = normalizeMemoryPaths(serializedArguments, workspaceRoot ?? null);
  const changedPaths = name === "apply_patch"
    ? [...normalizedArguments.matchAll(/\*\*\* (?:Add|Update|Delete) File:\s*([^\\"\n]+)/gu)]
        .map((match) => clip(match[1], 512))
        .filter((path) => path && !path.startsWith("/") && !path.split("/").includes(".."))
        .slice(0, 32)
    : [];
  return {
    call_id: String(payload.call_id ?? payload.id ?? sha256(stableJson(payload)).slice(0, 24)),
    type: name === "request_user_input"
      ? "user_input_request"
      : name === "apply_patch"
        ? "file_change"
        : name === "exec" || name === "exec_command"
          ? "command"
        : type.startsWith("mcp_")
          ? "mcp_invocation"
          : "tool_execution",
    name,
    status: payload.status === "failed" || payload.error ? "failed" : type === "mcp_tool_call_end" ? "completed" : "started",
    argument_hash: `sha256:${sha256(stableJson(effectiveArguments))}`,
    result_hash: effectiveResult === undefined ? null : `sha256:${sha256(stableJson(effectiveResult))}`,
    exit_code: Number.isInteger(payload.exit_code) ? payload.exit_code : null,
    http_status: Number.isInteger(payload.http_status) ? payload.http_status : null,
    changed_paths: changedPaths
  };
}

function toolResultFromRow(row) {
  const payload = rowPayload(row);
  if (!["function_call_output", "custom_tool_call_output", "tool_result"].includes(payload?.type)) return null;
  const output = payload.output ?? payload.result ?? payload.content ?? "";
  const serialized = typeof output === "string" ? output : stableJson(output);
  const exitMatch = serialized.match(/(?:exit[_ ]?code|status)\s*[=:]\s*(-?\d{1,3})/iu);
  const httpMatch = serialized.match(/\bHTTP\/?\d(?:\.\d)?\s+(\d{3})\b/iu);
  const exitCode = Number.isInteger(payload.exit_code) ? payload.exit_code : exitMatch ? Number(exitMatch[1]) : null;
  const httpStatus = Number.isInteger(payload.http_status) ? payload.http_status : httpMatch ? Number(httpMatch[1]) : null;
  const failed = payload.is_error === true || (exitCode !== null && exitCode !== 0) || (httpStatus !== null && httpStatus >= 400) || /\b(?:error|failed|failure|exception)\b|(?:エラー|失敗)/iu.test(serialized.slice(0, 1_000));
  return {
    call_id: String(payload.call_id ?? payload.id ?? sha256(serialized).slice(0, 24)),
    status: failed ? "failed" : "completed",
    result_hash: `sha256:${sha256(serialized)}`,
    exit_code: exitCode,
    http_status: httpStatus
  };
}

function sentenceSpans(snippets) {
  return snippets.flatMap((snippet) => snippet.text
    .split(/(?<=[。！？.!?])\s+|\n+/u)
    .map((text, index) => ({
      span_id: `${snippet.span_id}.${index + 1}`,
      parent_span_id: snippet.span_id,
      role: snippet.role,
      text: clip(text, 1_000)
    }))
    .filter((item) => item.text.length >= 8));
}

function firstMatch(spans, pattern, after = -1) {
  return spans.find((span, index) => index > after && pattern.test(span.text)) ?? null;
}

function findIndex(spans, span) {
  return span ? spans.findIndex((item) => item.span_id === span.span_id) : -1;
}

function inferDecisionType(text) {
  if (/\b(?:api|schema|architecture|implementation|library|framework|database|runtime)\b|(?:API|スキーマ|アーキテクチャ|実装|ライブラリ|フレームワーク|データベース|ランタイム)/iu.test(text)) return "implementation";
  if (/\b(?:policy|governance|approval|permission|acl|must|never)\b|(?:規約|承認|権限|禁止|必須)/iu.test(text)) return "governance";
  if (/\b(?:prefer|preference)\b|(?:好む|希望|優先)/iu.test(text)) return "preference";
  if (DURABLE_SCOPE.test(text)) return "implementation";
  return null;
}

function clause(spans, pattern) {
  return spans.find((item) => pattern.test(item.text))?.text ?? null;
}

function evidenceSelectors(supportSpans, events) {
  const selectors = [];
  for (const span of supportSpans) {
    if (span.role !== "user") continue;
    selectors.push({ type: "user_statement", ref: span.text, supports: [span.span_id] });
  }
  for (const event of events.filter((item) => item.status === "completed" && item.result_hash).slice(0, 2)) {
    selectors.push({ type: "tool_result", digest: event.result_hash, supports: [event.event_id] });
  }
  return selectors.slice(0, 4);
}

function missingGaps(fields) {
  return Object.entries(fields).filter(([, value]) => value === null || value === "" || Array.isArray(value) && value.length === 0).map(([name]) => `${name}_missing`);
}

async function normalizeProposal(observation, supportSpanIds, reasonCodes, options) {
  const normalized = await normalizeMemoryContractV2Event(observation, {
    workspaceRoot: options.workspace_root ?? null,
    sensitivePolicy: options.sensitive_policy
  });
  if (!normalized.accepted || !normalized.event) return null;
  return {
    proposal_schema: LEARNING_EXTRACTION_PROPOSAL_V1_SCHEMA,
    observation: normalized.event,
    support_span_ids: [...new Set(supportSpanIds)].slice(0, 16),
    gaps: normalized.event.gaps,
    reason_codes: [...new Set([...reasonCodes, ...normalized.reason_codes])],
    event_hash: normalized.event_hash,
    requires_llm: normalized.event.gaps.length > 0
  };
}

export async function buildTurnEvidenceV1(input, options = {}) {
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  const snippets = [];
  const eventsByCall = new Map();
  let provider = clip(input?.provider, 64) || null;
  let model = clip(input?.model, 128) || null;
  let hardExclusion = null;

  for (const row of rows) {
    const payload = rowPayload(row);
    if (payload?.type === "turn_context") model ||= clip(payload.model, 128) || null;
    if (row?.type === "session_meta") provider ||= clip(row.payload?.model_provider, 64) || null;

    const message = messageFromRow(row);
    if (message?.text) {
      const normalized = normalizeMemoryPaths(message.text, options.workspace_root ?? null);
      if (UNSAFE_SIGNAL.test(normalized)) {
        hardExclusion = "unsafe_instruction";
        break;
      }
      const screened = screenSensitiveMemory(normalized, options.sensitive_policy);
      if (!screened.allowed) {
        hardExclusion = screened.reason ?? "sensitive_default_deny";
        break;
      }
      const keepAssistant = message.role !== "assistant" || message.phase === "final_answer" || message.phase === "final";
      if (keepAssistant && screened.text.trim()) {
        snippets.push({
          span_id: `s${snippets.length + 1}`,
          role: message.role,
          kind: message.role === "assistant" ? "assistant_final" : "user_message",
          text: clip(screened.text, 4_000),
          text_hash: `sha256:${sha256(screened.text)}`
        });
      }
    }

    const call = toolCallFromRow(row, options.workspace_root);
    if (call) eventsByCall.set(call.call_id, { ...eventsByCall.get(call.call_id), ...call });
    const result = toolResultFromRow(row);
    if (result) eventsByCall.set(result.call_id, { ...eventsByCall.get(result.call_id), ...result });
  }

  const events = [...eventsByCall.values()].map((event, index) => ({
    event_id: `e${index + 1}`,
    type: event.type ?? "tool_execution",
    name: event.name ?? "tool",
    status: event.status ?? "unknown",
    argument_hash: event.argument_hash ?? null,
    result_hash: event.result_hash ?? null,
    exit_code: event.exit_code ?? null,
    http_status: event.http_status ?? null,
    changed_paths: event.changed_paths ?? []
  }));
  const turnEvidence = {
    schema: TURN_EVIDENCE_V1_SCHEMA,
    session_hash: input?.session_hash ?? null,
    turn_hash: input?.turn_hash ?? null,
    project_id: input?.project_id ?? null,
    provider,
    model,
    snippets: hardExclusion ? [] : snippets.slice(0, 8),
    events: hardExclusion ? [] : events.slice(0, 24),
    hard_exclusion_reason: hardExclusion,
    raw_transcript_persisted: false,
    reasoning_included: false,
    absolute_paths_included: false
  };
  return { ...turnEvidence, evidence_hash: `sha256:${sha256(stableJson(turnEvidence))}` };
}

export async function discoverLearningEpisodes(turnEvidence, options = {}) {
  if (turnEvidence?.hard_exclusion_reason) {
    return {
      drafts: [],
      review_drafts: [],
      excluded: [{ reason: turnEvidence.hard_exclusion_reason, disposition: "hard_excluded" }],
      no_candidate: false,
      llm_recommended: false
    };
  }
  const spans = sentenceSpans(turnEvidence?.snippets ?? []);
  const events = turnEvidence?.events ?? [];
  const proposals = [];

  const failure = firstMatch(spans, FAILURE_SIGNAL);
  const failureIndex = findIndex(spans, failure);
  const correction = firstMatch(spans, CORRECTION_SIGNAL, failureIndex);
  const correctionIndex = findIndex(spans, correction);
  const textualSuccess = spans.find((span, index) => index > failureIndex && SUCCESS_SIGNAL.test(span.text)) ?? null;
  const failedEvent = events.find((event) => event.status === "failed") ?? null;
  const successfulEvent = events.find((event, index) => event.status === "completed" && index > events.indexOf(failedEvent)) ?? null;
  if ((failure || failedEvent) && (correction || successfulEvent)) {
    const support = [failure, correction, textualSuccess].filter(Boolean);
    const fields = {
      symptom: failure?.text ?? null,
      failed_approach: null,
      root_cause: clause(spans, REASON_SIGNAL),
      correction: correction?.text ?? null,
      verified_outcome: textualSuccess?.text ?? null,
      avoidance_rule: clause(spans, REUSE_SIGNAL)
    };
    const gaps = missingGaps(fields);
    const observation = {
      record_type: "learning_observation",
      schema_version: 2,
      lesson_type: "failure",
      capture_intent: "review",
      trigger: fields.symptom,
      applicability: { target_files: [], components: turnEvidence.project_id ? [turnEvidence.project_id] : [] },
      evidence_selectors: evidenceSelectors(support, events),
      gaps,
      ...fields
    };
    const proposal = await normalizeProposal(observation, [
      ...support.map((item) => item.span_id),
      ...(failedEvent ? [failedEvent.event_id] : []),
      ...(successfulEvent ? [successfulEvent.event_id] : [])
    ], ["episode_failure_detected"], options);
    if (proposal) proposals.push(proposal);
  }

  const decision = spans.find((span) => DECISION_SIGNAL.test(span.text) && !TRANSIENT_CHOICE.test(span.text) && DURABLE_SCOPE.test(span.text));
  if (decision && proposals.length < MEMORY_EXTRACTION_MAX_CANDIDATES) {
    const decisionType = inferDecisionType(decision.text);
    const rationale = clause(spans, REASON_SIGNAL);
    const fields = {
      decision_type: decisionType,
      decision_key: `inferred.${sha256(decision.text).slice(0, 24)}`,
      question: null,
      selected_value: null,
      decision: decision.text,
      constraints: [],
      rationale,
      alternatives: [],
      reuse_when: clause(spans, REUSE_SIGNAL)
    };
    const gaps = missingGaps({
      decision_type: fields.decision_type,
      question: fields.question,
      rationale: fields.rationale,
      alternatives: fields.alternatives,
      reuse_when: fields.reuse_when
    });
    const observation = {
      record_type: "learning_observation",
      schema_version: 2,
      lesson_type: "decision",
      capture_intent: "review",
      trigger: decision.text,
      applicability: { target_files: [], components: turnEvidence.project_id ? [turnEvidence.project_id] : [] },
      evidence_selectors: evidenceSelectors([decision], events),
      gaps,
      ...fields
    };
    const proposal = await normalizeProposal(observation, [decision.span_id], ["episode_decision_detected", "inferred_unconfirmed"], options);
    if (proposal) proposals.push(proposal);
  }

  const success = textualSuccess ?? firstMatch(spans, SUCCESS_SIGNAL);
  const procedure = success
    ? (CORRECTION_SIGNAL.test(success.text)
        ? success
        : spans.slice(0, findIndex(spans, success)).reverse().find((span) => CORRECTION_SIGNAL.test(span.text)))
    : null;
  const verifiedTool = events.find((event) => event.status === "completed" && (event.exit_code === 0 || event.http_status >= 200 && event.http_status < 300));
  if ((success || verifiedTool) && procedure && proposals.length < MEMORY_EXTRACTION_MAX_CANDIDATES) {
    const fields = {
      procedure: procedure.text,
      why_it_worked: clause(spans, REASON_SIGNAL),
      observed_outcome: success?.text ?? null,
      reuse_when: clause(spans, REUSE_SIGNAL)
    };
    const observation = {
      record_type: "learning_observation",
      schema_version: 2,
      lesson_type: "success",
      capture_intent: "review",
      trigger: procedure.text,
      applicability: { target_files: [], components: turnEvidence.project_id ? [turnEvidence.project_id] : [] },
      evidence_selectors: evidenceSelectors([procedure, success].filter(Boolean), events),
      gaps: missingGaps(fields),
      ...fields
    };
    const proposal = await normalizeProposal(observation, [procedure.span_id, success?.span_id, verifiedTool?.event_id].filter(Boolean), ["episode_success_detected"], options);
    if (proposal) proposals.push(proposal);
  }

  const unique = [];
  const hashes = new Set();
  for (const proposal of proposals) {
    const key = `${proposal.observation.lesson_type}:${proposal.event_hash}`;
    if (hashes.has(key)) continue;
    hashes.add(key);
    unique.push(proposal);
  }
  const reviewDrafts = unique.slice(0, MEMORY_EXTRACTION_MAX_CANDIDATES);
  return {
    drafts: [],
    review_drafts: reviewDrafts,
    excluded: [],
    no_candidate: reviewDrafts.length === 0,
    llm_recommended: reviewDrafts.some((item) => item.requires_llm)
  };
}

export function buildLearningExtractionPacket(turnEvidence, discovery) {
  const supportIds = new Set((discovery?.review_drafts ?? []).flatMap((item) => item.support_span_ids ?? []));
  const parentIds = new Set([...supportIds].map((id) => String(id).split(".")[0]));
  const parents = (turnEvidence?.snippets ?? []).filter((item) => parentIds.has(item.span_id));
  const atomicSpans = sentenceSpans(parents);
  const snippets = atomicSpans.filter((item) => supportIds.has(item.span_id)).map((item) => ({
    span_id: item.span_id,
    role: item.role,
    text: clip(item.text, 2_500),
    text_hash: `sha256:${sha256(item.text)}`
  }));
  const events = (turnEvidence?.events ?? []).filter((item) => supportIds.has(item.event_id));
  const packet = {
    schema: LEARNING_EXTRACTION_PROPOSAL_V1_SCHEMA,
    evidence_schema: TURN_EVIDENCE_V1_SCHEMA,
    tenant_scope: true,
    project_id: turnEvidence?.project_id ?? null,
    session_hash: turnEvidence?.session_hash ?? null,
    turn_hash: turnEvidence?.turn_hash ?? null,
    provider: turnEvidence?.provider ?? null,
    model: turnEvidence?.model ?? null,
    snippets,
    events,
    rule_proposals: (discovery?.review_drafts ?? []).map((item) => ({
      lesson_type: item.observation.lesson_type,
      support_span_ids: item.support_span_ids,
      gaps: item.gaps
    })),
    limits: {
      input_tokens: MEMORY_EXTRACTION_INPUT_TOKEN_LIMIT,
      output_tokens: MEMORY_EXTRACTION_OUTPUT_TOKEN_LIMIT,
      candidates: MEMORY_EXTRACTION_MAX_CANDIDATES,
      calls: 1
    }
  };
  return { ...packet, packet_hash: `sha256:${sha256(stableJson(packet))}` };
}
