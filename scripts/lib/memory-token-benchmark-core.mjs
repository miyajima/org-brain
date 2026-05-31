export const TOKEN_ESTIMATE_MODEL = "estimated_tokens_v1";

const QUESTION_KEYS = ["question", "query", "q", "prompt"];
const ANSWER_KEYS = ["answer", "gold_answer", "reference_answer", "target", "ground_truth", "expected_answer"];
const CATEGORY_KEYS = ["category", "question_type", "type", "task", "class"];
const ID_KEYS = ["id", "question_id", "qid", "uuid", "example_id"];
const HISTORY_KEYS = [
  "history",
  "histories",
  "context",
  "contexts",
  "conversation",
  "conversations",
  "sessions",
  "haystack_sessions",
  "messages",
  "turns",
  "chat_history",
  "corpus",
  "docs"
];

export function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function pickValue(row, keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return undefined;
}

function stringifyScalar(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(stringifyScalar).filter(Boolean).join(" | ");
  if (typeof value === "object") {
    const nested = pickValue(value, ["text", "content", "message", "value", "answer", "question"]);
    return nested === undefined ? collapseWhitespace(JSON.stringify(value)) : stringifyScalar(nested);
  }
  return collapseWhitespace(value);
}

function renderObjectHistory(value) {
  const role = stringifyScalar(pickValue(value, ["role", "speaker", "author", "from", "name"]));
  const text = stringifyScalar(pickValue(value, ["content", "text", "message", "value", "session_text"]));
  if (text) return role ? `${role}: ${text}` : text;

  for (const key of HISTORY_KEYS) {
    if (value[key] !== undefined && value[key] !== null) return historyValueToText(value[key]);
  }

  return collapseWhitespace(JSON.stringify(value));
}

export function historyValueToText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(historyValueToText).filter(Boolean).join("\n\n");
  if (typeof value === "object") return renderObjectHistory(value);
  return String(value);
}

function unwrapDatasetRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  for (const key of ["data", "rows", "examples", "items", "questions", "test", "validation", "train"]) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [parsed];
}

export function parseLongMemEvalDataset(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return [];

  let rows;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      rows = unwrapDatasetRows(JSON.parse(trimmed));
    } catch (error) {
      rows = null;
    }
  }
  if (!rows) {
    rows = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  return rows.map((row, index) => normalizeLongMemEvalItem(row, index));
}

export function normalizeLongMemEvalItem(row, index = 0) {
  if (!row || typeof row !== "object") {
    throw new Error(`LongMemEval item ${index + 1} must be an object`);
  }

  const question = stringifyScalar(pickValue(row, QUESTION_KEYS) ?? row.input?.question ?? row.input?.query);
  if (!question) {
    throw new Error(`LongMemEval item ${index + 1} is missing a question/query field`);
  }

  const answer = stringifyScalar(pickValue(row, ANSWER_KEYS) ?? row.output?.answer ?? row.output?.text);
  const category = stringifyScalar(pickValue(row, CATEGORY_KEYS)) || "uncategorized";
  const id = stringifyScalar(pickValue(row, ID_KEYS)) || `item-${index + 1}`;
  const historyValue = pickValue(row, HISTORY_KEYS) ?? row.input?.history ?? row.input?.context ?? "";
  const historyText = historyValueToText(historyValue);

  return {
    id,
    category,
    question,
    answer,
    historyText
  };
}

