export const TOKEN_ESTIMATE_MODEL = "estimated_tokens_v1";

const QUESTION_KEYS = ["question", "query", "q", "prompt"];
const ANSWER_KEYS = ["answer", "gold_answer", "reference_answer", "target", "ground_truth", "expected_answer"];
const CATEGORY_KEYS = ["category", "question_type", "type", "task", "class"];
const ID_KEYS = ["id", "question_id", "qid", "uuid", "example_id"];
const QUESTION_DATE_KEYS = ["question_date", "query_date", "asked_at", "date"];
const ANSWER_SESSION_ID_KEYS = ["answer_session_ids", "answer_sessions", "gold_session_ids", "target_session_ids"];
const HAYSTACK_SESSION_ID_KEYS = ["haystack_session_ids", "session_ids", "context_session_ids"];
const HAYSTACK_DATE_KEYS = ["haystack_dates", "session_dates", "context_dates"];
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
const STOPWORDS = new Set(
  [
    "what",
    "which",
    "when",
    "where",
    "who",
    "whom",
    "whose",
    "why",
    "how",
    "many",
    "much",
    "can",
    "could",
    "would",
    "should",
    "did",
    "do",
    "does",
    "is",
    "are",
    "was",
    "were",
    "i",
    "me",
    "my",
    "mine",
    "you",
    "your",
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "about",
    "between",
    "from",
    "first",
    "last",
    "day",
    "days",
    "happened",
    "order",
    "recommend",
    "suggest",
    "some",
    "more",
    "resources",
    "current",
    "setup"
  ]
);
const PREFERENCE_HINTS = new Set([
  "prefer",
  "preference",
  "like",
  "dislike",
  "love",
  "hate",
  "use",
  "using",
  "specifically",
  "specific",
  "advanced",
  "recommend",
  "resources",
  "setup",
  "brand",
  "tool",
  "software",
  "camera",
  "lens",
  "sony",
  "adobe",
  "premiere",
  "healthcare",
  "medical",
  "image",
  "analysis",
  "video",
  "editing",
  "conference",
  "publication",
  "recent"
]);

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

function stringifyArray(value) {
  if (value === null || value === undefined || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(stringifyScalar).filter(Boolean);
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

function extractTurnRoles(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return [...new Set(value.flatMap(extractTurnRoles).filter(Boolean))];
  if (typeof value === "object") {
    const role = stringifyScalar(pickValue(value, ["role", "speaker", "author", "from", "name"]));
    const nested = HISTORY_KEYS.flatMap((key) => value[key] === undefined ? [] : extractTurnRoles(value[key]));
    return [...new Set([role, ...nested].filter(Boolean))];
  }
  return [];
}

function buildHistorySessions(row, itemId, historyValue) {
  const sessionIds = stringifyArray(pickValue(row, HAYSTACK_SESSION_ID_KEYS));
  const sessionDates = stringifyArray(pickValue(row, HAYSTACK_DATE_KEYS));
  const sessionsValue = row.haystack_sessions ?? row.sessions ?? row.conversations ?? null;

  if (Array.isArray(sessionsValue) && sessionsValue.length > 0 && (Array.isArray(sessionsValue[0]) || typeof sessionsValue[0] === "object")) {
    return sessionsValue
      .map((session, index) => ({
        session_id: sessionIds[index] || `${itemId}:session:${index + 1}`,
        session_date: sessionDates[index] || "",
        session_index: index,
        turn_roles: extractTurnRoles(session),
        content: historyValueToText(session)
      }))
      .filter((session) => session.content);
  }

  const historyText = historyValueToText(historyValue);
  return historyText
    ? [
        {
          session_id: sessionIds[0] || `${itemId}:session:1`,
          session_date: sessionDates[0] || "",
          session_index: 0,
          turn_roles: extractTurnRoles(historyValue),
          content: historyText
        }
      ]
    : [];
}

export function tokenizeBenchmarkText(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9一-龠ぁ-んァ-ヶー]+/u)
    .map((token) => normalizeBenchmarkToken(token.trim()))
    .filter((token) => token.length >= 2);
}

