import { collectCoverageReviewSignals, annotateCoverageReviewSignals } from "./coverage-review-signals.mjs";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
  normalizeMemoryPaths,
  screenSensitiveMemory
} from "../../../shared/src/memory-capture-v2-runtime.mjs";
import { normalizeMemoryContractV2Event } from "../../../shared/src/memory-contract-v2-runtime.mjs";
import { stripMemoryCitationBlocks } from "../../../shared/src/memory-extraction-review-text-runtime.mjs";
import {
  buildMemoryExtractionPrompt,
  memoryExtractionProviderInputUpperBound,
  packMemoryExtractionSnippets
} from "../../../shared/src/memory-extraction-provider-contract-runtime.mjs";
import {
  buildCoverageEvidenceGroups,
  MEMORY_EXTRACTION_COVERAGE_PROFILE,
  MEMORY_EXTRACTION_REFINED_PROFILE,
  packCoverageGroups,
  selectCoverageEvidence
} from "../../../shared/src/memory-extraction-coverage-runtime.mjs";
import { packV3Evidence } from "../../../shared/src/memory-extraction-v3-packing.mjs";
import { MEMORY_EXTRACTION_ROUTER_MODEL_V2 } from "./memory-extraction-router-model-v2.mjs";
import { MEMORY_EXTRACTION_ROUTER_MODEL_V3 } from "./memory-extraction-router-model-v3.mjs";
import { explicitUserDecisionSpans, isExplicitUserDecisionText, isInjectedUserContextText } from "./explicit-user-decision-search.mjs";

export const TURN_EVIDENCE_V1_SCHEMA = "turn-evidence/v1";
export const LEARNING_EXTRACTION_PROPOSAL_V1_SCHEMA = "learning-extraction-proposal/v1";
export const LEARNING_EXTRACTION_PROPOSAL_V2_SCHEMA = "learning-extraction-proposal/v2";
export const LEARNING_EXTRACTION_PROPOSAL_V3_SCHEMA = "learning-extraction-proposal/v3";
export const MEMORY_EXTRACTION_ROUTER_V1 = "memory-extraction-router/v1";
export const MEMORY_EXTRACTION_ROUTER_V2 = "memory-extraction-router/v2";
export const MEMORY_EXTRACTION_ROUTER_V3 = "memory-extraction-router/v3";
export const MEMORY_EXTRACTION_INPUT_TOKEN_LIMIT = 2_000;
export const MEMORY_EXTRACTION_OUTPUT_TOKEN_LIMIT = 800;
export const MEMORY_EXTRACTION_MAX_CANDIDATES = 3;

const MAX_TRANSCRIPT_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TURN_BYTES = 8 * 1024 * 1024;

const DECISION_SIGNAL = /\b(?:decid(?:e|ed)|adopt(?:ed)?|choose|chose|selected|standardize|switch(?:ed)?\s+to|(?:I|we)\s+(?:will|'ll)\s+(?:use|choose|pick|adopt|go\s+with)|will use|must use)\b|(?:決定|採用|選択|選定)(?:した|する|します|しました)|方針(?:とする|にした)|統一(?:する|した|します|しました)|切り替え(?:る|た|ます|ました)|(?:に|で|と)(?:し(?:た|ます|ました)|進め(?:る|ます|ました)|いき(?:ます|ました)|しておき(?:ます|ました))|これで進める/iu;
const TRANSIENT_CHOICE = /(?:今回だけ|このターン|一時的|ひとまず|今だけ|for now|this time|temporary|one[- ]off)/iu;
const DURABLE_SCOPE = /\b(?:implementation|architecture|api|schema|policy|governance|repository|project|organization|tenant|default|rule)\b|(?:実装|設計|API|スキーマ|方針|ルール|規約|組織|テナント|プロジェクト|既定|デフォルト)/iu;
const FAILURE_SIGNAL = /\b(?:fail(?:ed|ure)?|error|regression|timed? out|did not work|broken|root cause)\b|(?:失敗|エラー|不具合|回帰|動かな(?:い|かった)|原因|タイムアウト)/iu;
const CORRECTION_SIGNAL = /\b(?:fix(?:ed)?|correct(?:ed|ion)?|changed?|switch(?:ed)?|retry|retract(?:ed)?|withdraw|workaround|prevent(?:ed)?|instead|must not|never|except|unless|prohibit(?:ed)?)\b|(?:違います|そうではなく|ではなく|修正|訂正|変更|撤回|取り下げ|切り替え|対処|解消|回避|再実行|やり直|再発防止|禁止|例外|ただし)/iu;
const SUCCESS_SIGNAL = /\b(?:pass(?:ed)?|succeed(?:ed)?|success|resolved|verified|exit[_ ]?code\s*[=:]?\s*0|2\d\d)\b|(?:成功|通った|解消|確認(?:した|できた|済み)|検証済み|終了コード\s*0)/iu;
const REASON_SIGNAL = /\b(?:because|since|reason|root cause|caused by)\b|(?:理由|なぜなら|原因)/iu;
const REUSE_SIGNAL = /\b(?:when|whenever|next time|reuse|avoid)\b|(?:場合|次回|再利用|回避策|再発時)/iu;
const PREFERENCE_SIGNAL = /\b(?:prefer|preference|always use|default to)\b|(?:好む|希望|優先する|既定(?:にする|とする)|デフォルト(?:にする|とする))/iu;
const CONSTRAINT_SIGNAL = /\b(?:must|never|do not|don't|prohibited|required|only)\b|(?:必ず|必須|禁止|してはいけない|しないこと|のみ許可|対象外)/iu;
const PROPOSAL_ONLY_SIGNAL = /\b(?:suggest|proposal|propose|consider|might|could)\b|(?:提案|検討|候補|かもしれない|するとよい)/iu;
const OPERATIONAL_SIGNAL = /\b(?:implemented|completed|done|passed|verified|deployed|build|test|lint|format|status|current)\b|(?:実装(?:した|しました)|完了|対応済み|成功|通った|検証済み|ビルド|テスト|現在値|対象ファイル)/iu;
const STRUCTURAL_NOISE = /^(?:[-*+]|\d+[.)])?\s*(?:対象ファイル|files?|paths?|tags?|model|session|turn|case)\s*:?\s*$/iu;
const STRUCTURAL_BLOCK = /^\s*<(?:skill|environment_context|recommended_plugins|app-context|permissions|INSTRUCTIONS)(?:\s|>)/iu;
const REVIEW_REQUEST = /\b(?:review|score|audit)\b|(?:レビュー|評価|採点|監査して)/iu;
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

function coverageToolResultText(raw) {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return value; }
  }
  const strings = [];
  const visit = (item, key = "", depth = 0) => {
    if (depth > 4 || item === null || item === undefined) return;
    if (typeof item === "string") {
      if (["summary", "message", "text", "stdout", "stderr", "output"].includes(key)) strings.push(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item.slice(0, 16)) visit(child, key, depth + 1);
      return;
    }
    if (typeof item !== "object") return;
    for (const [childKey, child] of Object.entries(item)) visit(child, childKey, depth + 1);
  };
  visit(value);
  return [...new Set(strings.map((item) => item.trim()).filter(Boolean))].join("\n");
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

function patchPaths(argumentsValue) {
  let value = argumentsValue;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { /* A raw patch is also valid. */ }
  }
  const patch = typeof value === "string" ? value : value?.patch ?? value?.input ?? "";
  if (typeof patch !== "string") return [];
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete|Move to) File:\s*(.+)$/gmu)]
    .map((match) => match[1].trim().replaceAll("\\", "/"));
}