export function estimateTokens(value) {
  const text = String(value ?? "");
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

export function computeTokenReduction(fullContextTokens, orgBrainContextTokens) {
  const full = Number.isFinite(Number(fullContextTokens)) ? Number(fullContextTokens) : 0;
  const treatment = Number.isFinite(Number(orgBrainContextTokens)) ? Number(orgBrainContextTokens) : 0;
  const tokensSaved = full - treatment;
  return {
    full_context_tokens: full,
    org_brain_context_tokens: treatment,
    tokens_saved: tokensSaved,
    token_reduction_rate: full > 0 ? tokensSaved / full : 0
  };
}

export function buildFullContextPrompt(item) {
  return [
    "Answer the question using the full conversation history.",
    "",
    "Conversation history:",
    item.historyText || "(empty)",
    "",
    "Question:",
    item.question,
    "",
    "Answer:"
  ].join("\n");
}

export function buildTreatmentPrompt(item, contexts) {
  const renderedContexts = contexts.length > 0
    ? contexts.map((context, index) => formatBenchmarkContext(context, index + 1)).join("\n\n")
    : "(no retrieved Org Brain context)";

  return [
    "Answer the question using only the retrieved Org Brain context when it is relevant.",
    "",
    "Retrieved Org Brain context:",
    renderedContexts,
    "",
    "Question:",
    item.question,
    "",
    "Answer:"
  ].join("\n");
}

export function formatBenchmarkContext(context, index) {
  const label = context.kind === "doc" ? `doc:${context.id}` : `memory:${context.id}`;
  const project = context.project_id ? ` project=${context.project_id}` : "";
  const source = context.source ? ` source=${context.source}` : "";
  const title = context.title || context.summary || "(untitled)";
  const snippet = context.content_preview || context.body_preview || "";
  return [`[${index}] ${label}${project}${source}`, `title: ${title}`, snippet ? `snippet: ${snippet}` : ""]
    .filter(Boolean)
    .join("\n");
}

export function summarizeBenchmarkResults(results, existingMeasurementRuns = []) {
  const judged = results.filter((result) => result.judge?.verdict !== "not_run");
  const passed = judged.filter((result) => result.judge?.passed === true);
  const totals = results.reduce(
    (acc, result) => {
      acc.full_context_tokens += Number(result.full_context_tokens ?? 0);
      acc.org_brain_context_tokens += Number(result.org_brain_context_tokens ?? 0);
      acc.retrieval_count += Number(result.retrieval_count ?? 0);
      acc.retrieval_latency_ms += Number(result.retrieval_latency_ms ?? 0);
      acc.fallback_count += result.fallback_used ? 1 : 0;
      return acc;
    },
    {
      full_context_tokens: 0,
      org_brain_context_tokens: 0,
      retrieval_count: 0,
      retrieval_latency_ms: 0,
      fallback_count: 0
    }
  );
  const reduction = computeTokenReduction(totals.full_context_tokens, totals.org_brain_context_tokens);

  return {
    item_count: results.length,
    judged_count: judged.length,
    judge_pass_count: passed.length,
    accuracy: judged.length > 0 ? passed.length / judged.length : null,
    ...reduction,
    retrieval_count: totals.retrieval_count,
    retrieval_latency_ms: totals.retrieval_latency_ms,
    avg_retrieval_latency_ms: results.length > 0 ? totals.retrieval_latency_ms / results.length : 0,
    fallback_count: totals.fallback_count,
    fallback_rate: results.length > 0 ? totals.fallback_count / results.length : 0,
    categories: summarizeCategories(results),
    existing_measurement_runs: existingMeasurementRuns
  };
}

export function summarizeCategories(results) {
  const byCategory = new Map();
  for (const result of results) {
    const key = result.category || "uncategorized";
    const entry = byCategory.get(key) ?? {
      category: key,
      item_count: 0,
      judged_count: 0,
      judge_pass_count: 0,
      full_context_tokens: 0,
      org_brain_context_tokens: 0,
      tokens_saved: 0,
      fallback_count: 0
    };
    entry.item_count += 1;
    entry.full_context_tokens += Number(result.full_context_tokens ?? 0);
    entry.org_brain_context_tokens += Number(result.org_brain_context_tokens ?? 0);
    entry.tokens_saved += Number(result.tokens_saved ?? 0);
    entry.fallback_count += result.fallback_used ? 1 : 0;
    if (result.judge?.verdict !== "not_run") {
      entry.judged_count += 1;
      if (result.judge?.passed === true) entry.judge_pass_count += 1;
    }
    byCategory.set(key, entry);
  }

  return [...byCategory.values()]
    .map((entry) => ({
      ...entry,
      accuracy: entry.judged_count > 0 ? entry.judge_pass_count / entry.judged_count : null,
      token_reduction_rate:
        entry.full_context_tokens > 0
          ? (entry.full_context_tokens - entry.org_brain_context_tokens) / entry.full_context_tokens
          : 0,
      fallback_rate: entry.item_count > 0 ? entry.fallback_count / entry.item_count : 0
    }))
    .sort((left, right) => right.item_count - left.item_count || left.category.localeCompare(right.category));
}
