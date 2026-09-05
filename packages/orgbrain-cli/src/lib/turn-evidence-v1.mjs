import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import {
  normalizeMemoryPaths,
  screenSensitiveMemory
} from "../../../shared/src/memory-capture-v2-runtime.mjs";
import { normalizeMemoryContractV2Event } from "../../../shared/src/memory-contract-v2-runtime.mjs";
import { stripMemoryCitationBlocks } from "../../../shared/src/memory-extraction-review-text-runtime.mjs";
import { packMemoryExtractionSnippets } from "../../../shared/src/memory-extraction-provider-contract-runtime.mjs";
import { packV3Evidence } from "../../../shared/src/memory-extraction-v3-packing.mjs";
import { MEMORY_EXTRACTION_ROUTER_MODEL_V2 } from "./memory-extraction-router-model-v2.mjs";
import { MEMORY_EXTRACTION_ROUTER_MODEL_V3 } from "./memory-extraction-router-model-v3.mjs";

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

const DECISION_SIGNAL = /\b(?:decid(?:e|ed)|adopt(?:ed)?|choose|chose|selected|standardize|switch(?:ed)?\s+to|will use|must use)\b|(?:決定(?:した|する)|採用(?:した|する)|選択(?:した|する)|方針(?:とする|にした)|統一(?:する|した)|切り替え(?:る|た)|これで進める)/iu;
const TRANSIENT_CHOICE = /(?:今回だけ|このターン|一時的|ひとまず|今だけ|for now|this time|temporary|one[- ]off)/iu;
const DURABLE_SCOPE = /\b(?:implementation|architecture|api|schema|policy|governance|repository|project|organization|tenant|default|rule)\b|(?:実装|設計|API|スキーマ|方針|ルール|規約|組織|テナント|プロジェクト|既定|デフォルト)/iu;
const FAILURE_SIGNAL = /\b(?:fail(?:ed|ure)?|error|regression|timed? out|did not work|broken|root cause)\b|(?:失敗|エラー|不具合|回帰|動かな(?:い|かった)|原因|タイムアウト)/iu;
const CORRECTION_SIGNAL = /\b(?:fix(?:ed)?|correct(?:ed)?|changed?|switch(?:ed)?|retry|workaround|prevent(?:ed)?)\b|(?:修正|変更|切り替え|対処|解消|回避|再実行|再発防止)/iu;
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

function clipUtf8Prefix(value, limitBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= limitBytes) return text;
  let bytes = 0;
  let output = "";
  for (const character of text) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > limitBytes) break;
    output += character;
    bytes += next;
  }
  return output;
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
      context_only: snippet.context_only === true,
      text: clip(text, 1_000)
    }))
    .filter((item) => item.text.length >= 8));
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
        role: snippet.role, context_only: snippet.context_only === true, start, end: start + text.length, text, order: order++, aliases: [] };
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