function fileToolPaths(row) {
  const payload = rowPayload(row);
  const invocation = payload?.invocation && typeof payload.invocation === "object" ? payload.invocation : {};
  const name = String(invocation.tool ?? invocation.name ?? payload?.name ?? payload?.tool_name ?? "");
  if (!/(?:^|\.)apply_patch$/u.test(name)) return [];
  return patchPaths(invocation.arguments ?? invocation.input ?? payload?.arguments ?? payload?.input ?? payload?.params);
}

function globMatches(value, pattern) {
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    if (value === base || value.startsWith(`${base}/`)) return true;
  }
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; }
      else { expression += ".*"; index += 1; }
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${expression}$`, "u").test(value);
}

async function captureExclusionPolicy(workspaceRoot) {
  const empty = { exclude_paths: [], include_paths: [] };
  if (!workspaceRoot) return empty;
  const file = path.join(workspaceRoot, ".orgbrain", "capture-exclusions.json");
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return empty;
    throw error;
  }
  if (Buffer.byteLength(raw) > 16_384) throw new Error("capture_exclusions_too_large");
  let policy;
  try { policy = JSON.parse(raw); } catch { throw new Error("capture_exclusions_invalid"); }
  const validPatterns = (items) => Array.isArray(items) && items.length <= 64
    && items.every((item) => typeof item === "string" && item && !item.startsWith("/")
      && !item.includes("..") && !item.includes("\\"));
  if (policy?.version !== 1 || !validPatterns(policy.exclude_paths)
    || !validPatterns(policy.include_paths ?? [])) {
    throw new Error("capture_exclusions_invalid");
  }
  return { exclude_paths: policy.exclude_paths, include_paths: policy.include_paths ?? [] };
}

function excludedFilePath(filePath, policy, workspaceRoot) {
  let normalized = filePath.replace(/^\.\//u, "").replaceAll("\\", "/");
  if (normalized.startsWith("/") && workspaceRoot) {
    normalized = path.relative(workspaceRoot, normalized).replaceAll("\\", "/");
  }
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return true;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".ssh" || segment === "secrets" || segment === ".env" || segment.startsWith(".env."))) return true;
  if (/\.(?:key|pem|p12|pfx)$/iu.test(normalized)) return true;
  if (policy.include_paths.length > 0 && !policy.include_paths.some((pattern) => globMatches(normalized, pattern))) return true;
  return policy.exclude_paths.some((pattern) => globMatches(normalized, pattern));
}

function toolCallFromRow(row, workspaceRoot) {
  const payload = rowPayload(row);
  const type = payload?.type;
  if (!["function_call", "custom_tool_call", "mcp_tool_call", "mcp_tool_call_end"].includes(type)) return null;
  const invocation = payload.invocation && typeof payload.invocation === "object" ? payload.invocation : {};
  const name = clip(invocation.tool ?? invocation.name ?? payload.name ?? payload.tool_name ?? payload.server ?? "tool", 128);
  const effectiveArguments = invocation.arguments ?? invocation.input ?? payload.arguments ?? payload.input ?? payload.params ?? {};
  const effectiveResult = invocation.result ?? payload.result;
  const changedPaths = /(?:^|\.)apply_patch$/u.test(name)
    ? patchPaths(effectiveArguments)
        .map((item) => workspaceRoot && item.startsWith("/") ? path.relative(workspaceRoot, item) : item)
        .map((item) => clip(item, 512))
        .filter((path) => path && !path.startsWith("/") && !path.split("/").includes(".."))
        .slice(0, 32)
    : [];
  return {
    call_id: String(payload.call_id ?? payload.id ?? sha256(stableJson(payload)).slice(0, 24)),
    type: name === "request_user_input"
      ? "user_input_request"
      : /(?:^|\.)apply_patch$/u.test(name)
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
  let structured = output && typeof output === "object" ? output : null;
  if (!structured && typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      structured = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      structured = null;
    }
  }
  const exitMatch = serialized.match(/(?:exit[_ ]?code|status)\s*[=:]\s*(-?\d{1,3})/iu);
  const httpMatch = serialized.match(/\bHTTP\/?\d(?:\.\d)?\s+(\d{3})\b/iu);
  const exitCode = Number.isInteger(payload.exit_code) ? payload.exit_code : Number.isInteger(structured?.exit_code) ? structured.exit_code : exitMatch ? Number(exitMatch[1]) : null;
  const httpStatus = Number.isInteger(payload.http_status) ? payload.http_status : Number.isInteger(structured?.http_status) ? structured.http_status : httpMatch ? Number(httpMatch[1]) : null;
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
      source: snippet.source,
      call_id: snippet.call_id,
      source_order: snippet.source_order,
      review_signal_score: snippet.review_signal_score ?? 0,
      review_signal_reasons: snippet.review_signal_reasons ?? [],
      context_only: snippet.context_only === true || snippet.role === "user" && isInjectedUserContextText(snippet.text),
      text: clip(text, 1_000)
    }))
    .filter((item) => item.text.length >= (item.source === "tool_result" ? 4 : 8)));
}

export function sentenceSpansV3(snippets) {
  let order = 0;
  const seen = new Map();
  return snippets.flatMap((snippet) => {
    const spans = [];
    const pattern = /[^。！？.!?\n]+(?:[。！？.!?]+|$)|[^\n]+$/gu;
    for (const match of snippet.text.matchAll(pattern)) {
      const text = match[0].trim();
      if (!text) continue;
      const start = match.index + match[0].indexOf(text);
      const span = { span_id: `${snippet.span_id}@${start}:${start + text.length}`, parent_span_id: snippet.span_id,
        role: snippet.role, context_only: snippet.context_only === true || snippet.role === "user" && isInjectedUserContextText(snippet.text), start, end: start + text.length, text, order: order++, aliases: [] };
      const key = `${span.context_only}:${span.role}:${text.replace(/\s+/gu, " ")}`;
      if (seen.has(key)) { seen.get(key).aliases.push(span.span_id); continue; }
      seen.set(key, span);
      spans.push(span);
    }
    return spans;
  });
}

function uniqueReasonCodes(values) {
  return [...new Set(values.filter(Boolean))];
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function linearProbability(features, model) {
  const score = model.feature_names.reduce((total, name, index) =>
    total + (model.weights[index] ?? 0) * (features[name] ?? 0), model.intercept);
  return { score, probability: sigmoid(score) };
}

function findVerifiedRecoveryEvent(events, failedEvent) {
  if (!failedEvent) return null;
  const failedIndex = events.indexOf(failedEvent);
  if (failedIndex < 0 || !failedEvent.name || !failedEvent.argument_hash) return null;
  return events.find((event, index) => index > failedIndex
    && event.status === "completed"
    && event.name === failedEvent.name
    && event.argument_hash === failedEvent.argument_hash
    && (event.exit_code === 0 || event.http_status >= 200 && event.http_status < 300)) ?? null;
}

function routerContext(turnEvidence, v3 = false) {
  const routingSnippets = [
    ...(turnEvidence?.context_snippets ?? []).map((snippet) => ({ ...snippet, context_only: true })),
    ...(turnEvidence?.snippets ?? []).map((snippet) => ({ ...snippet, context_only: snippet.context_only === true }))
  ].filter((snippet) => !STRUCTURAL_BLOCK.test(snippet.text));
  const spans = v3 ? sentenceSpansV3(routingSnippets) : sentenceSpans(routingSnippets);
  const events = turnEvidence?.events ?? [];
  const meaningful = spans.filter((span) => span.text.length >= 8 && !STRUCTURAL_NOISE.test(span.text));
  const supportable = meaningful.filter((span) => !span.context_only);
  const userSpans = meaningful.filter((span) => span.role === "user");
  const explicitDecisionSearchSpans = explicitUserDecisionSpans(supportable);
  const allText = meaningful.map((span) => span.text).join("\n");
  const userText = userSpans.map((span) => span.text).join("\n");
  const reviewSignals = Array.isArray(turnEvidence?.review_diagnostics?.signals)
    ? turnEvidence.review_diagnostics.signals
    : [];
  const hasReviewSignal = (reason) => reviewSignals.some((signal) => signal.reason === reason);
  const humanCorrection = hasReviewSignal("human_correction_or_interruption");
  const failed = FAILURE_SIGNAL.test(allText) || events.some((event) => event.status === "failed");
  const failedEvent = events.find((event) => event.status === "failed") ?? null;
  const verifiedRecoveryEvent = findVerifiedRecoveryEvent(events, failedEvent);
  const corrected = CORRECTION_SIGNAL.test(allText) || humanCorrection;
  const verified = SUCCESS_SIGNAL.test(allText) || events.some((event) =>
    event.status === "completed" && (event.exit_code === 0 || event.http_status >= 200 && event.http_status < 300));
  const explicitDecision = (explicitDecisionSearchSpans.length > 0
    || DECISION_SIGNAL.test(userText)
    || (DECISION_SIGNAL.test(allText) && DURABLE_SCOPE.test(allText)))
    && !TRANSIENT_CHOICE.test(allText);
  const preference = PREFERENCE_SIGNAL.test(allText);
  const constraint = CONSTRAINT_SIGNAL.test(allText);
  const explicitUserAdoption = explicitDecisionSearchSpans.length > 0
    || DECISION_SIGNAL.test(userText)
    || PREFERENCE_SIGNAL.test(userText)
    || CONSTRAINT_SIGNAL.test(userText);
  const reusable = REUSE_SIGNAL.test(allText) || (REASON_SIGNAL.test(allText) && corrected);
  const proposalOnly = PROPOSAL_ONLY_SIGNAL.test(allText)
    && !verified && !corrected && !explicitDecision && !preference && !constraint;
  const reviewOnly = REVIEW_REQUEST.test(userText) && !explicitUserAdoption;
  const eventCompleted = events.some((event) => event.status === "completed");
  const operational = verified || OPERATIONAL_SIGNAL.test(allText)
    || events.some((event) => event.type === "file_change" || event.status === "completed");
  const operationalSpans = meaningful.filter((span) => OPERATIONAL_SIGNAL.test(span.text) || SUCCESS_SIGNAL.test(span.text));
  const structuralNoiseCount = spans.filter((span) => STRUCTURAL_NOISE.test(span.text)).length;
  const durableSignalCount = [explicitDecision, preference, constraint, failed && corrected, reusable, DURABLE_SCOPE.test(allText)]
    .filter(Boolean).length;
  const features = {
    negated_adoption: /(?:採用|選択|決定).{0,8}(?:しない|しません|未定)|(?:do not|not).{0,10}(?:adopt|select|decide)/iu.test(userText) ? 1 : 0,
    ordered_causal_chain: meaningful.some((_, index) => /(?:失敗|エラー|failure|error)[\s\S]*?(?:修正|対処|fix|correct)[\s\S]*?(?:検証|成功|verified|passed)/iu.test(meaningful.slice(index, index + 4).map((span) => span.text).join("\n"))) ? 1 : 0,
    adopted_durable: explicitUserAdoption && DURABLE_SCOPE.test(userText) ? 1 : 0,
    transient_durable: TRANSIENT_CHOICE.test(allText) && DURABLE_SCOPE.test(allText) ? 1 : 0,
    assistant_proposal_unadopted: !explicitUserAdoption && meaningful.some((span) => span.role === "assistant" && PROPOSAL_ONLY_SIGNAL.test(span.text)) ? 1 : 0
  };
  return {
    spans,
    events,
    meaningful,
    supportable,
    allText,
    userText,
    signals: {
      failed,
      corrected,
      verified,
      explicitDecision,
      explicitDecisionSearch: explicitDecisionSearchSpans.length > 0,
      explicitDecisionSearchSpans,
      preference,
      constraint,
      explicitUserAdoption,
      reusable,
      proposalOnly,
      reviewOnly,
      humanCorrection,
      repeatedToolFailure: hasReviewSignal("repeated_tool_failure"),
      toolRejected: hasReviewSignal("tool_rejected"),
      recallGap: reviewSignals.some((signal) => signal.recall_miss_id),
      verifiedRecovery: Boolean(verifiedRecoveryEvent),
      eventCompleted,
      operational
    },
    features: {
      ...(v3 ? features : {}),
      user_adoption: explicitUserAdoption ? 1 : 0,
      durable_decision: explicitDecision ? 1 : 0,
      preference: preference ? 1 : 0,
      constraint: constraint ? 1 : 0,
      failure_correction: failed && corrected ? 1 : 0,
      durable_scope: DURABLE_SCOPE.test(allText) ? 1 : 0,
      reusable_or_causal: reusable ? 1 : 0,
      verified: verified ? 1 : 0,
      operational_status: OPERATIONAL_SIGNAL.test(allText) ? 1 : 0,
      event_completed: eventCompleted ? 1 : 0,
      proposal_only: proposalOnly ? 1 : 0,
      review_only: reviewOnly ? 1 : 0,
      explicitly_transient: TRANSIENT_CHOICE.test(allText) ? 1 : 0,
      assistant_only: meaningful.length > 0 && userSpans.length === 0 ? 1 : 0,
      span_density: Math.min(meaningful.length, 8) / 8,
      causal_closure: failed && corrected && (features.ordered_causal_chain || Boolean(verifiedRecoveryEvent)) ? 1 : 0,
      user_span_ratio: meaningful.length === 0 ? 0 : userSpans.length / meaningful.length,
      operational_span_ratio: meaningful.length === 0 ? 0 : operationalSpans.length / meaningful.length,
      structural_noise_ratio: spans.length === 0 ? 0 : structuralNoiseCount / spans.length,
      proposal_adoption_gap: proposalOnly && !explicitUserAdoption ? 1 : 0,
      durable_signal_count: durableSignalCount / 6,
      transient_status_combo: TRANSIENT_CHOICE.test(allText) && operational ? 1 : 0,
      ...(v3 ? {
        user_adoption: explicitUserAdoption && !features.negated_adoption ? 1 : 0,
        durable_decision: explicitUserAdoption && !features.negated_adoption && !TRANSIENT_CHOICE.test(userText) && DURABLE_SCOPE.test(userText) ? 1 : 0,
        proposal_only: features.assistant_proposal_unadopted,
        proposal_adoption_gap: features.assistant_proposal_unadopted,
        causal_closure: features.ordered_causal_chain
      } : {})
    }
  };
}

export function extractMemoryRouterFeatures(turnEvidence, options = {}) {
  return routerContext(turnEvidence, options.version === "v3").features;
}

/**
 * A deliberately high-recall, explainable router. It only decides whether an
 * episode is safe to ignore, useful as short-lived history, or worth the one
 * bounded LLM call. Durable kind and persistence actions remain downstream.
 */
function routeTurnEvidenceV2(turnEvidence, options = {}) {
  const model = options.model ?? MEMORY_EXTRACTION_ROUTER_MODEL_V2;
  if (turnEvidence?.hard_exclusion_reason) {
    return {
      schema: MEMORY_EXTRACTION_ROUTER_V2,
      disposition: "hard_excluded",
      reason_codes: [turnEvidence.hard_exclusion_reason],
      support_span_ids: [],
      score: null,
      llm_recommended: false,
      operational_history_recommended: false,
      decisions: { hard_excluded: true, durable_candidate: false, operational_history: false },
      probabilities: { durable_candidate: 0, operational_history: 0 },
      model: { schema: model.schema, training_set: model.training_set }
    };
  }

  const context = routerContext(turnEvidence);
  const { meaningful, supportable, signals, features } = context;
  if (meaningful.length === 0) {
    return {
      schema: MEMORY_EXTRACTION_ROUTER_V2,
      disposition: "discard",
      reason_codes: ["no_meaningful_text"],
      support_span_ids: [],
      score: 0,
      llm_recommended: false,
      operational_history_recommended: false,
      decisions: { hard_excluded: false, durable_candidate: false, operational_history: false },
      probabilities: { durable_candidate: 0, operational_history: 0 },
      model: { schema: model.schema, training_set: model.training_set }
    };
  }
  const durable = linearProbability(features, { ...model.durable_candidate, feature_names: model.feature_names });
  const operational = linearProbability(features, { ...model.operational_history, feature_names: model.feature_names });
  const durableCandidate = signals.explicitDecisionSearch || durable.probability >= model.durable_candidate.threshold;
  const operationalHistory = operational.probability >= model.operational_history.threshold;
  const reasons = routerReasonCodes(context, operationalHistory);

  const durableSupport = supportable.filter((span) =>
    isExplicitUserDecisionText(span.text)
    || DECISION_SIGNAL.test(span.text)
    || PREFERENCE_SIGNAL.test(span.text)
    || CONSTRAINT_SIGNAL.test(span.text)
    || FAILURE_SIGNAL.test(span.text)
    || CORRECTION_SIGNAL.test(span.text)
    || REASON_SIGNAL.test(span.text)
    || REUSE_SIGNAL.test(span.text));
  const operationalSupport = supportable.filter((span) => OPERATIONAL_SIGNAL.test(span.text) || SUCCESS_SIGNAL.test(span.text));
  const selectedSupport = [...new Map([
    ...(durableCandidate ? signals.explicitDecisionSearchSpans : []),
    ...(durableCandidate ? (durableSupport.length > 0 ? durableSupport : supportable) : []),
    ...(operationalHistory ? (operationalSupport.length > 0 ? operationalSupport : supportable) : [])
  ].map((span) => [span.span_id, span])).values()];
  const disposition = durableCandidate ? "llm_candidate" : operationalHistory ? "operational_history" : "discard";
  return {
    schema: MEMORY_EXTRACTION_ROUTER_V2,
    disposition,
    reason_codes: uniqueReasonCodes(disposition === "discard" ? [...reasons, "no_durable_or_operational_signal"] : reasons),
    support_span_ids: selectedSupport.map((span) => span.span_id).slice(0, 8),
    score: durable.score,
    llm_recommended: durableCandidate,
    operational_history_recommended: operationalHistory,
    decisions: { hard_excluded: false, durable_candidate: durableCandidate, operational_history: operationalHistory },
    probabilities: { durable_candidate: durable.probability, operational_history: operational.probability },
    model: { schema: model.schema, training_set: model.training_set }
  };
}

function routerReasonCodes(context, operationalHistory) {
  const { signals, features } = context;
  const reasons = [];
  if (signals.explicitDecision) reasons.push("explicit_user_decision");
  if (signals.explicitDecisionSearch) reasons.push("explicit_user_decision_search");
  if (signals.preference) reasons.push("explicit_user_preference");
  if (signals.constraint) reasons.push("explicit_user_constraint");
  if (features.failure_correction) reasons.push("failure_correction_chain");
  if (features.causal_closure) reasons.push("causal_chain_closed");
  if (features.durable_scope) reasons.push("durable_scope");
  if (signals.reusable) reasons.push("reusable_or_causal");
  if (signals.proposalOnly) reasons.push("proposal_not_adopted");
  if (signals.reviewOnly) reasons.push("review_report_not_adopted");
  if (features.explicitly_transient) reasons.push("explicitly_transient");
  if (signals.humanCorrection) reasons.push("human_correction_or_interruption");
  if (signals.repeatedToolFailure) reasons.push("repeated_tool_failure");
  if (signals.toolRejected) reasons.push("tool_rejected");
  if (signals.recallGap) reasons.push("recall_gap_and_friction");
  if (signals.verifiedRecovery) reasons.push("verified_same_operation_recovery");
  if (operationalHistory) reasons.push(signals.verified ? "verified_current_outcome" : "current_task_status");
  return reasons;
}

function rankedSupport(context, primaryRoute) {
  const scored = context.supportable.map((span, index) => {
    let score = span.role === "user" ? 3 : 0;
    if (primaryRoute === "llm_candidate") {
      if (DECISION_SIGNAL.test(span.text)) score += 6;
      if (isExplicitUserDecisionText(span.text)) score += 8;
      if (PREFERENCE_SIGNAL.test(span.text) || CONSTRAINT_SIGNAL.test(span.text)) score += 5;
      if (FAILURE_SIGNAL.test(span.text) || CORRECTION_SIGNAL.test(span.text)) score += 4;
      if (REASON_SIGNAL.test(span.text) || REUSE_SIGNAL.test(span.text)) score += 3;
      if (DURABLE_SCOPE.test(span.text)) score += 2;
      if (TRANSIENT_CHOICE.test(span.text)) score -= 5;
      if (OPERATIONAL_SIGNAL.test(span.text) && !REASON_SIGNAL.test(span.text)) score -= 1;
    } else if (primaryRoute === "operational_history") {
      if (OPERATIONAL_SIGNAL.test(span.text) || SUCCESS_SIGNAL.test(span.text)) score += 6;
      if (FAILURE_SIGNAL.test(span.text) || CORRECTION_SIGNAL.test(span.text)) score += 2;
      if (TRANSIENT_CHOICE.test(span.text)) score += 1;
    }
    return { span, score, reviewScore: Math.max(0, Number(span.review_signal_score) || 0), index };
  });
  const positive = scored.filter((item) => item.score > 0);
  return (positive.length > 0 ? positive : scored)
    .sort((left, right) => right.score - left.score || right.reviewScore - left.reviewScore || left.index - right.index)
    .slice(0, 8)
    .map((item) => item.span);
}

export function routeTurnEvidenceV3(turnEvidence, options = {}) {
  const model = options.model ?? MEMORY_EXTRACTION_ROUTER_MODEL_V3;
  if (model.schema !== "memory-extraction-router-model/v3") throw new Error("router_model_version_mismatch");
  // Inspect whole, unfiltered current input; normalization is for detection only.
  const raw = (turnEvidence?.snippets ?? []).map((span) => span.text).join("\n").normalize("NFKC").replace(/[\u200b-\u200f\u2060\ufeff]/gu, "");
  const unsafe = /(?:sk-proj-|ghp_)[A-Za-z0-9_]{16,}/u.test(raw) ? "secret_detected"
    : /[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(raw) ? "direct_pii_detected"
      : UNSAFE_SIGNAL.test(raw) || /(?:ignore|disregard|override)[\s\S]{0,45}(?:previous|prior|system|developer|security)|(?:reveal|print|exfiltrate)[\s\S]{0,30}(?:secret|credential|system prompt)|(?:システム.{0,8}指示|安全検査).{0,12}(?:無視|無効化)/iu.test(raw) ? "prompt_injection_detected" : null;
  if (unsafe && !turnEvidence.hard_exclusion_reason) turnEvidence = { ...turnEvidence, hard_exclusion_reason: unsafe };
  if (turnEvidence?.hard_exclusion_reason) {
    return {
      schema: MEMORY_EXTRACTION_ROUTER_V3,
      primary_route: "hard_excluded",
      disposition: "hard_excluded",
      reason_codes: [turnEvidence.hard_exclusion_reason],
      support_span_ids: [],
      score: null,
      llm_recommended: false,
      operational_history_recommended: false,
      decisions: { hard_excluded: true, durable_candidate: false, operational_history: false },
      probabilities: { durable_candidate: 0, operational_history: null },
      model: { schema: model.schema, training_set: model.training_set }
    };
  }
  if (model.training_set === "bootstrap-unfitted") throw new Error("memory_extraction_router_v3_unfitted");
  const context = routerContext(turnEvidence, model.feature_revision === "v3.1");
  if (context.supportable.length === 0) {
    return {
      schema: MEMORY_EXTRACTION_ROUTER_V3,
      primary_route: "discard",
      disposition: "discard",
      reason_codes: ["no_meaningful_text"],
      support_span_ids: [],
      score: 0,
      llm_recommended: false,
      operational_history_recommended: false,
      decisions: { hard_excluded: false, durable_candidate: false, operational_history: false },
      probabilities: { durable_candidate: 0, operational_history: 0 },
      model: { schema: model.schema, training_set: model.training_set }
    };
  }
  const durable = linearProbability(context.features, { ...model.durable_candidate, feature_names: model.feature_names });
  const durableCandidate = context.signals.explicitDecisionSearch || durable.probability >= model.durable_candidate.threshold;
  const operational = durableCandidate
    ? null
    : linearProbability(context.features, { ...model.operational_history, feature_names: model.feature_names });
  const operationalHistory = !durableCandidate && operational.probability >= model.operational_history.threshold;
  const primaryRoute = durableCandidate ? "llm_candidate" : operationalHistory ? "operational_history" : "discard";
  const reasons = routerReasonCodes(context, operationalHistory);
  const support = primaryRoute === "discard" ? [] : [...new Map([
    ...context.signals.explicitDecisionSearchSpans,
    ...rankedSupport({ ...context,
      supportable: sentenceSpansV3(turnEvidence.snippets ?? []).filter((span) => !span.context_only && !STRUCTURAL_BLOCK.test(span.text)) }, primaryRoute)
  ].map((span) => [span.span_id, span])).values()].slice(0, 8);
  return {
    schema: MEMORY_EXTRACTION_ROUTER_V3,
    primary_route: primaryRoute,
    disposition: primaryRoute,
    reason_codes: uniqueReasonCodes(primaryRoute === "discard" ? [...reasons, "no_durable_or_operational_signal"] : reasons),
    support_span_ids: support.map((span) => span.span_id),
    score: durable.score,
    llm_recommended: durableCandidate,
    operational_history_recommended: operationalHistory,
    decisions: { hard_excluded: false, durable_candidate: durableCandidate, operational_history: operationalHistory },
    probabilities: { durable_candidate: durable.probability, operational_history: operational?.probability ?? null },
    model: { schema: model.schema, training_set: model.training_set }
  };
}

export function routeTurnEvidence(turnEvidence, options = {}) {
  const model = options.model ?? (options.version === "v3" ? MEMORY_EXTRACTION_ROUTER_MODEL_V3 : MEMORY_EXTRACTION_ROUTER_MODEL_V2);
  if (options.version && model.schema !== `memory-extraction-router-model/${options.version}`) throw new Error("router_model_version_mismatch");
  return model?.schema === "memory-extraction-router-model/v3" || options.version === "v3"
    ? routeTurnEvidenceV3(turnEvidence, { ...options, model })
    : routeTurnEvidenceV2(turnEvidence, { ...options, model });
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
  const exclusionPatterns = await captureExclusionPolicy(options.workspace_root);
  const snippets = [];
  const eligibleRows = [];
  const excludedCallIds = new Set();
  const snippetAliases = {};
  const messageSpanByKey = new Map();
  const eventsByCall = new Map();
  let messageSpanIndex = 0;
  let toolSpanIndex = 0;
  let provider = clip(input?.provider, 64) || null;
  let model = clip(input?.model, 128) || null;
  let hardExclusion = null;

  for (const [sourceOrder, row] of rows.entries()) {
    const payload = rowPayload(row);
    const callId = String(payload?.call_id ?? payload?.id ?? "");
    if (callId && excludedCallIds.has(callId)) continue;
    if (fileToolPaths(row).some((filePath) => excludedFilePath(filePath, exclusionPatterns, options.workspace_root))) {
      if (callId) excludedCallIds.add(callId);
      continue;
    }
    eligibleRows.push(row);
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
        messageSpanIndex += 1;
        const spanId = `s${messageSpanIndex}`;
        const stripped = stripMemoryCitationBlocks(screened.text);
        const text = options.preserve_snippet_text === true ? stripped.trim() : clip(stripped, 4_000);
        if (!text) continue;
        const messageKey = `${message.role}\0${text}`;
        const existingSpanId = messageSpanByKey.get(messageKey);
        if (existingSpanId) {
          snippetAliases[spanId] = existingSpanId;
          continue;
        }
        messageSpanByKey.set(messageKey, spanId);
        snippets.push({
          span_id: spanId,
          source_order: sourceOrder,
          role: message.role,
          kind: message.role === "assistant" ? "assistant_final" : "user_message",
          text,
          text_hash: `sha256:${sha256(text)}`
        });
      }
    }

    const call = toolCallFromRow(row, options.workspace_root);
    if (call) eventsByCall.set(call.call_id, { ...eventsByCall.get(call.call_id), ...call });
    const result = toolResultFromRow(row);
    if (options.preserve_snippet_text === true && (result || payload?.type === "mcp_tool_call_end")) {
      const toolCallId = result?.call_id ?? call?.call_id;
      const rawResult = payload.output ?? payload.result ?? payload.content;
      const normalized = normalizeMemoryPaths(coverageToolResultText(rawResult), options.workspace_root ?? null);
      const screened = screenSensitiveMemory(normalized, options.sensitive_policy);
      if (!screened.allowed || UNSAFE_SIGNAL.test(normalized)) { hardExclusion = screened.reason ?? "unsafe_instruction"; break; }
      if (toolCallId && screened.text.trim() && !snippets.some((snippet) => snippet.call_id === toolCallId)) {
        toolSpanIndex += 1;
        const text = screened.text.trim();
        snippets.push({ span_id: `t${toolSpanIndex}`, source_order: sourceOrder, role: "tool", source: "tool_result", call_id: toolCallId,
          kind: "tool_result", text, text_hash: `sha256:${sha256(text)}` });
      }
    }
    if (result) eventsByCall.set(result.call_id, { ...eventsByCall.get(result.call_id), ...result });
  }

  const events = [...eventsByCall.values()].map((event, index) => ({
    event_id: `e${index + 1}`,
    call_id: event.call_id,
    type: event.type ?? "tool_execution",
    name: event.name ?? "tool",
    status: event.status ?? "unknown",
    argument_hash: event.argument_hash ?? null,
    result_hash: event.result_hash ?? null,
    exit_code: event.exit_code ?? null,
    http_status: event.http_status ?? null,
    changed_paths: event.changed_paths ?? []
  }));
  const retainedSnippetLimit = options.preserve_snippet_text === true ? snippets.length : 8;
  const retainedSnippets = hardExclusion ? [] : snippets.slice(0, retainedSnippetLimit);
  const retainedSpanIds = new Set(retainedSnippets.map((snippet) => snippet.span_id));
  const retainedAliases = Object.fromEntries(Object.entries(snippetAliases)
    .filter(([alias, target]) => Number(alias.slice(1)) <= retainedSnippetLimit && retainedSpanIds.has(target)));
  const reviewDiagnostics = hardExclusion
    ? { schema: "coverage-review-signals/v1", recall_hits: 0, recall_misses: 0, signals: [] }
    : collectCoverageReviewSignals(eligibleRows, input?.project_id);
  const turnEvidence = {
    schema: TURN_EVIDENCE_V1_SCHEMA,
    session_hash: input?.session_hash ?? null,
    turn_hash: input?.turn_hash ?? null,
    project_id: input?.project_id ?? null,
    provider,
    model,
    snippets: annotateCoverageReviewSignals(retainedSnippets, reviewDiagnostics),
    ...(!hardExclusion ? { review_diagnostics: reviewDiagnostics } : {}),
    snippet_aliases: hardExclusion ? {} : retainedAliases,
    events: hardExclusion ? [] : events.slice(0, 24),
    hard_exclusion_reason: hardExclusion,
    raw_transcript_persisted: false,
    reasoning_included: false,
    absolute_paths_included: false
  };
  return { ...turnEvidence, evidence_hash: `sha256:${sha256(stableJson(turnEvidence))}` };
}

export async function discoverLearningEpisodes(turnEvidence, options = {}) {
  const routing = routeTurnEvidence(turnEvidence, { model: options.router_model, version: options.router_version });
  if (routing.decisions.hard_excluded) {
    return {
      drafts: [],
      review_drafts: [],
      excluded: [{ reason: turnEvidence.hard_exclusion_reason, disposition: "hard_excluded" }],
      no_candidate: false,
      llm_recommended: false,
      routing,
      operational_history: null
    };
  }
  const spans = routing.schema === MEMORY_EXTRACTION_ROUTER_V3 ? sentenceSpansV3(turnEvidence?.snippets ?? []) : sentenceSpans(turnEvidence?.snippets ?? []);
  const events = turnEvidence?.events ?? [];
  const proposals = [];

  const failure = firstMatch(spans, FAILURE_SIGNAL);
  const failureIndex = findIndex(spans, failure);
  const correction = firstMatch(spans, CORRECTION_SIGNAL, failureIndex);
  const correctionIndex = findIndex(spans, correction);
  const textualSuccess = spans.find((span, index) => index > failureIndex && SUCCESS_SIGNAL.test(span.text)) ?? null;
  const failedEvent = events.find((event) => event.status === "failed") ?? null;
  const successfulEvent = findVerifiedRecoveryEvent(events, failedEvent);
  if ((failure || failedEvent) && (correction || successfulEvent)) {
    const support = [failure, correction, textualSuccess].filter(Boolean);
    const fields = {
      symptom: failure?.text ?? null,
      failed_approach: null,
      root_cause: clause(spans, REASON_SIGNAL),
      correction: correction?.text ?? null,
      verified_outcome: textualSuccess?.text ?? (successfulEvent ? `${successfulEvent.name} completed successfully after the failed attempt.` : null),
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
    ], ["episode_failure_detected", ...(successfulEvent ? ["verified_same_operation_recovery"] : [])], options);
    if (proposal) proposals.push(proposal);
  }

  const searchedDecision = explicitUserDecisionSpans(spans)[0] ?? null;
  const decision = searchedDecision
    ?? spans.find((span) => DECISION_SIGNAL.test(span.text) && !TRANSIENT_CHOICE.test(span.text) && DURABLE_SCOPE.test(span.text));
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
    const proposal = await normalizeProposal(observation, [decision.span_id], [
      "episode_decision_detected",
      ...(searchedDecision ? ["explicit_user_decision_search"] : []),
      "inferred_unconfirmed"
    ], options);
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
  const routedSpans = new Set(routing.support_span_ids);
  const operationalText = routing.decisions.operational_history
    ? spans.filter((span) => routedSpans.has(span.span_id)).map((span) => span.text).join(" ").slice(0, 1_000)
    : "";
  return {
    drafts: [],
    review_drafts: routing.decisions.durable_candidate ? reviewDrafts : [],
    excluded: routing.disposition === "discard"
      ? routing.reason_codes.map((reason) => ({ reason, disposition: "filtered" }))
      : [],
    no_candidate: routing.disposition === "discard",
    llm_recommended: routing.llm_recommended,
    routing,
    operational_history: routing.decisions.operational_history && operationalText
      ? {
          kind: "episodic",
          content: operationalText,
          summary: operationalText.slice(0, 240),
          support_span_ids: routing.support_span_ids,
          expires_in_days: 30,
          reason_codes: routing.reason_codes
        }
      : null
  };
}

export function buildLearningExtractionPacket(turnEvidence, discovery, options = {}) {
  if (options.refinement_profile !== undefined && options.refinement_profile !== MEMORY_EXTRACTION_REFINED_PROFILE) throw new Error("unsupported_refinement_profile");
  if (options.refinement_profile && (options.extraction_profile || discovery?.routing?.schema === MEMORY_EXTRACTION_ROUTER_V3)) {
    throw new Error("a_plus_requires_one_call_v2");
  }
  if (discovery?.routing?.schema === MEMORY_EXTRACTION_ROUTER_V3) return buildV3Packet(turnEvidence, discovery);
  const coverage = options.extraction_profile === MEMORY_EXTRACTION_COVERAGE_PROFILE;
  const refined = options.refinement_profile === MEMORY_EXTRACTION_REFINED_PROFILE;
  const supportIds = new Set([
    ...(discovery?.routing?.support_span_ids ?? []),
    ...(discovery?.review_drafts ?? []).flatMap((item) => item.support_span_ids ?? [])
  ]);
  const parentIds = new Set([...supportIds].map((id) => String(id).split(".")[0]));
  const sourceSnippets = turnEvidence?.snippets ?? [];
  const refinedDecisionParents = refined
    ? sourceSnippets.filter((snippet) => snippet.role === "user" && snippet.context_only !== true && isExplicitUserDecisionText(snippet.text))
    : [];
  const refinedDecisionAssistantParents = refinedDecisionParents.flatMap((decision) => {
    const following = sourceSnippets.find((snippet) => snippet.role === "assistant"
      && Number.isFinite(snippet.source_order) && Number.isFinite(decision.source_order)
      && snippet.source_order > decision.source_order);
    const fallback = [...sourceSnippets].reverse().find((snippet) => snippet.role === "assistant");
    return following ? [following] : fallback ? [fallback] : [];
  });
  const refinedDecisionParentIds = new Set([...refinedDecisionParents, ...refinedDecisionAssistantParents].map((item) => item.span_id));
  const failedCallIds = new Set((turnEvidence?.events ?? []).filter((event) => event.status === "failed").map((event) => event.call_id).filter(Boolean));
  const completedCallIds = new Set((turnEvidence?.events ?? []).filter((event) => event.status === "completed").map((event) => event.call_id).filter(Boolean));
  const refinedFailureContext = refined && failedCallIds.size > 0 && completedCallIds.size > 0
    && sourceSnippets.some((snippet) => snippet.role === "user"
      && (CORRECTION_SIGNAL.test(snippet.text) || (snippet.review_signal_reasons ?? []).includes("human_correction_or_interruption")));
  const supportParents = sourceSnippets.filter((item) => parentIds.has(item.span_id) && Number.isFinite(item.source_order));
  const supportOrders = supportParents.map((item) => item.source_order);
  const precedingUserOrders = supportParents.filter((item) => item.role === "assistant").flatMap((item) => {
    const preceding = sourceSnippets.filter((candidate) => candidate.role === "user" && Number.isFinite(candidate.source_order) && candidate.source_order < item.source_order).at(-1);
    return preceding ? [preceding.source_order] : [];
  });
  const supportOrderRange = supportOrders.length > 0 ? [Math.min(...supportOrders, ...precedingUserOrders), Math.max(...supportOrders)] : null;
  const supportedCallIds = new Set(refined ? (turnEvidence?.events ?? [])
    .filter((event) => supportIds.has(event.event_id))
    .map((event) => event.call_id)
    .filter(Boolean) : []);
  const parents = (turnEvidence?.snippets ?? []).filter((item) => parentIds.has(item.span_id)
    || refinedDecisionParentIds.has(item.span_id)
    || refined && item.source === "tool_result" && (supportedCallIds.has(item.call_id)
      || supportOrderRange && item.source_order >= supportOrderRange[0] && item.source_order <= supportOrderRange[1])
    || refinedFailureContext && item.source === "tool_result" && (failedCallIds.has(item.call_id) || completedCallIds.has(item.call_id))
    || refined && item.role === "user" && supportOrderRange && item.source_order >= supportOrderRange[0] && item.source_order <= supportOrderRange[1]);
  const atomicSpans = sentenceSpans(parents);
  const effectiveSupportIds = new Set([...supportIds, ...(refined ? atomicSpans.filter((span) => span.source === "tool_result"
    || span.role === "user" || refinedDecisionParentIds.has(String(span.span_id).split(".")[0])).map((span) => span.span_id) : [])]);
  const rankedIds = new Map((discovery?.routing?.support_span_ids ?? []).map((id, index) => [id, index]));
  const rankedCandidates = atomicSpans
    .filter((span) => effectiveSupportIds.has(span.span_id))
    .sort((left, right) => (rankedIds.get(left.span_id) ?? 99) - (rankedIds.get(right.span_id) ?? 99))
    .map((span, legacyRank) => ({ ...span, legacy_rank: legacyRank }));
  const failureEpisodeCandidates = refined ? [...rankedCandidates]
    .filter((span) => span.source === "tool_result" && failedCallIds.has(span.call_id))
    .sort((left, right) => (right.source_order ?? -1) - (left.source_order ?? -1))
    .flatMap((failedSpan) => {
      const completedSpan = rankedCandidates
        .filter((span) => span.source === "tool_result" && completedCallIds.has(span.call_id)
          && Number.isFinite(span.source_order) && span.source_order > failedSpan.source_order)
        .sort((left, right) => left.source_order - right.source_order)[0];
      if (!completedSpan) return [];
      const correctionSpan = rankedCandidates
        .filter((span) => span.role === "user" && Number.isFinite(span.source_order)
          && span.source_order > failedSpan.source_order && span.source_order < completedSpan.source_order
          && (CORRECTION_SIGNAL.test(span.text) || (span.review_signal_reasons ?? []).includes("human_correction_or_interruption")))
        .sort((left, right) => right.source_order - left.source_order)[0];
      return correctionSpan ? [[failedSpan, correctionSpan, completedSpan]] : [];
    })[0] ?? [] : [];
  const rankedEvidenceCandidates = (failureEpisodeCandidates.length === 3
    ? failureEpisodeCandidates
    : refined
    ? [...rankedCandidates].sort((left, right) => ((right.review_signal_score ?? 0) + (right.source === "tool_result" && completedCallIds.has(right.call_id) ? 100 : 0))
      - ((left.review_signal_score ?? 0) + (left.source === "tool_result" && completedCallIds.has(left.call_id) ? 100 : 0)) || left.legacy_rank - right.legacy_rank)
    : rankedCandidates);
  const explicitDecisionCandidate = refined && failureEpisodeCandidates.length !== 3
    && (discovery?.review_drafts ?? []).some((item) => item?.observation?.lesson_type === "decision")
    ? rankedCandidates.find((span) => span.role === "user" && isExplicitUserDecisionText(span.text))
    : null;
  const pairedDecisionAssistantCandidate = explicitDecisionCandidate
    ? rankedCandidates.find((span) => span.role === "assistant"
      && refinedDecisionAssistantParents.some((parent) => parent.span_id === String(span.span_id).split(".")[0]))
    : null;
  const selectedEvidenceCandidates = explicitDecisionCandidate
    ? [explicitDecisionCandidate, pairedDecisionAssistantCandidate, ...rankedEvidenceCandidates]
      .filter(Boolean)
      .filter((item, index, values) => values.findIndex((candidate) => candidate.span_id === item.span_id) === index)
      .slice(0, 3)
    : rankedEvidenceCandidates.slice(0, refined ? 3 : 8);
  const evidenceCandidates = selectedEvidenceCandidates
    .sort((left, right) => atomicSpans.findIndex((item) => item.span_id === left.span_id)
      - atomicSpans.findIndex((item) => item.span_id === right.span_id))
    .map((item) => ({
      span_id: item.span_id,
      role: item.role,
      text: item.text,
      text_hash: `sha256:${sha256(item.text)}`,
      ...(refined ? {
        source: item.source ?? item.role,
        call_id: item.call_id ?? null
      } : {})
    }));
  const selectedToolCallIds = new Set(evidenceCandidates.filter((item) => item.source === "tool_result" && item.call_id).map((item) => item.call_id));
  const events = coverage
    ? (turnEvidence?.events ?? []).slice(0, 24)
    : (turnEvidence?.events ?? []).filter((item) => supportIds.has(item.event_id) || refined && selectedToolCallIds.has(item.call_id));
  const ruleProposals = (discovery?.review_drafts ?? []).map((item) => ({
    lesson_type: item.observation.lesson_type,
    support_span_ids: item.support_span_ids,
    gaps: item.gaps
  }));
  if (failureEpisodeCandidates.length === 3 && !ruleProposals.some((item) => item.lesson_type === "failure")) {
    ruleProposals.unshift({ lesson_type: "failure", support_span_ids: failureEpisodeCandidates.map((item) => item.span_id), gaps: [] });
  }
  const packet = {
    schema: discovery?.routing?.schema === MEMORY_EXTRACTION_ROUTER_V3
      ? LEARNING_EXTRACTION_PROPOSAL_V3_SCHEMA
      : LEARNING_EXTRACTION_PROPOSAL_V2_SCHEMA,
    evidence_schema: TURN_EVIDENCE_V1_SCHEMA,
    tenant_scope: true,
    project_id: turnEvidence?.project_id ?? null,
    session_hash: turnEvidence?.session_hash ?? null,
    turn_hash: turnEvidence?.turn_hash ?? null,
    provider: turnEvidence?.provider ?? null,
    model: turnEvidence?.model ?? null,
    ...(coverage ? { extraction_profile: MEMORY_EXTRACTION_COVERAGE_PROFILE } : {}),
    ...(refined ? { refinement_profile: MEMORY_EXTRACTION_REFINED_PROFILE } : {}),
    snippets: [],
    events,
    routing: discovery?.routing ?? null,
    rule_proposals: ruleProposals,
    limits: {
      input_tokens: MEMORY_EXTRACTION_INPUT_TOKEN_LIMIT,
      output_tokens: MEMORY_EXTRACTION_OUTPUT_TOKEN_LIMIT,
      candidates: MEMORY_EXTRACTION_MAX_CANDIDATES,
      calls: coverage ? 2 : 1
    }
  };
  if (coverage) {
    const groups = buildCoverageEvidenceGroups(turnEvidence?.snippets ?? [], events, {
      hash_text: (text) => `sha256:${sha256(text)}`
    });
    const pool = selectCoverageEvidence(groups);
    const requestPacket = { ...packet, snippets: [], coverage_pass: 1 };
    const pass1 = packCoverageGroups(requestPacket, pool.groups, {
      reserve_bytes: 256,
      max_snippets: 8,
      upper_bound: (value) => memoryExtractionProviderInputUpperBound(buildMemoryExtractionPrompt(value))
    });
    if (pass1.groups.length === 0 && pool.groups.length > 0) throw new Error("coverage_skipped_input_budget");
    const poolSnippets = pool.groups.flatMap((group) => group.snippets)
      .sort((left, right) => left.order - right.order)
      .map((item) => ({ ...item, text_hash: item.text_hash ?? `sha256:${sha256(item.text)}` }));
    const finalizedPacket = {
      ...packet,
      snippets: poolSnippets,
      coverage: {
        groups: pool.groups.map((group) => ({
          group_id: group.group_id,
          span_ids: group.span_ids,
          priority: group.priority,
          important: group.important,
          latest_order: group.latest_order,
          review_signal_score: group.review_signal_score,
          review_signal_reasons: group.review_signal_reasons
        })),
        pass1_group_ids: pass1.groups.map((group) => group.group_id),
        omitted: [...pool.omitted, ...pass1.omitted],
        review_diagnostics: turnEvidence.review_diagnostics ?? null,
        pool_span_count: pool.span_count,
        pool_text_bytes: pool.text_bytes,
        pass1_upper_bound: pass1.upper_bound
      }
    };
    return { ...finalizedPacket, packet_hash: `sha256:${sha256(stableJson(finalizedPacket))}` };
  }
  // The byte ceiling leaves only a few hundred bytes after the v2 prompt envelope.
  // A retrieval reserve large enough to matter drops every snippet, so existing
  // memories stay bounded later against the same ceiling.
  const packed = packet.schema === LEARNING_EXTRACTION_PROPOSAL_V3_SCHEMA
    ? packMemoryExtractionSnippets(packet, evidenceCandidates, { reserve_bytes: 512, max_snippets: 8 })
    : packMemoryExtractionSnippets(packet, evidenceCandidates, { reserve_bytes: 0, max_snippets: 8 });
  const finalizedPacket = {
    ...packed.packet,
    snippets: packed.packet.snippets.map((item) => ({ ...item, text_hash: `sha256:${sha256(item.text)}` }))
  };
  return { ...finalizedPacket, packet_hash: `sha256:${sha256(stableJson(finalizedPacket))}` };
}

export function rankedEvidenceGroupsV3(snippets) {
  const spans = sentenceSpansV3(snippets).filter((span) => !span.context_only && !STRUCTURAL_BLOCK.test(span.text));
  const score = (span) => (span.role === "user" ? 3 : 0)
    + (DECISION_SIGNAL.test(span.text) ? 6 : 0)
    + (PREFERENCE_SIGNAL.test(span.text) || CONSTRAINT_SIGNAL.test(span.text) ? 5 : 0)
    + (FAILURE_SIGNAL.test(span.text) || CORRECTION_SIGNAL.test(span.text) ? 4 : 0)
    + (REASON_SIGNAL.test(span.text) || REUSE_SIGNAL.test(span.text) ? 3 : 0)
    + (DURABLE_SCOPE.test(span.text) ? 2 : 0) - (TRANSIENT_CHOICE.test(span.text) ? 5 : 0)
    - (OPERATIONAL_SIGNAL.test(span.text) && !REASON_SIGNAL.test(span.text) ? 1 : 0);
  const groups = [];
  for (let index = 0; index < spans.length;) {
    let group = [spans[index]];
    let complete = false;
    for (let size = 1; size <= 4 && index + size <= spans.length; size += 1) {
      const candidate = spans.slice(index, index + size);
      if (candidate.some((span, offset) => offset > 0 && span.order !== candidate[offset - 1].order + 1)) break;
      const text = candidate.map((span) => span.text).join("\n");
      if (/(?:失敗|エラー|failure|error)[\s\S]*?(?:修正|対処|fix|correct)[\s\S]*?(?:検証|成功|verified|passed)/iu.test(text)
        || DECISION_SIGNAL.test(candidate[0].text) && candidate.some((span) => REASON_SIGNAL.test(span.text))) {
        group = candidate; complete = true; break;
      }
    }
    const adopted = group.some((span) => span.role === "user" && DECISION_SIGNAL.test(span.text) && DURABLE_SCOPE.test(span.text));
    groups.push({ spans: group, score: Math.max(...group.map(score)) + (complete ? 3 : 0) + (adopted ? 2 : 0) });
    index += group.length;
  }
  return groups.sort((a, b) => b.score - a.score || a.spans[0].order - b.spans[0].order).map((group) => group.spans);
}

function buildV3Packet(turnEvidence, discovery) {
  const packet = {
    schema: LEARNING_EXTRACTION_PROPOSAL_V3_SCHEMA, packet_revision: "v3.1", evidence_schema: TURN_EVIDENCE_V1_SCHEMA,
    tenant_scope: true, project_id: turnEvidence.project_id ?? null, session_hash: turnEvidence.session_hash ?? null,
    turn_hash: turnEvidence.turn_hash ?? null, provider: turnEvidence.provider ?? null, model: turnEvidence.model ?? null,
    routing: discovery.routing, snippets: [], events: [], rule_proposals: [],
    limits: { input_tokens: 2000, output_tokens: 800, candidates: 3, calls: 1 }
  };
  const packed = packV3Evidence(packet, rankedEvidenceGroupsV3(turnEvidence.snippets ?? []));
  const finalized = { ...packed.packet,
    routing: { ...discovery.routing, support_span_ids: packed.packet.snippets.map((span) => span.span_id) },
    snippets: packed.packet.snippets.map((span) => ({ ...span, text_hash: `sha256:${sha256(span.text)}` })),
    packing: { estimated_input_tokens: packed.estimated_input_tokens, omitted_span_ids: packed.omitted_span_ids }
  };
  return { ...finalized, packet_hash: `sha256:${sha256(stableJson(finalized))}` };
}