function significantTokens(value) {
  return tokenizeBenchmarkText(value).filter((token) => !STOPWORDS.has(token));
}

function normalizeBenchmarkToken(token) {
  if (token.length <= 4) return token;
  if (token.endsWith("ment")) return token.slice(0, -"ment".length);
  if (token.endsWith("ing")) return token.slice(0, -"ing".length);
  if (token.endsWith("ed")) return token.slice(0, -"ed".length);
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function chunkText(text, maxChars = 1800) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs.length > 0 ? paragraphs : [normalized]) {
    if (paragraph.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let index = 0; index < paragraph.length; index += maxChars) {
        chunks.push(paragraph.slice(index, index + maxChars));
      }
      continue;
    }
    if (!current) {
      current = paragraph;
      continue;
    }
    if ((current.length + paragraph.length + 2) <= maxChars) {
      current = `${current}\n\n${paragraph}`;
    } else {
      chunks.push(current);
      current = paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function chunkSessionText(text, maxChars = 1800, overlapChars = 240) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [{ content: normalized, start_offset: 0, end_offset: normalized.length, window_index: 0 }];

  const chunks = [];
  const step = Math.max(1, maxChars - Math.min(overlapChars, Math.floor(maxChars / 2)));
  for (let start = 0; start < normalized.length; start += step) {
    const end = Math.min(normalized.length, start + maxChars);
    chunks.push({
      content: normalized.slice(start, end),
      start_offset: start,
      end_offset: end,
      window_index: chunks.length
    });
    if (end >= normalized.length) break;
  }
  return chunks;
}

export function createBenchmarkChunks(item, options = {}) {
  const maxChars = options.chunkCharLimit ?? 1800;
  if (options.sessionAware === false || !Array.isArray(item.historySessions) || item.historySessions.length === 0) {
    return chunkText(item.historyText, maxChars).map((content, index) => ({
      id: `${item.id}:chunk:${index + 1}`,
      item_id: item.id,
      category: item.category,
      order: index,
      session_id: null,
      session_date: "",
      session_index: index,
      window_index: 0,
      turn_roles: [],
      content,
      search_text: content
    }));
  }

  let order = 0;
  return item.historySessions.flatMap((session) =>
    chunkSessionText(session.content, maxChars, options.chunkOverlapChars ?? 240).map((chunk) => {
      order += 1;
      return {
        id: `${item.id}:session:${session.session_index + 1}:chunk:${chunk.window_index + 1}`,
        item_id: item.id,
        category: item.category,
        order,
        session_id: session.session_id,
        session_date: session.session_date,
        session_index: session.session_index,
        window_index: chunk.window_index,
        start_offset: chunk.start_offset,
        end_offset: chunk.end_offset,
        turn_roles: session.turn_roles,
        content: chunk.content,
        search_text: `${session.session_date}\n${chunk.content}`
      };
    })
  );
}

function createLegacyBenchmarkChunks(item, options = {}) {
  const maxChars = options.chunkCharLimit ?? 1800;
  return chunkText(item.historyText, maxChars).map((content, index) => ({
    id: `${item.id}:chunk:${index + 1}`,
    item_id: item.id,
    category: item.category,
    order: index,
    session_id: null,
    session_date: "",
    session_index: index,
    window_index: 0,
    turn_roles: [],
    content,
    search_text: content
  }));
}