function routerContext(turnEvidence, v3 = false) {
  const routingSnippets = [
    ...(turnEvidence?.context_snippets ?? []).map((snippet) => ({ ...snippet, context_only: true })),
    ...(turnEvidence?.snippets ?? []).map((snippet) => ({ ...snippet, context_only: false }))
  ].filter((snippet) => !STRUCTURAL_BLOCK.test(snippet.text));
  const spans = v3 ? sentenceSpansV3(routingSnippets) : sentenceSpans(routingSnippets);
  const events = turnEvidence?.events ?? [];
  const meaningful = spans.filter((span) => span.text.length >= 8 && !STRUCTURAL_NOISE.test(span.text));
  const supportable = meaningful.filter((span) => !span.context_only);
  const userSpans = meaningful.filter((span) => span.role === "user");
  const allText = meaningful.map((span) => span.text).join("\n");
  const userText = userSpans.map((span) => span.text).join("\n");
  const failed = FAILURE_SIGNAL.test(allText) || events.some((event) => event.status === "failed");
  const corrected = CORRECTION_SIGNAL.test(allText);
  const verified = SUCCESS_SIGNAL.test(allText) || events.some((event) =>
    event.status === "completed" && (event.exit_code === 0 || event.http_status >= 200 && event.http_status < 300));
  const explicitDecision = (DECISION_SIGNAL.test(userText)
    || (DECISION_SIGNAL.test(allText) && DURABLE_SCOPE.test(allText)))
    && !TRANSIENT_CHOICE.test(allText);
  const preference = PREFERENCE_SIGNAL.test(allText);
  const constraint = CONSTRAINT_SIGNAL.test(allText);
  const explicitUserAdoption = DECISION_SIGNAL.test(userText)
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
      preference,
      constraint,
      explicitUserAdoption,
      reusable,
      proposalOnly,
      reviewOnly,
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
      causal_closure: failed && corrected && verified ? 1 : 0,
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
  const { meaningful, signals, features } = context;
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
  const durableCandidate = durable.probability >= model.durable_candidate.threshold;
  const operationalHistory = operational.probability >= model.operational_history.threshold;
  const reasons = [];
  if (signals.explicitDecision) reasons.push("explicit_user_decision");
  if (signals.preference) reasons.push("explicit_user_preference");
  if (signals.constraint) reasons.push("explicit_user_constraint");
  if (features.failure_correction) reasons.push("failure_correction_chain");
  if (features.durable_scope) reasons.push("durable_scope");
  if (signals.reusable) reasons.push("reusable_or_causal");
  if (signals.proposalOnly) reasons.push("proposal_not_adopted");
  if (signals.reviewOnly) reasons.push("review_report_not_adopted");
  if (features.explicitly_transient) reasons.push("explicitly_transient");
  if (operationalHistory) reasons.push(signals.verified ? "verified_current_outcome" : "current_task_status");

  const durableSupport = meaningful.filter((span) =>
    DECISION_SIGNAL.test(span.text)
    || PREFERENCE_SIGNAL.test(span.text)
    || CONSTRAINT_SIGNAL.test(span.text)
    || FAILURE_SIGNAL.test(span.text)
    || CORRECTION_SIGNAL.test(span.text)
    || REASON_SIGNAL.test(span.text)
    || REUSE_SIGNAL.test(span.text));
  const operationalSupport = meaningful.filter((span) => OPERATIONAL_SIGNAL.test(span.text) || SUCCESS_SIGNAL.test(span.text));
  const selectedSupport = [...new Map([
    ...(durableCandidate ? (durableSupport.length > 0 ? durableSupport : meaningful) : []),
    ...(operationalHistory ? (operationalSupport.length > 0 ? operationalSupport : meaningful) : [])
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
  if (signals.preference) reasons.push("explicit_user_preference");
  if (signals.constraint) reasons.push("explicit_user_constraint");
  if (features.failure_correction) reasons.push("failure_correction_chain");
  if (features.causal_closure) reasons.push("causal_chain_closed");
  if (features.durable_scope) reasons.push("durable_scope");
  if (signals.reusable) reasons.push("reusable_or_causal");
  if (signals.proposalOnly) reasons.push("proposal_not_adopted");
  if (signals.reviewOnly) reasons.push("review_report_not_adopted");
  if (features.explicitly_transient) reasons.push("explicitly_transient");
  if (operationalHistory) reasons.push(signals.verified ? "verified_current_outcome" : "current_task_status");
  return reasons;
}

function rankedSupport(context, primaryRoute) {
  const scored = context.supportable.map((span, index) => {
    let score = span.role === "user" ? 3 : 0;
    if (primaryRoute === "llm_candidate") {
      if (DECISION_SIGNAL.test(span.text)) score += 6;
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
    return { span, score, index };
  });
  const positive = scored.filter((item) => item.score > 0);
  return (positive.length > 0 ? positive : scored)
    .sort((left, right) => right.score - left.score || left.index - right.index)
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
  const durableCandidate = durable.probability >= model.durable_candidate.threshold;
  const operational = durableCandidate
    ? null
    : linearProbability(context.features, { ...model.operational_history, feature_names: model.feature_names });
  const operationalHistory = !durableCandidate && operational.probability >= model.operational_history.threshold;
  const primaryRoute = durableCandidate ? "llm_candidate" : operationalHistory ? "operational_history" : "discard";
  const reasons = routerReasonCodes(context, operationalHistory);
  const support = primaryRoute === "discard" ? [] : rankedSupport({ ...context,
    supportable: sentenceSpansV3(turnEvidence.snippets ?? []).filter((span) => !span.context_only && !STRUCTURAL_BLOCK.test(span.text)) }, primaryRoute);
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
  const snippets = [];
  const snippetAliases = {};
  const messageSpanByKey = new Map();
  const eventsByCall = new Map();
  let messageSpanIndex = 0;
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
        messageSpanIndex += 1;
        const spanId = `s${messageSpanIndex}`;
        const text = clip(stripMemoryCitationBlocks(screened.text), 4_000);
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
  const retainedSnippets = hardExclusion ? [] : snippets.slice(0, 8);
  const retainedSpanIds = new Set(retainedSnippets.map((snippet) => snippet.span_id));
  const retainedAliases = Object.fromEntries(Object.entries(snippetAliases)
    .filter(([alias, target]) => Number(alias.slice(1)) <= 8 && retainedSpanIds.has(target)));
  const turnEvidence = {
    schema: TURN_EVIDENCE_V1_SCHEMA,
    session_hash: input?.session_hash ?? null,
    turn_hash: input?.turn_hash ?? null,
    project_id: input?.project_id ?? null,
    provider,
    model,
    snippets: retainedSnippets,
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

export function buildLearningExtractionPacket(turnEvidence, discovery) {
  if (discovery?.routing?.schema === MEMORY_EXTRACTION_ROUTER_V3) return buildV3Packet(turnEvidence, discovery);
  const supportIds = new Set([
    ...(discovery?.routing?.support_span_ids ?? []),
    ...(discovery?.review_drafts ?? []).flatMap((item) => item.support_span_ids ?? [])
  ]);
  const parentIds = new Set([...supportIds].map((id) => String(id).split(".")[0]));
  const parents = (turnEvidence?.snippets ?? []).filter((item) => parentIds.has(item.span_id));
  const atomicSpans = sentenceSpans(parents);
  const rankedIds = new Map((discovery?.routing?.support_span_ids ?? []).map((id, index) => [id, index]));
  const evidenceCandidates = atomicSpans
    .filter((span) => supportIds.has(span.span_id))
    .sort((left, right) => (rankedIds.get(left.span_id) ?? 99) - (rankedIds.get(right.span_id) ?? 99))
    .slice(0, 8)
    .sort((left, right) => atomicSpans.findIndex((item) => item.span_id === left.span_id)
      - atomicSpans.findIndex((item) => item.span_id === right.span_id))
    .map((item) => ({
      span_id: item.span_id,
      role: item.role,
      text: item.text,
      text_hash: `sha256:${sha256(item.text)}`
    }));
  const events = (turnEvidence?.events ?? []).filter((item) => supportIds.has(item.event_id));
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
    snippets: [],
    events,
    routing: discovery?.routing ?? null,
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
  const packed = packet.schema === LEARNING_EXTRACTION_PROPOSAL_V3_SCHEMA
    ? packMemoryExtractionSnippets(packet, evidenceCandidates, { reserve_bytes: 512, max_snippets: 8 })
    : { packet: { ...packet, snippets: evidenceCandidates.slice(0, 3).map((item, index) => {
        const remaining = 320 - evidenceCandidates.slice(0, index).reduce((sum, candidate) => sum + Buffer.byteLength(candidate.text, "utf8"), 0);
        const text = clipUtf8Prefix(item.text, Math.max(0, remaining)).trim();
        return { ...item, text, text_hash: `sha256:${sha256(text)}` };
      }).filter((item) => item.text) } };
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