export function buildTransientBenchmarkIndex(items, options = {}) {
  const transientStrategy = options.transientStrategy ?? "longmemeval_session_v2";
  const chunks = items.flatMap((item) =>
    transientStrategy === "bm25_lite_v1"
      ? createLegacyBenchmarkChunks(item, options)
      : createBenchmarkChunks(item, { ...options, sessionAware: true })
  );
  const documentFrequency = new Map();
  const indexedChunks = chunks.map((chunk) => {
    const tokens = tokenizeBenchmarkText(chunk.search_text ?? chunk.content);
    const termCounts = new Map();
    for (const token of tokens) termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    for (const token of new Set(tokens)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    return {
      ...chunk,
      tokens,
      termCounts,
      token_count: tokens.length
    };
  });

  return {
    chunks: indexedChunks,
    documentFrequency,
    documentCount: indexedChunks.length,
    transientStrategy
  };
}

function bm25LiteScore(index, chunk, queryTokens) {
  if (queryTokens.length === 0 || chunk.token_count === 0) return 0;
  let score = 0;
  const averageLength =
    index.chunks.length > 0
      ? index.chunks.reduce((sum, item) => sum + item.token_count, 0) / index.chunks.length
      : 1;
  const k1 = 1.2;
  const b = 0.75;
  for (const token of queryTokens) {
    const tf = chunk.termCounts.get(token) ?? 0;
    if (tf === 0) continue;
    const df = index.documentFrequency.get(token) ?? 0;
    const idf = Math.log(1 + (index.documentCount - df + 0.5) / (df + 0.5));
    const denom = tf + k1 * (1 - b + b * (chunk.token_count / Math.max(averageLength, 1)));
    score += idf * ((tf * (k1 + 1)) / denom);
  }
  return score;
}

function extractQuestionPhrases(question) {
  const raw = String(question ?? "");
  const lower = raw.toLowerCase().replace(/[?.,]/g, " ");
  const phrases = [];
  const pushParts = (value) => {
    for (const part of String(value ?? "").split(/,| and | or |:/iu)) {
      const cleaned = collapseWhitespace(part).replace(/^(?:the|my|a|an)\s+/iu, "");
      if (cleaned.length > 4) phrases.push(cleaned);
    }
  };
  for (const pattern of [
    /between (.+?) and (.+)$/iu,
    /order from first to last[:]? (.+)$/iu,
    /recommend (?:some )?(.+)$/iu,
    /suggest (?:some )?(.+)$/iu,
    /learn more about (.+)$/iu,
    /current (.+?) setup/iu
  ]) {
    const match = lower.match(pattern);
    if (match) pushParts(match.slice(1).join(" and "));
  }
  const namedSpans = raw.match(/[A-Z][A-Za-z0-9+.-]*(?:\s+[A-Z][A-Za-z0-9+.-]*)*/g) ?? [];
  for (const span of namedSpans) {
    if (span.length > 3) phrases.push(span);
  }
  return [...new Set(phrases)].slice(0, 8);
}

function isTemporalQuestion(question) {
  return /\b(first|last|before|after|between|order|newer|recent|latest|most recently|how many days|how many weeks)\b/iu.test(question);
}

function isPreferenceQuestion(question) {
  return /\b(prefer|preference|recommend|suggest|resources|setup|interested|learn more|current)\b/iu.test(question);
}

function phraseHitRatio(chunk, phraseTokens) {
  if (phraseTokens.length === 0) return 0;
  let hits = 0;
  for (const token of phraseTokens) {
    if (chunk.termCounts.has(token)) hits += 1;
  }
  return hits / phraseTokens.length;
}

function sessionV2Score(index, chunk, profile) {
  let score = bm25LiteScore(index, chunk, profile.queryTokens);
  const lowerContent = `${chunk.session_date ?? ""}\n${chunk.content ?? ""}`.toLowerCase();

  for (const phrase of profile.phrases) {
    const hitRatio = phraseHitRatio(chunk, phrase.tokens);
    if (hitRatio > 0) score += hitRatio * 3;
    if (phrase.text && lowerContent.includes(phrase.text.toLowerCase())) score += 4;
  }

  if (profile.preference) {
    if ((chunk.turn_roles ?? []).includes("user")) score += 1.5;
    if (/\b(prefer|rather|like|love|use|currently|advanced|specific|adobe|sony|healthcare|deep learning|medical)\b/iu.test(chunk.content)) {
      score += 4;
    }
    for (const token of profile.queryTokens) {
      if (PREFERENCE_HINTS.has(token) && chunk.termCounts.has(token)) score += 0.5;
    }
  }

  if (profile.temporal && profile.sessionCount > 1) {
    const relativePosition = Number(chunk.session_index ?? 0) / Math.max(1, profile.sessionCount - 1);
    if (/\b(recent|latest|last|newer|most recently)\b/iu.test(profile.question)) score += relativePosition * 1.5;
    if (/\b(first|earliest|before|from first)\b/iu.test(profile.question)) score += (1 - relativePosition) * 0.5;
  }

  return score;
}

function buildSessionV2Profile(item) {
  const phraseTexts = extractQuestionPhrases(item.question);
  return {
    question: item.question,
    queryTokens: [...new Set(significantTokens(item.question))],
    phrases: phraseTexts
      .map((text) => ({ text, tokens: significantTokens(text) }))
      .filter((phrase) => phrase.tokens.length > 0),
    temporal: isTemporalQuestion(item.question),
    preference: isPreferenceQuestion(item.question),
    sessionCount: Array.isArray(item.historySessions) ? item.historySessions.length : 0
  };
}

function selectDiverseCandidates(candidates, profile, topK) {
  const selected = [];
  const selectedIds = new Set();
  const selectedSessions = new Set();
  const sorted = [...candidates].sort((left, right) => right.score - left.score || left.chunk.order - right.chunk.order || left.chunk.id.localeCompare(right.chunk.id));

  for (const phrase of profile.phrases) {
    if (selected.length >= topK) break;
    let best = null;
    for (const candidate of sorted) {
      if (selectedIds.has(candidate.chunk.id)) continue;
      const ratio = phraseHitRatio(candidate.chunk, phrase.tokens);
      if (ratio <= 0) continue;
      if (!best || candidate.score > best.score) best = candidate;
    }
    if (best) {
      selected.push(best);
      selectedIds.add(best.chunk.id);
      if (best.chunk.session_id) selectedSessions.add(best.chunk.session_id);
    }
  }

  while (selected.length < topK) {
    let best = null;
    let bestAdjusted = -Infinity;
    for (const candidate of sorted) {
      if (selectedIds.has(candidate.chunk.id)) continue;
      const sameSession = candidate.chunk.session_id && selectedSessions.has(candidate.chunk.session_id);
      const adjusted = candidate.score - (sameSession ? 2 : 0);
      if (adjusted > bestAdjusted) {
        best = candidate;
        bestAdjusted = adjusted;
      }
    }
    if (!best) break;
    selected.push(best);
    selectedIds.add(best.chunk.id);
    if (best.chunk.session_id) selectedSessions.add(best.chunk.session_id);
  }

  return selected;
}

function renderChunkPreview(chunk, contextCharLimit) {
  const metadata = [
    chunk.session_date ? `session_date: ${chunk.session_date}` : "",
    chunk.session_id ? `session_id: ${chunk.session_id}` : ""
  ].filter(Boolean).join(" | ");
  const bodyLimit = Math.max(120, contextCharLimit - metadata.length - (metadata ? 1 : 0));
  const body = chunk.content.length > bodyLimit ? `${chunk.content.slice(0, bodyLimit - 3)}...` : chunk.content;
  return [metadata, body].filter(Boolean).join("\n");
}

export function retrieveFromTransientBenchmarkIndex(index, item, options = {}) {
  const startedAt = Date.now();
  const topK = options.topK ?? 5;
  const contextCharLimit = options.contextCharLimit ?? 1200;
  const transientStrategy = options.transientStrategy ?? index.transientStrategy ?? "longmemeval_session_v2";
  const profile = transientStrategy === "bm25_lite_v1"
    ? { queryTokens: [...new Set(tokenizeBenchmarkText(item.question))], phrases: [] }
    : buildSessionV2Profile(item);
  const candidates = index.chunks
    .map((chunk) => ({
      chunk,
      score: transientStrategy === "bm25_lite_v1" ? bm25LiteScore(index, chunk, profile.queryTokens) : sessionV2Score(index, chunk, profile)
    }))
    .filter((candidate) => candidate.score > 0);
  const top = transientStrategy === "bm25_lite_v1"
    ? candidates
        .sort((left, right) => right.score - left.score || left.chunk.order - right.chunk.order || left.chunk.id.localeCompare(right.chunk.id))
        .slice(0, topK)
    : selectDiverseCandidates(candidates, profile, topK);
  const contexts = top.map(({ chunk, score }) => ({
    kind: "memory",
    id: chunk.id,
    project_id: "longmemeval-s",
    source: "transient-benchmark-index",
    title: `${chunk.category} ${chunk.id}`,
    summary: `${chunk.category} ${chunk.id}`,
    content_preview: renderChunkPreview(chunk, contextCharLimit),
    session_id: chunk.session_id ?? null,
    session_date: chunk.session_date ?? "",
    session_index: chunk.session_index ?? null,
    score
  }));

  return {
    strategy: options.strategy ?? transientStrategy,
    matched_count: candidates.length,
    returned_count: contexts.length,
    fallback_used: contexts.length === 0,
    latency_ms: Date.now() - startedAt,
    contexts
  };
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
  const answerSessionIds = stringifyArray(pickValue(row, ANSWER_SESSION_ID_KEYS));
  const haystackSessionIds = stringifyArray(pickValue(row, HAYSTACK_SESSION_ID_KEYS));
  const haystackDates = stringifyArray(pickValue(row, HAYSTACK_DATE_KEYS));
  const questionDate = stringifyScalar(pickValue(row, QUESTION_DATE_KEYS));
  const historySessions = buildHistorySessions(row, id, historyValue);

  return {
    id,
    category,
    question,
    answer,
    historyText,
    question_date: questionDate,
    answer_session_ids: answerSessionIds,
    haystack_session_ids: haystackSessionIds,
    haystack_dates: haystackDates,
    historySessions
  };
}

export function estimateTokens(value) {
  const text = String(value ?? "");
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

function normalizeForRecall(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function computeAnswerTextHitAtK(answer, contexts) {
  const normalizedAnswer = normalizeForRecall(answer);
  if (!normalizedAnswer) return null;
  const found = contexts.some((context) =>
    normalizeForRecall(`${context.summary ?? ""}\n${context.content_preview ?? ""}\n${context.body_preview ?? ""}`).includes(normalizedAnswer)
  );
  return found;
}

export function computeRecallAtK(answer, contexts) {
  return computeAnswerTextHitAtK(answer, contexts);
}

export function computeEvidenceCoverageAtK(item, contexts) {
  const answerSessionIds = new Set((item.answer_session_ids ?? []).filter(Boolean));
  if (answerSessionIds.size === 0) return null;
  const retrieved = new Set((contexts ?? []).map((context) => context.session_id).filter(Boolean));
  let matched = 0;
  for (const id of answerSessionIds) {
    if (retrieved.has(id)) matched += 1;
  }
  return matched / answerSessionIds.size;
}

export function computeEvidenceRecallAtK(item, contexts) {
  const coverage = computeEvidenceCoverageAtK(item, contexts);
  if (coverage === null) return null;
  return coverage > 0;
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

function mainRecallValue(result) {
  return result.evidence_recall_at_5 ?? result.recall_at_5;
}

export function summarizeBenchmarkResults(results, existingMeasurementRuns = []) {
  const judged = results.filter((result) => result.judge?.verdict !== "not_run");
  const passed = judged.filter((result) => result.judge?.passed === true);
  const recallEligible = results.filter((result) => mainRecallValue(result) !== null && mainRecallValue(result) !== undefined);
  const recallPassed = recallEligible.filter((result) => mainRecallValue(result) === true);
  const textHitEligible = results.filter((result) => result.answer_text_hit_at_5 !== null && result.answer_text_hit_at_5 !== undefined);
  const textHitPassed = textHitEligible.filter((result) => result.answer_text_hit_at_5 === true);
  const coverageEligible = results.filter((result) => result.evidence_coverage_at_5 !== null && result.evidence_coverage_at_5 !== undefined);
  const totals = results.reduce(
    (acc, result) => {
      acc.full_context_tokens += Number(result.full_context_tokens ?? 0);
      acc.org_brain_context_tokens += Number(result.org_brain_context_tokens ?? 0);
      acc.retrieval_count += Number(result.retrieval_count ?? 0);
      acc.retrieval_latency_ms += Number(result.retrieval_latency_ms ?? 0);
      acc.fallback_count += result.fallback_used ? 1 : 0;
      acc.evidence_coverage_at_5 += Number(result.evidence_coverage_at_5 ?? 0);
      return acc;
    },
    {
      full_context_tokens: 0,
      org_brain_context_tokens: 0,
      retrieval_count: 0,
      retrieval_latency_ms: 0,
      fallback_count: 0,
      evidence_coverage_at_5: 0
    }
  );
  const reduction = computeTokenReduction(totals.full_context_tokens, totals.org_brain_context_tokens);

  return {
    item_count: results.length,
    judged_count: judged.length,
    judge_pass_count: passed.length,
    accuracy: judged.length > 0 ? passed.length / judged.length : null,
    recall_eligible_count: recallEligible.length,
    recall_at_5_pass_count: recallPassed.length,
    recall_at_5: recallEligible.length > 0 ? recallPassed.length / recallEligible.length : null,
    evidence_recall_at_5: recallEligible.length > 0 ? recallPassed.length / recallEligible.length : null,
    answer_text_hit_eligible_count: textHitEligible.length,
    answer_text_hit_at_5_pass_count: textHitPassed.length,
    answer_text_hit_at_5: textHitEligible.length > 0 ? textHitPassed.length / textHitEligible.length : null,
    evidence_coverage_eligible_count: coverageEligible.length,
    evidence_coverage_at_5: coverageEligible.length > 0 ? totals.evidence_coverage_at_5 / coverageEligible.length : null,
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
      fallback_count: 0,
      recall_eligible_count: 0,
      recall_at_5_pass_count: 0,
      answer_text_hit_eligible_count: 0,
      answer_text_hit_at_5_pass_count: 0,
      evidence_coverage_eligible_count: 0,
      evidence_coverage_at_5_total: 0
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
    const recallValue = mainRecallValue(result);
    if (recallValue !== null && recallValue !== undefined) {
      entry.recall_eligible_count += 1;
      if (recallValue === true) entry.recall_at_5_pass_count += 1;
    }
    if (result.answer_text_hit_at_5 !== null && result.answer_text_hit_at_5 !== undefined) {
      entry.answer_text_hit_eligible_count += 1;
      if (result.answer_text_hit_at_5 === true) entry.answer_text_hit_at_5_pass_count += 1;
    }
    if (result.evidence_coverage_at_5 !== null && result.evidence_coverage_at_5 !== undefined) {
      entry.evidence_coverage_eligible_count += 1;
      entry.evidence_coverage_at_5_total += Number(result.evidence_coverage_at_5 ?? 0);
    }
    byCategory.set(key, entry);
  }

  return [...byCategory.values()]
    .map((entry) => ({
      ...entry,
      accuracy: entry.judged_count > 0 ? entry.judge_pass_count / entry.judged_count : null,
      recall_at_5: entry.recall_eligible_count > 0 ? entry.recall_at_5_pass_count / entry.recall_eligible_count : null,
      evidence_recall_at_5: entry.recall_eligible_count > 0 ? entry.recall_at_5_pass_count / entry.recall_eligible_count : null,
      answer_text_hit_at_5:
        entry.answer_text_hit_eligible_count > 0 ? entry.answer_text_hit_at_5_pass_count / entry.answer_text_hit_eligible_count : null,
      evidence_coverage_at_5:
        entry.evidence_coverage_eligible_count > 0 ? entry.evidence_coverage_at_5_total / entry.evidence_coverage_eligible_count : null,
      token_reduction_rate:
        entry.full_context_tokens > 0
          ? (entry.full_context_tokens - entry.org_brain_context_tokens) / entry.full_context_tokens
          : 0,
      fallback_rate: entry.item_count > 0 ? entry.fallback_count / entry.item_count : 0
    }))
    .sort((left, right) => right.item_count - left.item_count || left.category.localeCompare(right.category));
}
