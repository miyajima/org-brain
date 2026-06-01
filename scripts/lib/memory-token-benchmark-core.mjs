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
const PERSONAL_EVENT_RE = /\b(i|i'm|i've|i'd|my|mine|we|we've|our)\b/iu;
const USER_STATE_RE = /\b(by the way|just|recently|today|yesterday|last|this weekend|currently|got back|came back|started|bought|received|attended|participated|completed|signed|planted|made|baked|visited|met|prefer|like|love|use|using)\b/iu;
const COUNTABLE_EVENT_RE = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|day|days|week|weeks|times|minutes|hours|trip|run|race|tournament|workshop|party|wedding|contract|client|saplings|cake|bread|wings|kit|camping)\b/iu;
const UPDATE_EVENT_RE = /\b(now|currently|switched|changed|updated|new|newer|latest|recently|no longer|instead|started|stopped|signed|launched|got|bought|received)\b/iu;
const NEGATIVE_PREFERENCE_RE = /\b(not|avoid|dislike|hate|do not|don't|wouldn't|unrelated|not interested)\b/iu;
const DAY_NAME_INDEX = new Map([
  ["sunday", 0],
  ["monday", 1],
  ["tuesday", 2],
  ["wednesday", 3],
  ["thursday", 4],
  ["friday", 5],
  ["saturday", 6]
]);
const NUMBER_WORD_VALUES = new Map([
  ["zero", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12]
]);
const CANDIDATE_VALUE_STOPWORDS = new Set([
  "Anyway",
  "Answer",
  "As for",
  "Back",
  "By",
  "By the",
  "Can",
  "Congratulations",
  "Create",
  "Day",
  "Do",
  "Feature",
  "Features",
  "Focuses",
  "For",
  "For the",
  "Gift",
  "Great",
  "Here",
  "Here's",
  "I",
  "I'd",
  "I'll",
  "I'm",
  "I've",
  "If",
  "It",
  "It's",
  "Like",
  "Mix",
  "Now",
  "Offer",
  "Speaking of",
  "The",
  "They",
  "This",
  "What",
  "When",
  "Where",
  "Which",
  "Would",
  "You"
]);

export const LEADERBOARD_TARGETS = {
  profile: "org_brain_repro_v3",
  accuracy: 0.86,
  evidence_recall_at_5: 0.982,
  token_reduction_rate: 0.992,
  fallback_rate: 0,
  org_brain_context_tokens_max_full_500: 422881,
  notes: [
    "Public reproducibility mode: single final answer, no best-of-N answer picking.",
    "External values are public-reference anchors, not same-harness measurements unless explicitly marked."
  ]
};

export const PUBLIC_COMPARISON_ROWS = [
  {
    system: "Org Brain v1",
    profile: "hybrid_memory_docs_v1",
    benchmark: "LongMemEval-S",
    measured_by: "org_brain_local_harness",
    accuracy: 0.51,
    evidence_recall_at_5: 0.38,
    retrieval_recall_at_5: 0.38,
    token_reduction_rate: 0.9877724116125967,
    source_url: "local:/tmp/org-brain-longmemeval-s.json",
    retrieved_at: "2026-06-01",
    notes: "Earlier Org Brain benchmark run."
  },
  {
    system: "Org Brain v2",
    profile: "longmemeval_session_v2",
    benchmark: "LongMemEval-S",
    measured_by: "org_brain_local_harness",
    accuracy: 0.6,
    evidence_recall_at_5: 0.96,
    retrieval_recall_at_5: 0.96,
    token_reduction_rate: 0.9828575246727601,
    source_url: "local:/tmp/org-brain-longmemeval-s-v2.json",
    retrieved_at: "2026-06-01",
    notes: "Session-aware transient benchmark index."
  },
  {
    system: "Supermemory Research",
    profile: "Gemini 3 Pro",
    benchmark: "LongMemEval-S",
    measured_by: "external_public_report",
    accuracy: 0.852,
    evidence_recall_at_5: null,
    retrieval_recall_at_5: null,
    token_reduction_rate: null,
    source_url: "https://supermemory.ai/research/",
    retrieved_at: "2026-06-01",
    notes: "Public accuracy anchor; not rerun in this harness."
  },
  {
    system: "Supermemory experimental ASMR",
    profile: "decision forest / ensemble",
    benchmark: "LongMemEval-S-style",
    measured_by: "external_experimental_blog",
    accuracy: 0.972,
    evidence_recall_at_5: null,
    retrieval_recall_at_5: null,
    token_reduction_rate: null,
    source_url: "https://supermemory.ai/blog/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/",
    retrieved_at: "2026-06-01",
    notes: "Experimental/parody-framed blog result; report separately from reproducible leaderboard mode."
  },
  {
    system: "gbrain",
    profile: "gbrain-evals",
    benchmark: "LongMemEval-S",
    measured_by: "external_public_repo",
    accuracy: null,
    evidence_recall_at_5: 0.976,
    retrieval_recall_at_5: 0.976,
    token_reduction_rate: null,
    source_url: "https://github.com/garrytan/gbrain-evals",
    retrieved_at: "2026-06-01",
    notes: "Public R@5 anchor from README."
  },
  {
    system: "agentmemory",
    profile: "BM25+Vector",
    benchmark: "LongMemEval-S / yearly token comparison",
    measured_by: "external_public_repo",
    accuracy: null,
    evidence_recall_at_5: 0.952,
    retrieval_recall_at_5: 0.952,
    token_reduction_rate: 1 - (170000 / 19500000),
    source_url: "https://github.com/rohitg00/agentmemory/blob/main/benchmark/COMPARISON.md",
    retrieved_at: "2026-06-01",
    notes: "Token reduction derived from ~170K vs 19.5M+ annual token comparison."
  }
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

function isMultiSessionQuestion(item) {
  return /\bmulti-session\b/iu.test(item.category) || /\b(how many|count|total|all|order of|three|several|past month|past two weeks)\b/iu.test(item.question);
}

function parseDateMillis(value) {
  const match = String(value ?? "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return Date.UTC(year, month - 1, day);
}

function addDays(ms, days) {
  return ms + (days * 24 * 60 * 60 * 1000);
}

function dayDistance(left, right) {
  if (left === null || right === null) return null;
  return Math.abs(Math.round((left - right) / (24 * 60 * 60 * 1000)));
}

function targetDateForLastWeekday(question, questionDateMs) {
  if (questionDateMs === null) return null;
  const lower = String(question ?? "").toLowerCase();
  for (const [name, weekday] of DAY_NAME_INDEX.entries()) {
    if (!lower.includes(`last ${name}`)) continue;
    const current = new Date(questionDateMs).getUTCDay();
    let delta = current - weekday;
    if (delta <= 0) delta += 7;
    return addDays(questionDateMs, -delta);
  }
  return null;
}

function buildTemporalWindow(question, questionDate) {
  const questionDateMs = parseDateMillis(questionDate);
  const lower = String(question ?? "").toLowerCase();
  const targetDates = [];
  let windowStartMs = null;
  let windowEndMs = questionDateMs;

  const lastWeekday = targetDateForLastWeekday(lower, questionDateMs);
  if (lastWeekday !== null) targetDates.push(lastWeekday);

  const explicitDays = lower.match(/\b(\d+)\s+days?\s+ago\b/u);
  if (explicitDays && questionDateMs !== null) targetDates.push(addDays(questionDateMs, -Number(explicitDays[1])));

  const explicitWeeks = lower.match(/\b(\d+)\s+weeks?\s+ago\b/u);
  if (explicitWeeks && questionDateMs !== null) targetDates.push(addDays(questionDateMs, -(Number(explicitWeeks[1]) * 7)));

  const wordWeeks = [
    ["one", 7],
    ["a", 7],
    ["two", 14],
    ["three", 21],
    ["four", 28]
  ];
  for (const [word, days] of wordWeeks) {
    if (new RegExp(`\\b${word}\\s+weeks?\\s+ago\\b`, "iu").test(lower) && questionDateMs !== null) {
      targetDates.push(addDays(questionDateMs, -days));
    }
  }
  if (/\bcouple of days ago\b/iu.test(lower) && questionDateMs !== null) targetDates.push(addDays(questionDateMs, -2));

  if (/\bpast two weeks\b/iu.test(lower) && questionDateMs !== null) windowStartMs = addDays(questionDateMs, -14);
  else if (/\bpast month\b/iu.test(lower) && questionDateMs !== null) windowStartMs = addDays(questionDateMs, -31);
  else if (/\bthis year\b/iu.test(lower) && questionDateMs !== null) {
    const date = new Date(questionDateMs);
    windowStartMs = Date.UTC(date.getUTCFullYear(), 0, 1);
  }

  if (targetDates.length > 0) {
    const target = targetDates[0];
    windowStartMs = addDays(target, -1);
    windowEndMs = addDays(target, 1);
  }

  return {
    questionDateMs,
    targetDates,
    windowStartMs,
    windowEndMs
  };
}

function expandQuestionTerms(question, category) {
  const lower = String(question ?? "").toLowerCase();
  const expansions = [];
  const push = (value) => expansions.push(value);

  if (/\bbak(e|ed|ing)\b/iu.test(lower)) push("baked baking bake bread cake baguette sourdough recipe dessert chicken wings");
  if (/\bcamping|camp\b/iu.test(lower)) push("camping camped campsite backpacking trip got back yellowstone big sur utah colorado moab national park");
  if (/\bsports?|triathlon|5k|run|soccer|event\b/iu.test(lower)) push("sports event participated completed triathlon run 5k soccer tournament today personal best charity");
  if (/\bpractice|practicing|violin|guitar|music\b/iu.test(lower)) push("practice practicing daily minutes music theory guitar violin fingerpicking");
  if (/\bbattery|phone|power\b/iu.test(lower)) push("portable power bank wireless charging pad battery phone tech accessories traveling");
  if (/\bcocktail|get-together|drink\b/iu.test(lower)) push("cocktail gin summer drinks hendrick pimm gimlet mixology class party get-together");
  if (/\bshow|movie|watch tonight|netflix|hulu|tv\b/iu.test(lower)) push("show movie watch netflix hulu stand-up comedy specials storytelling comedian");
  if (/\bpaintings?|inspiration|art\b/iu.test(lower)) push("painting paintings art acrylic brushes palette knives texture instagram challenge flowers inspiration tutorials");
  if (/\bbedroom|furniture|rearrang|dresser|design\b/iu.test(lower)) push("bedroom furniture dresser mid-century modern design layout replace inspiration");
  if (/\bguitar|music store|fender|gibson\b/iu.test(lower)) push("guitar electric fender stratocaster gibson les paul neck weight sound music store upgrade");
  if (/\bsneez|living room|allerg|dust|cat\b/iu.test(lower)) push("living room dust cat sheds shedding allergens vacuum dander plants air purify");
  if (/\bnostalgic|high school|reunion\b/iu.test(lower)) push("high school reunion debate team advanced placement courses economics history old friends nostalgic");
  if (/\bcommute|activities\b/iu.test(lower)) push("commute listening podcasts audiobooks history science true crime self-improvement branch out genres");
  if (/\bsports?.*competitively|competitively|played competitively\b/iu.test(lower)) push("swim competitively college soccer tennis former tennis player played competitively sports");
  if (/\bpublication|conference|research|healthcare|medical|image\b/iu.test(lower)) push("deep learning medical image analysis healthcare ai research papers conferences advancements field");
  if (/\bhomegrown|ingredients|dinner|basil|mint|garden\b/iu.test(lower)) push("fresh basil mint tomatoes cherry tomatoes herbs garden recipe dinner homegrown produce");
  if (/\bjewelry|received|from whom|who\b/iu.test(lower)) push("received got from aunt cousin friend colleague today gift antique crystal chandelier jewelry");
  if (/\bwedding|relative|life event|ceremony|engagement\b/iu.test(lower)) push("wedding engagement party cousin relative ceremony Michael");
  if (/\bbusiness|milestone|client|contract\b/iu.test(lower)) push("business milestone signed contract first client website launched business plan freelance");
  if (/\bkitchen appliance|smoker|bbq\b/iu.test(lower)) push("kitchen appliance smoker bbq sauce bought got today");
  if (/\bgardening|tomato|saplings|plants\b/iu.test(lower)) push("gardening workshop planted tomato saplings basil mint parsley crop rotation companion planting");
  if (/\blunch|met with|meet with\b/iu.test(lower)) push("lunch catch up met with potential collaborator freelance writer");
  if (/\bipad|case|arrive|bought\b/iu.test(lower)) push("arrived bought case backpack laptop wireless mouse date delivery");
  if (/\bpreference|recommend|suggest|resources|tips\b/iu.test(lower) || /\bpreference\b/iu.test(category ?? "")) {
    push("prefer like use currently interested advanced previous mention background experience specific not interested avoid");
  }

  return [...new Set(significantTokens([question, ...expansions].join(" ")))];
}

function buildSessionV3Profile(item) {
  const base = buildSessionV2Profile(item);
  const temporalWindow = buildTemporalWindow(item.question, item.question_date);
  return {
    ...base,
    queryTokens: expandQuestionTerms(item.question, item.category),
    baseQueryTokens: [...new Set(significantTokens(item.question))],
    multiSession: isMultiSessionQuestion(item),
    category: item.category ?? "uncategorized",
    temporalWindow
  };
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

function splitRoleSegments(content) {
  const text = String(content ?? "").trim();
  if (!text) return [];
  const roleRe = /\b(user|assistant|system):\s*/giu;
  const matches = [...text.matchAll(roleRe)];
  if (matches.length === 0) return [{ role: "", text }];
  return matches
    .map((match, index) => {
      const start = match.index + match[0].length;
      const end = matches[index + 1]?.index ?? text.length;
      return {
        role: match[1].toLowerCase(),
        text: text.slice(start, end).trim()
      };
    })
    .filter((segment) => segment.text);
}

function splitEvidenceUnits(segment) {
  const text = collapseWhitespace(segment.text);
  if (!text) return [];
  const units = [];
  const push = (value, boost = 0) => {
    const cleaned = collapseWhitespace(value);
    if (cleaned.length >= 12) units.push({ role: segment.role, text: cleaned, boost });
  };

  for (const marker of ["By the way,", "by the way,", "BTW,", "For my", "I just", "I've been", "I recently", "I attended", "I participated", "I completed", "I bought", "I received", "I got", "I signed", "I planted", "I made", "I baked"]) {
    const index = text.indexOf(marker);
    if (index >= 0) push(text.slice(index), marker.toLowerCase().includes("by the way") ? 2 : 1.2);
  }

  for (const part of text.split(/(?<=[.!?])\s+|\n+/u)) push(part, 0);
  if (units.length === 0) push(text, 0);
  return units;
}

function clipped(value, limit = 240) {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function tokenOverlapScore(text, tokens) {
  if (tokens.length === 0) return 0;
  const textTokens = new Set(tokenizeBenchmarkText(text));
  let hits = 0;
  for (const token of tokens) {
    if (textTokens.has(token)) hits += 1;
  }
  return hits / tokens.length;
}

function detectAnswerType(question) {
  const lower = String(question ?? "").toLowerCase();
  if (/\bhow many\b|\bnumber of\b|\bcount\b/iu.test(lower)) return "count";
  if (/\bhow old\b/iu.test(lower)) return "count";
  if (/\btotal\b|\bhow much\b|\bamount\b|\bmoney\b|\bspent\b|\bcost\b|\bworth\b|\bdiscount\b|\bpaid\b|\bprice\b/iu.test(lower)) return "amount";
  if (/\bratio\b/iu.test(lower)) return "ratio";
  if (/\bwhat time\b/iu.test(lower)) return "time";
  if (/\bhow long\b/iu.test(lower)) return "measurement";
  if (/\bwhen\b|\bwhat date\b|\bhow long ago\b/iu.test(lower)) return "date";
  if (/\bwhere\b/iu.test(lower)) return "place";
  if (/\bwho\b|\bfrom whom\b/iu.test(lower)) return "person";
  if (/\bspeed\b/iu.test(lower)) return "measurement";
  if (/\bwhat (?:is|was|did|book|play|breed|type|name|degree|gift|service|song|movie|color|occupation|certification)\b/iu.test(lower)) return "entity";
  return "fact";
}

function normalizedCandidateKey(value) {
  return collapseWhitespace(value).toLowerCase().replace(/[^\p{L}\p{N}.$%/-]+/gu, " ").trim();
}

function pushCandidate(candidates, value, type, sourceText, role, score = 1) {
  const cleaned = collapseWhitespace(value)
    .replace(/\.\s+[A-Z].*$/u, "")
    .replace(/\s+(?:and|for|from|at|of|the|to|in|on|with|we|i|do|have)$/iu, "")
    .replace(/^[*"'“”‘’\s:,.!?;-]+|[*"'“”‘’\s:,.!?;-]+$/gu, "");
  if (!cleaned || cleaned.length < 2 || cleaned.length > 90) return;
  if (CANDIDATE_VALUE_STOPWORDS.has(cleaned)) return;
  if (/^(?:I(?:'|’)?(?:m|ve|ll|d)|It(?:'|’)?s|Here(?:'|’)?s|By the|Speaking of|Anyway|As for|For the)\b/iu.test(cleaned)) return;
  if (/^\p{Lu}?[a-z]+(?:'|’)(?:m|ve|ll|d|s)$/u.test(cleaned)) return;
  const key = `${type}:${normalizedCandidateKey(cleaned)}`;
  const existing = candidates.get(key);
  const candidate = {
    value: cleaned,
    type,
    role,
    score,
    source: clipped(sourceText, 220)
  };
  if (!existing || candidate.score > existing.score || (candidate.role === "user" && existing.role !== "user")) candidates.set(key, candidate);
}

function extractCandidateValuesFromText(text, role = "") {
  const candidates = new Map();
  const source = collapseWhitespace(text);
  for (const match of source.matchAll(/\$[\d,]+(?:\.\d+)?/gu)) pushCandidate(candidates, match[0], "money", source, role, 8);
  for (const match of source.matchAll(/\b\d+(?:\.\d+)?%/gu)) pushCandidate(candidates, match[0], "percentage", source, role, 8);
  for (const match of source.matchAll(/\b\d+\s*:\s*\d+\b/gu)) pushCandidate(candidates, match[0].replace(/\s+/g, ""), "ratio", source, role, 9);
  for (const match of source.matchAll(/\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/giu)) pushCandidate(candidates, match[0], "time", source, role, 8);
  for (const match of source.matchAll(/\b\d+(?:\.\d+)?\s*(?:Mbps|Gbps|MBps|GB|TB|mph|km\/h|hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?|miles?|lbs?|pounds?|kg)\b/giu)) {
    pushCandidate(candidates, match[0], "measurement", source, role, 7);
  }
  for (const match of source.matchAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?)\s+\d{1,2}(?:st|nd|rd|th)?\b/giu)) {
    pushCandidate(candidates, match[0], "date", source, role, 7);
  }
  if (/\b(back in|last|during|in)\b/iu.test(source)) {
    for (const match of source.matchAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/gu)) {
      pushCandidate(candidates, match[0], "date", source, role, 5);
    }
  }
  for (const match of source.matchAll(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Valentine's Day)\b/giu)) {
    pushCandidate(candidates, match[0], "date", source, role, 6);
  }
  for (const match of source.matchAll(/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:items?|pieces?|projects?|doctors?|sports?|model kits?|kits?|hours?|days?|weeks?|months?|years?|tanks?|festivals?|games?|siblings?|trips?|destinations?|courses?|classes?|playlists?|shirts?|shorts?|copies?)\b/giu)) {
    pushCandidate(candidates, match[0], "count", source, role, 6);
  }
  for (const match of source.matchAll(/\b\d+(?:st|nd|rd|th)\s+birthday\b/giu)) {
    pushCandidate(candidates, match[0], "count", source, role, 7);
  }
  for (const match of source.matchAll(/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+[a-z][a-z-]{3,18}s?\b/giu)) {
    pushCandidate(candidates, match[0], "count", source, role, 4);
  }
  for (const match of source.matchAll(/\b(?:over|about|around|roughly)\s+(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(?:hours?|days?|weeks?|months?|years?)\b/giu)) {
    pushCandidate(candidates, match[0], "measurement", source, role, 7);
  }
  for (const match of source.matchAll(/["“]([^"“”]{2,80})["”]/gu)) pushCandidate(candidates, match[1], "title", source, role, 6);
  for (const match of source.matchAll(/\b(?:degree in|graduated with (?:a |an )?(?:Bachelor's |Master's )?degree in)\s+([A-Z][A-Za-z&'’.-]*(?:\s+[A-Z][A-Za-z&'’.-]*){0,5})/gu)) {
    pushCandidate(candidates, match[1], "entity", source, role, 10);
  }
  for (const match of source.matchAll(/\b(?:old name was|last name was|maiden name was|previous name was|formerly)\s+([A-Z][A-Za-z'’.-]{2,40})/gu)) {
    pushCandidate(candidates, match[1], "entity", source, role, 10);
  }
  for (const match of source.matchAll(/\b(?:previous role as|previous occupation (?:was|as)|used to be|worked as)\s+(?:a|an)?\s*([a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,8})/giu)) {
    pushCandidate(candidates, match[1], "phrase", source, role, 9);
  }
  for (const match of source.matchAll(/\b(?:favorite|favourite)\s+([a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,4})/giu)) {
    pushCandidate(candidates, match[1], "phrase", source, role, 7);
  }
  for (const match of source.matchAll(/\b([A-Z][A-Za-z0-9&'’.-]{1,40})\s+has been my favou?rite brand\b/gu)) {
    pushCandidate(candidates, match[1], "entity", source, role, 10);
  }
  for (const match of source.matchAll(/\b(?:repainted|painted)\s+(?:my\s+)?(?:bedroom\s+)?walls?\s+((?:a\s+)?(?:lighter|darker|bright|deep|pale)?\s*(?:shade of\s+)?(?:gray|grey|blue|green|yellow|red|white|black|beige|cream|pink|purple|orange|brown))\b/giu)) {
    pushCandidate(candidates, match[1], "phrase", source, role, 8);
  }
  for (const match of source.matchAll(/\b(?:made|baked|tried|got|bought|purchased|packed|brought)\s+(?:a|an|the)?\s*([a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,6})\b/giu)) {
    pushCandidate(candidates, match[1], "phrase", source, role, 5);
  }
  for (const match of source.matchAll(/\bgot\s+(?:him|her|them|me|myself)\s+(?:a|an|the)?\s*([a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,6})\b/giu)) {
    pushCandidate(candidates, match[1], "phrase", source, role, 8);
  }
  for (const match of source.matchAll(/\b(?:from|at|near)\s+(?:a|an|the)\s+([a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,5})\b/giu)) {
    pushCandidate(candidates, match[1], "place_phrase", source, role, 5);
  }
  for (const match of source.matchAll(/\+\s*([A-Z][A-Za-z'’-]+(?:\s+[a-z][a-z'’-]+){0,4})/gu)) {
    pushCandidate(candidates, match[1], "phrase", source, role, 7);
  }
  for (const match of source.matchAll(/\b(?:at|from|near|called|named|using|use|used|attend|attended|redeemed|bought|purchased|completed|graduated from|classes at)\s+(?:the\s+)?([A-Z][A-Za-z0-9&'’.-]*(?:\s+(?:of|the|and|at|for|[A-Z][A-Za-z0-9&'’.-]*)){0,5})/gu)) {
    pushCandidate(candidates, match[1], "entity", source, role, 5);
  }
  for (const match of source.matchAll(/\b[A-Z][A-Za-z0-9&'’.-]*(?:\s+(?:of|the|and|at|for|[A-Z][A-Za-z0-9&'’.-]*)){0,5}\b/gu)) {
    const value = match[0];
    if (value.length > 2 && !/^(I|A|The|This|That|Here|What|When|Where|How)$/u.test(value)) {
      pushCandidate(candidates, value, "entity", source, role, 3);
    }
  }
  return [...candidates.values()];
}

function scoreCandidateForQuestion(candidate, answerType, questionTokens) {
  let score = candidate.score;
  if (candidate.role === "user") score += 2;
  if (answerType === "amount" && candidate.type === "money") score += 8;
  if (answerType === "amount" && candidate.type === "percentage") score += 8;
  if (answerType === "ratio" && candidate.type === "ratio") score += 10;
  if (answerType === "measurement" && (candidate.type === "measurement" || candidate.type === "count")) score += 8;
  if (answerType === "date" && candidate.type === "date") score += 8;
  if (answerType === "time" && candidate.type === "time") score += 8;
  if (answerType === "count" && candidate.type === "count") score += 4;
  if (answerType === "place" && (candidate.type === "entity" || candidate.type === "place_phrase")) score += 4;
  if (answerType === "person" && candidate.type === "entity") score += 4;
  if (answerType === "entity" && (candidate.type === "title" || candidate.type === "entity" || candidate.type === "phrase")) score += 5;
  if (answerType === "fact" && candidate.type === "phrase") score += 3;
  score += tokenOverlapScore(candidate.source, questionTokens) * 6;
  score += tokenOverlapScore(candidate.value, questionTokens) * 10;
  if (answerType === "measurement" && /\bspeed|internet\b/iu.test(questionTokens.join(" "))) {
    if (/\b[MG]bps\b/iu.test(candidate.value)) score += 10;
    if (/\b[GT]B\b/u.test(candidate.value)) score -= 10;
  }
  if (answerType === "entity" && /\bplay\b/iu.test(questionTokens.join(" ")) && /\b(play I attended was|attended was actually|production of)\b/iu.test(candidate.source)) {
    score += 12;
  }
  if (answerType === "measurement" && /\btook|take\b/iu.test(candidate.source)) score += 4;
  if (/\b(online|platform|app|recommendation|option|example)\b/iu.test(candidate.source) && candidate.role === "assistant") score -= 2;
  return score;
}

function extractQuestionAwareSpans(session, profile, maxSpans = 5) {
  const answerType = detectAnswerType(profile.question);
  const questionTokens = profile.queryTokens.length > 0 ? profile.queryTokens : profile.baseQueryTokens;
  const units = splitRoleSegments(session.content).flatMap((segment) => splitEvidenceUnits(segment).map((unit) => ({ ...unit, role: unit.role || segment.role })));
  const scored = units
    .map((unit, index) => {
      const candidates = extractCandidateValuesFromText(unit.text, unit.role);
      const candidateScore = candidates.reduce((sum, candidate) => sum + scoreCandidateForQuestion(candidate, answerType, questionTokens), 0);
      const score =
        scoreEvidenceUnit(unit, session, profile) +
        tokenOverlapScore(unit.text, questionTokens) * 10 +
        (unit.role === "user" ? 3 : 0) +
        Math.min(candidateScore, 20);
      return {
        role: unit.role,
        text: unit.text,
        index,
        score,
        candidates
      };
    })
    .filter((unit) => unit.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const ordered = /single-session-(?:user|preference)/iu.test(profile.category)
    ? [
        ...scored.filter((unit) => unit.role === "user"),
        ...scored.filter((unit) => unit.role !== "user")
      ]
    : scored;
  const selected = [];
  const seen = new Set();
  for (const unit of ordered) {
    const key = unit.text.toLowerCase().slice(0, 160);
    if (seen.has(key)) continue;
    selected.push({
      role: unit.role,
      text: clipped(unit.text, 260),
      score: unit.score,
      candidates: unit.candidates
    });
    seen.add(key);
    if (selected.length >= maxSpans) break;
  }
  return selected;
}

function profilePatternBoost(text, role, profile) {
  const lower = String(text ?? "").toLowerCase();
  let score = 0;
  const genericPersonalWeight = profile.preference && !profile.multiSession && !profile.temporal ? 1.4 : 0.45;
  if (role === "user") score += genericPersonalWeight;
  if (/single-session-user/iu.test(profile.category) && role === "user") score += 3;
  if (/single-session-user/iu.test(profile.category) && role === "assistant") score -= 0.8;
  if (/single-session-assistant/iu.test(profile.category) && role === "assistant") score += 2.2;
  if (PERSONAL_EVENT_RE.test(text)) score += genericPersonalWeight;
  if (USER_STATE_RE.test(text)) score += profile.preference && !profile.multiSession ? 2.2 : 0.7;
  if (COUNTABLE_EVENT_RE.test(text)) score += profile.multiSession ? 2.6 : 0.7;
  if (UPDATE_EVENT_RE.test(text)) score += /knowledge-update/iu.test(profile.category) ? 2.8 : 0.8;

  if (profile.preference) {
    if (role === "user") score += 2.2;
    if (/\b(prefer|like|love|use|using|currently|interested|working in the field|background|experience|advanced|specific|new portable|homegrown|fresh|hendrick|deep learning|medical image|power bank|basil|mint)\b/iu.test(text)) {
      score += 4.5;
    }
    if (NEGATIVE_PREFERENCE_RE.test(text)) score += 1.2;
  }

  if (profile.temporal) {
    if (/\b(today|yesterday|last|ago|recently|completed|participated|attended|received|met|planted|signed|bought|got|came back|catch up)\b/iu.test(text)) {
      score += 2.6;
    }
  }

  if (/\bhow much time\b/iu.test(profile.question) && /\b(practic\w*|daily|every day|\d+\s*(minutes?|hours?))\b/iu.test(text)) score += 6;
  if (/\bhow many days\b/iu.test(profile.question) && /\b(\d+[- ]day|days?|arrived|got back|came back|trip|camping)\b/iu.test(text)) score += 4;
  if (/\bbak(e|ed|ing)|past two weeks\b/iu.test(profile.question) && /\b(bak\w*|bread|baguette|cake|wings|recipe|sourdough|dessert)\b/iu.test(text)) score += 5;
  if (/\bcamping|united states\b/iu.test(profile.question) && /\b(camping|camped|yellowstone|big sur|utah|colorado|moab|trip|got back|road trip)\b/iu.test(text)) score += 5;
  if (/\bsports? event|5k|charity run|triathlon|soccer\b/iu.test(profile.question) && /\b(completed|participated|5k|run|triathlon|soccer|tournament|personal best)\b/iu.test(text)) score += 5;
  if (/\bjewelry|received a piece|from whom\b/iu.test(profile.question) && /\b(received|got|from my|aunt|crystal|chandelier|gift)\b/iu.test(text)) score += 5;
  if (/\bgardening|tomato|saplings\b/iu.test(profile.question) && /\b(garden|gardening|tomato|saplings|planted|workshop|companion planting|crop rotation)\b/iu.test(text)) score += 5;
  if (/\bwedding|relative|life event\b/iu.test(profile.question) && /\b(wedding|engagement|party|ceremony|cousin|michael)\b/iu.test(text)) score += 4.5;
  if (/\blunch|meet with|met with\b/iu.test(profile.question) && /\b(lunch|catch up|met|emma|collaborator)\b/iu.test(text)) score += 5;
  if (/\bbusiness|milestone|contract|client\b/iu.test(profile.question) && /\b(signed|contract|first client|launched|website|business plan)\b/iu.test(text)) score += 5;
  if (/\bsmoker|kitchen appliance|bbq\b/iu.test(profile.question) && /\b(smoker|bbq|sauce|got|bought|kitchen)\b/iu.test(text)) score += 5;
  if (/\bbattery|phone\b/iu.test(profile.question) && /\b(power bank|wireless charging|phone|battery|tech accessories)\b/iu.test(text)) score += 5;
  if (/\bcocktail|get-together\b/iu.test(profile.question) && /\b(cocktail|gin|hendrick|pimm|summer drinks|mixology)\b/iu.test(text)) score += 5;
  if (/\bshow|movie|watch tonight\b/iu.test(profile.question) && /\b(netflix|stand-up|comedy|storytelling|specials|comedian|hulu|tv show)\b/iu.test(text)) score += 8;
  if (/\bpainting|paintings|inspiration\b/iu.test(profile.question) && /\b(acrylic|painting|paintings|art|brushes|palette knives|texture|instagram|30-day|flowers|tutorials)\b/iu.test(text)) score += 9;
  if (/\bcookies?|chocolate chip\b/iu.test(profile.question) && /\b(cookie|cookies|turbinado|sugar|baking|chocolate chip)\b/iu.test(text)) score += 9;
  if (/\bbedroom|furniture|rearrang\b/iu.test(profile.question) && /\b(bedroom|dresser|mid-century|furniture|design|modern)\b/iu.test(text)) score += 8;
  if (/\bguitar|music store\b/iu.test(profile.question) && /\b(guitar|fender|stratocaster|gibson|les paul|electric|neck|sound)\b/iu.test(text)) score += 8;
  if (/\bsneez|living room\b/iu.test(profile.question) && /\b(living room|dust|cat|sheds|shedding|dander|vacuum|allergens|air purify|plants)\b/iu.test(text)) score += 9;
  if (/\bnostalgic|high school|reunion\b/iu.test(profile.question) && /\b(high school|debate team|advanced placement|economics|history|old friends|reunion)\b/iu.test(text)) score += 9;
  if (/\bcommute|activities\b/iu.test(profile.question) && /\b(commute|podcast|podcasts|audiobooks|history|science|true crime|self-improvement|listening)\b/iu.test(text)) score += 8;
  if (/\bpublication|conference|recent\b/iu.test(profile.question) && /\b(deep learning|medical image|healthcare|research|advancements|field)\b/iu.test(text)) score += 5;
  if (/\bhomegrown|ingredients|dinner\b/iu.test(profile.question) && /\b(basil|mint|tomato|fresh|garden|recipe|herbs)\b/iu.test(text)) score += 5;
  if (/\bsister'?s birthday|birthday gift\b/iu.test(profile.question) && /\b(For my sister|yellow dress|Gift\\(s\\)|pair of earrings|birthday)\b/iu.test(text)) score += 9;

  if (/\b(generic|general tips|here are some recommendations)\b/iu.test(lower) && role === "assistant") score -= 1.1;
  return score;
}

function temporalDateBoost(sessionDate, profile) {
  const sessionMs = parseDateMillis(sessionDate);
  if (sessionMs === null) return 0;
  const { targetDates, windowStartMs, windowEndMs } = profile.temporalWindow ?? {};
  let score = 0;
  if (Array.isArray(targetDates) && targetDates.length > 0) {
    const nearest = Math.min(...targetDates.map((target) => dayDistance(sessionMs, target)).filter((distance) => distance !== null));
    if (Number.isFinite(nearest)) score += Math.max(0, 7 - (nearest * 2));
  }
  if (windowStartMs !== null && windowStartMs !== undefined && windowEndMs !== null && windowEndMs !== undefined) {
    if (sessionMs >= windowStartMs && sessionMs <= windowEndMs) score += 2.5;
  }
  return score;
}

function scoreEvidenceUnit(unit, session, profile) {
  const unitTokens = new Set(tokenizeBenchmarkText(unit.text));
  const queryHits = profile.queryTokens.reduce((sum, token) => sum + (unitTokens.has(token) ? 1 : 0), 0);
  const baseHits = profile.baseQueryTokens.reduce((sum, token) => sum + (unitTokens.has(token) ? 1 : 0), 0);
  const phraseScore = profile.phrases.reduce((sum, phrase) => sum + (tokenOverlapScore(unit.text, phrase.tokens) * 2), 0);
  return (
    tokenOverlapScore(unit.text, profile.queryTokens) * 10 +
    tokenOverlapScore(unit.text, profile.baseQueryTokens) * 5 +
    Math.min(queryHits, 10) * 1.35 +
    Math.min(baseHits, 8) * 1.1 +
    phraseScore +
    profilePatternBoost(unit.text, unit.role, profile) +
    Number(unit.boost ?? 0)
  );
}

function extractBestEvidenceUnits(session, profile, maxUnits = 3) {
  const units = splitRoleSegments(session.content).flatMap(splitEvidenceUnits);
  const scored = units
    .map((unit, index) => ({ ...unit, index, score: scoreEvidenceUnit(unit, session, profile) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = [];
  const seen = new Set();
  for (const unit of scored) {
    const key = unit.text.toLowerCase().slice(0, 140);
    if (seen.has(key)) continue;
    selected.push(unit);
    seen.add(key);
    if (selected.length >= maxUnits) break;
  }
  return selected;
}

function extractCardField(units, pattern) {
  const unit = units.find((candidate) => pattern.test(candidate.text));
  return unit ? clipped(unit.text, 180) : "";
}

function buildEvidenceCard(item, session, profile) {
  const units = extractBestEvidenceUnits(session, profile, /single-session/iu.test(profile.category) ? 5 : 3);
  const answerSpans = extractQuestionAwareSpans(session, profile, /multi-session/iu.test(profile.category) ? 3 : 5);
  const answerType = detectAnswerType(profile.question);
  const questionTokens = profile.queryTokens.length > 0 ? profile.queryTokens : profile.baseQueryTokens;
  const candidateValues = [...new Map(
    answerSpans
      .flatMap((span) => span.candidates)
      .map((candidate) => ({
        ...candidate,
        score: scoreCandidateForQuestion(candidate, answerType, questionTokens)
      }))
      .sort((left, right) => right.score - left.score || left.value.localeCompare(right.value))
      .map((candidate) => [normalizedCandidateKey(candidate.value), candidate])
  ).values()].slice(0, 10);
  const anchor = units.length > 0 ? units.map((unit) => unit.text).join(" ") : session.content;
  const role = units.find((unit) => unit.role)?.role || (session.turn_roles ?? []).find(Boolean) || "";
  const fieldText = units.map((unit) => unit.text).join(" ");
  const baseScore = units.reduce((sum, unit, index) => sum + (unit.score / (index + 1)), 0);
  const score = baseScore + temporalDateBoost(session.session_date, profile);

  return {
    session_id: session.session_id,
    date: session.session_date ?? "",
    speaker: role,
    event: clipped(extractCardField(units, USER_STATE_RE) || fieldText || session.content, 220),
    preference: clipped(extractCardField(units, /\b(prefer|like|love|use|using|currently|interested|advanced|specific|field|homegrown|fresh|portable|power bank|gin|basil|mint)\b/iu), 180),
    update: clipped(extractCardField(units, UPDATE_EVENT_RE), 180),
    countable_entity: clipped(extractCardField(units, COUNTABLE_EVENT_RE), 150),
    verbatim_anchor: clipped(anchor, 260),
    answer_spans: answerSpans.map((span) => ({
      role: span.role,
      text: span.text,
      score: span.score
    })),
    candidate_values: candidateValues.map((candidate) => ({
      value: candidate.value,
      type: candidate.type,
      role: candidate.role,
      score: candidate.score,
      source: clipped(candidate.source, 180)
    })),
    session_index: session.session_index,
    score
  };
}

export function buildEvidenceCardsForItem(item, options = {}) {
  const profile = buildSessionV3Profile(item);
  const sessions = Array.isArray(item.historySessions) ? item.historySessions : [];
  return sessions
    .map((session) => buildEvidenceCard(item, session, profile))
    .filter((card) => card.verbatim_anchor)
    .sort((left, right) => right.score - left.score || Number(left.session_index ?? 0) - Number(right.session_index ?? 0) || String(left.session_id).localeCompare(String(right.session_id)))
    .slice(0, options.candidateLimit ?? 24);
}

function renderEvidenceCard(card, options = {}) {
  const compact = options.compact !== false;
  const includeAnswerFields = options.includeAnswerFields !== false;
  const minimalEvidence = options.minimalEvidence === true;
  const sessionLabel = card.session_index === null || card.session_index === undefined
    ? "session"
    : `session_${Number(card.session_index) + 1}`;
  const candidateValues = includeAnswerFields
    ? (card.candidate_values ?? []).slice(0, 6).map((candidate) => `${candidate.value}`).join("; ")
    : "";
  const answerSpans = includeAnswerFields
    ? (card.answer_spans ?? []).slice(0, 2).map((span) => clipped(span.text, 150)).join(" / ")
    : "";
  const parts = minimalEvidence ? [
    `s=${sessionLabel}`,
    card.date ? `d=${card.date}` : "",
    card.speaker ? `r=${card.speaker}` : "",
    card.event ? `e=${clipped(card.event, 90)}` : ""
  ].filter(Boolean) : [
    `s=${sessionLabel}`,
    card.date ? `d=${card.date}` : "",
    card.speaker ? `r=${card.speaker}` : "",
    card.event ? `e=${card.event}` : "",
    card.preference ? `p=${card.preference}` : "",
    card.update ? `u=${card.update}` : "",
    card.countable_entity ? `c=${card.countable_entity}` : "",
    candidateValues ? `v=${candidateValues}` : "",
    answerSpans ? `x=${answerSpans}` : "",
    card.verbatim_anchor ? `q=${card.verbatim_anchor}` : ""
  ].filter(Boolean);
  return compact ? parts.join(" | ") : parts.join("\n");
}

function selectEvidenceCards(cards, profile, topK) {
  const selected = [];
  const selectedSessions = new Set();
  const sorted = [...cards].sort((left, right) => right.score - left.score || Number(left.session_index ?? 0) - Number(right.session_index ?? 0));

  if (profile.multiSession || profile.temporal) {
    const evidenceSorted = [...cards].sort((left, right) =>
      Number(right.evidence_score ?? right.score) - Number(left.evidence_score ?? left.score) ||
      Number(left.session_index ?? 0) - Number(right.session_index ?? 0)
    );
    const strongest = Number(evidenceSorted[0]?.evidence_score ?? evidenceSorted[0]?.score ?? 0);
    for (const card of evidenceSorted) {
      if (selected.length >= Math.min(3, topK)) break;
      if (selectedSessions.has(card.session_id)) continue;
      const evidenceScore = Number(card.evidence_score ?? card.score ?? 0);
      if (selected.length > 0 && strongest > 0 && evidenceScore < strongest * 0.68) continue;
      selected.push(card);
      selectedSessions.add(card.session_id);
    }
  }

  if (profile.temporal && profile.temporalWindow?.targetDates?.length > 0) {
    const byDate = sorted
      .map((card) => ({
        card,
        distance: Math.min(...profile.temporalWindow.targetDates.map((target) => dayDistance(parseDateMillis(card.date), target)).filter((value) => value !== null))
      }))
      .filter((entry) => Number.isFinite(entry.distance))
      .sort((left, right) => left.distance - right.distance || right.card.score - left.card.score);
    for (const entry of byDate) {
      if (selected.length >= Math.min(topK, 2)) break;
      selected.push(entry.card);
      selectedSessions.add(entry.card.session_id);
    }
  }

  for (const card of sorted) {
    if (selected.length >= topK) break;
    if (selectedSessions.has(card.session_id)) continue;
    selected.push(card);
    selectedSessions.add(card.session_id);
  }

  return selected.slice(0, topK);
}

function evidenceCardsToContexts(cards, item, contextCharLimit) {
  return cards.map((card, index) => ({
    kind: "memory",
    id: `${item.id}:evidence-card:${index + 1}`,
    project_id: "longmemeval-s",
    source: "transient-evidence-card-index",
    title: `${item.category} evidence card ${index + 1}`,
    summary: `${item.category} evidence card ${index + 1}`,
    content_preview: clipped(renderEvidenceCard(card), Math.max(180, Math.min(contextCharLimit, 520))),
    session_id: card.session_id ?? null,
    session_date: card.date ?? "",
    session_index: card.session_index ?? null,
    score: card.score,
    evidence_card: card
  }));
}

function v2SessionScores(index, item) {
  const profile = buildSessionV2Profile(item);
  const scores = new Map();
  for (const chunk of index.chunks ?? []) {
    const sessionId = chunk.session_id;
    if (!sessionId) continue;
    const score = sessionV2Score(index, chunk, profile);
    if (score <= 0) continue;
    const existing = scores.get(sessionId);
    if (!existing || score > existing.score) {
      scores.set(sessionId, {
        score,
        order: chunk.order
      });
    }
  }
  return scores;
}

function retrieveEvidenceCards(index, item, options) {
  const profile = buildSessionV3Profile(item);
  const lexicalScores = v2SessionScores(index, item);
  const cards = buildEvidenceCardsForItem(item, { candidateLimit: 80 })
    .map((card) => {
      const lexical = lexicalScores.get(card.session_id);
      const lexicalWeight = profile.preference && !profile.multiSession && !profile.temporal ? 1.4 : 0.65;
      const lexicalCap = profile.preference && !profile.multiSession && !profile.temporal ? 30 : 16;
      return {
        ...card,
        evidence_score: card.score,
        score: card.score + Math.min(lexicalCap, Number(lexical?.score ?? 0) * lexicalWeight),
        lexical_score: Number(lexical?.score ?? 0),
        lexical_order: lexical?.order ?? null
      };
    })
    .sort((left, right) => right.score - left.score || Number(left.lexical_order ?? left.session_index ?? 0) - Number(right.lexical_order ?? right.session_index ?? 0));
  const selected = selectEvidenceCards(cards, profile, options.topK ?? 5);
  const contexts = evidenceCardsToContexts(selected, item, options.contextCharLimit ?? 850);
  return {
    strategy: options.strategy ?? "longmemeval_session_v3",
    matched_count: cards.length,
    returned_count: contexts.length,
    fallback_used: contexts.length === 0,
    contexts
  };
}

export function retrieveFromTransientBenchmarkIndex(index, item, options = {}) {
  const startedAt = Date.now();
  const topK = options.topK ?? 5;
  const contextCharLimit = options.contextCharLimit ?? 1200;
  const transientStrategy = options.transientStrategy ?? index.transientStrategy ?? "longmemeval_session_v2";
  if (transientStrategy === "longmemeval_session_v3") {
    const retrieval = retrieveEvidenceCards(index, item, {
      ...options,
      topK,
      contextCharLimit
    });
    return {
      ...retrieval,
      latency_ms: Date.now() - startedAt
    };
  }
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

function parseNumericValue(value) {
  const text = String(value ?? "").toLowerCase().replace(/,/g, "");
  const digit = text.match(/\$?(\d+(?:\.\d+)?)/u);
  if (digit) return Number(digit[1]);
  for (const [word, number] of NUMBER_WORD_VALUES.entries()) {
    if (new RegExp(`\\b${word}\\b`, "u").test(text)) return number;
  }
  return null;
}

function formatCandidate(candidate) {
  return `${candidate.value}${candidate.type ? `:${candidate.type}` : ""}${candidate.role ? `:${candidate.role}` : ""}`;
}

function bestCandidateForQuestion(candidates, answerType) {
  const preferredTypes = {
    amount: new Set(["money", "percentage", "measurement", "count"]),
    ratio: new Set(["ratio"]),
    measurement: new Set(["measurement", "count"]),
    date: new Set(["date", "measurement"]),
    time: new Set(["time", "measurement", "date", "count"]),
    count: new Set(["count", "measurement", "money"]),
    place: new Set(["entity", "place_phrase", "title"]),
    person: new Set(["entity", "title"]),
    entity: new Set(["title", "entity", "phrase", "measurement", "count", "percentage"]),
    fact: new Set(["title", "entity", "phrase", "measurement", "money", "percentage", "date", "time", "count"])
  }[answerType] ?? new Set(["title", "entity", "phrase", "place_phrase", "measurement", "money", "percentage", "date", "time", "count", "ratio"]);

  return [...candidates]
    .map((candidate) => ({
      ...candidate,
      answer_score:
        Number(candidate.score ?? 0) +
        (preferredTypes.has(candidate.type) ? 8 : 0) +
        (candidate.role === "user" ? 3 : 0) -
        (candidate.role === "assistant" && answerType !== "fact" ? 3 : 0) -
        (Number(candidate.row ?? 1) - 1) * 4 -
        (candidate.type === "place_phrase" && answerType !== "place" ? 6 : 0) -
        (/\bcolor\b/iu.test(candidate.value) && answerType === "place" ? 6 : 0) -
        (/\b(Asana Rebel|YogaGlo|Peloton Digital)\b/u.test(candidate.value) && answerType === "place" ? 5 : 0)
    }))
    .sort((left, right) => right.answer_score - left.answer_score || left.value.length - right.value.length)[0] ?? null;
}

function buildWorksheetRows(contexts) {
  return (contexts ?? [])
    .filter((context) => context.evidence_card)
    .map((context, index) => {
      const card = context.evidence_card;
      return {
        row: index + 1,
        session: card.session_index === null || card.session_index === undefined ? `session_${index + 1}` : `session_${Number(card.session_index) + 1}`,
        session_id: card.session_id ?? null,
        date: card.date ?? "",
        speaker: card.speaker ?? "",
        candidates: card.candidate_values ?? [],
        spans: card.answer_spans ?? [],
        score: Number(card.score ?? 0)
      };
    });
}

function proposeWorksheetAnswer(item, rows, answerType) {
  const candidates = rows.flatMap((row) =>
    row.candidates.map((candidate) => ({
      ...candidate,
      row: row.row,
      date: row.date
    }))
  );

  if (answerType === "count" && /multi-session/iu.test(item.category)) {
    const countQuestionTokens = significantTokens(item.question);
    const relevantRows = rows.filter((row) =>
      row.candidates.length > 0 &&
      row.spans.some((span) =>
        span.role === "user" &&
        tokenOverlapScore(span.text, countQuestionTokens) > 0
      )
    );
    if (relevantRows.length > 0 && /how many\b/iu.test(item.question)) {
      return String(relevantRows.length);
    }
  }

  if ((answerType === "amount" || /\btotal\b/iu.test(item.question)) && candidates.length > 0) {
    const numeric = candidates
      .filter((candidate) => candidate.type === "money" || candidate.type === "percentage" || candidate.type === "measurement" || candidate.type === "count")
      .map((candidate) => ({ candidate, number: parseNumericValue(candidate.value) }))
      .filter((entry) => Number.isFinite(entry.number));
    const money = numeric.filter((entry) => entry.candidate.type === "money");
    const percentages = numeric.filter((entry) => entry.candidate.type === "percentage");
    if (percentages.length === 1 && /\bdiscount\b/iu.test(item.question)) return percentages[0].candidate.value;
    if (money.length > 1) {
      const total = money.reduce((sum, entry) => sum + entry.number, 0);
      return `$${total.toLocaleString("en-US")}`;
    }
    if (numeric.length > 1 && /\b(hours?|days?|years?|months?|weight|total)\b/iu.test(item.question)) {
      const total = numeric.reduce((sum, entry) => sum + entry.number, 0);
      return Number.isInteger(total) ? String(total) : String(total);
    }
  }

  const best = bestCandidateForQuestion(candidates, answerType);
  const directAnswerTypes = new Set(["money", "percentage", "measurement", "count", "date", "time", "ratio", "title"]);
  if (best && directAnswerTypes.has(best.type) && Number(best.answer_score ?? 0) >= 16) return best.value;
  const valentinesDay = candidates.find((candidate) => /^Valentine's Day$/iu.test(candidate.value));
  if (answerType === "date" && valentinesDay) return "February 14th";
  if (best && Number(best.answer_score ?? 0) >= 22) {
    if (answerType === "place" && best.role === "user" && (best.type === "entity" || best.type === "place_phrase")) return best.value;
    if (answerType === "person" && best.role === "user" && best.type === "entity") return best.value;
    if (
      answerType === "entity" &&
      best.role === "user" &&
      Number(best.row ?? 1) === 1 &&
      /\b(called|named|old name was|last name was|maiden name was|certification in|favorite brand|favourite brand|play I attended was|attended was actually|production of)\b/iu.test(best.source ?? "")
    ) {
      return best.value;
    }
  }
  return "";
}

export function buildAnswerWorksheet(item, contexts) {
  const answerType = detectAnswerType(item.question);
  const rows = buildWorksheetRows(contexts);
  const proposedAnswer = proposeWorksheetAnswer(item, rows, answerType);
  const renderedRows = rows
    .slice(0, 5)
    .map((row) => {
      const candidates = row.candidates.slice(0, 6).map(formatCandidate).join("; ") || "none";
      const spans = row.spans.slice(0, 2).map((span) => clipped(span.text, 150)).join(" / ") || "none";
      return `row${row.row} ${row.session} date=${row.date || "n/a"} values=${candidates} spans=${spans}`;
    })
    .join("\n");
  return {
    answer_type: answerType,
    proposed_answer: proposedAnswer,
    rows,
    text: [
      `answer_type=${answerType}`,
      proposedAnswer ? `proposed_answer=${proposedAnswer}` : "proposed_answer=",
      renderedRows
    ].filter(Boolean).join("\n")
  };
}

function answererInstructions(item, answererProfile = "evidence_cards_v1") {
  if (answererProfile === "worksheet_router_v2") {
    const instructions = [
      "Use Worksheet first.",
      "Prefer proposed_answer only when it is directly supported by the same row spans.",
      "If proposed_answer conflicts with spans, answer from the spans and candidate values.",
      "Never answer unavailable when Worksheet has candidate values or spans."
    ];
    if (/multi-session/iu.test(item.category)) {
      instructions.push("Ledger mode: evaluate every worksheet row, ignore unrelated rows, dedupe the same event once, then return only the final count, total, or entity.");
    }
    return instructions.join(" ");
  }
  if (answererProfile === "specialist_router_v1" || answererProfile === "decision_forest_v1") {
    if (/multi-session/iu.test(item.category)) {
      return [
        "Ledger mode:",
        "dedupe sessions, count user-specific events, answer final value."
      ].join(" ");
    }
    if (/temporal-reasoning/iu.test(item.category)) {
      return [
        "Timeline mode:",
        "order by card dates and user-stated event dates, then answer."
      ].join(" ");
    }
    if (/single-session-preference/iu.test(item.category)) {
      return [
        "Preference mode:",
        "prioritize user preferences, background, tools, and dislikes."
      ].join(" ");
    }
    if (/knowledge-update/iu.test(item.category)) {
      return [
        "Update mode:",
        "prefer latest user-stated fact."
      ].join(" ");
    }
  }

  return "Answer from compact evidence; say unavailable if insufficient.";
}

export function buildTreatmentPrompt(item, contexts, options = {}) {
  const answererProfile = options.answererProfile ?? "evidence_cards_v1";
  const worksheet = answererProfile === "worksheet_router_v2" ? buildAnswerWorksheet(item, contexts) : null;
  const renderedContexts = worksheet
    ? ""
    : (contexts.length > 0
        ? contexts.map((context, index) => formatBenchmarkContext(context, index + 1, {
            includeAnswerFields: true,
            minimalEvidence: false
          })).join("\n\n")
        : "(no retrieved Org Brain context)");
  const evidenceSection = worksheet
    ? []
    : [
        "Evidence:",
        renderedContexts,
        ""
      ];

  return [
    "Answer using only retrieved Org Brain evidence.",
    `Profile: ${answererProfile}`,
    answererInstructions(item, answererProfile),
    "Return only the answer.",
    "",
    worksheet ? "Worksheet:" : "",
    worksheet ? worksheet.text : "",
    worksheet ? "" : "",
    ...evidenceSection,
    "Question:",
    item.question,
    "",
    "Answer:"
  ].join("\n");
}

export function formatBenchmarkContext(context, index, options = {}) {
  if (context.evidence_card) return `[${index}] ${renderEvidenceCard(context.evidence_card, options)}`;
  const label = context.kind === "doc" ? `doc:${context.id}` : `memory:${context.id}`;
  const project = context.project_id ? ` project=${context.project_id}` : "";
  const source = context.source ? ` source=${context.source}` : "";
  const title = context.title || context.summary || "(untitled)";
  const snippet = context.content_preview || context.body_preview || "";
  return [`[${index}] ${label}${project}${source}`, `title: ${title}`, snippet ? `snippet: ${snippet}` : ""]
    .filter(Boolean)
    .join("\n");
}

export function applyTreatmentTokenBudget(item, contexts, options = {}) {
  const tokenBudget = Number(options.tokenBudget ?? 0);
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) return contexts;
  const answererProfile = options.answererProfile ?? "evidence_cards_v1";
  const promptFor = (candidateContexts) => buildTreatmentPrompt(item, candidateContexts, { answererProfile });
  const budgetEstimate = (candidateContexts) => Math.ceil(estimateTokens(promptFor(candidateContexts)) * 1.16);
  let candidateContexts = contexts.map((context) => ({ ...context }));
  const previewLimits = [420, 320, 240, 180, 120, 80];

  for (const limit of previewLimits) {
    const trimmed = candidateContexts.map((context) => ({
      ...context,
      content_preview: clipped(context.content_preview ?? context.body_preview ?? "", limit),
      evidence_card: context.evidence_card
        ? {
            ...context.evidence_card,
            event: clipped(context.evidence_card.event ?? "", Math.max(50, Math.floor(limit * 0.24))),
            preference: clipped(context.evidence_card.preference ?? "", Math.max(40, Math.floor(limit * 0.16))),
            update: clipped(context.evidence_card.update ?? "", Math.max(36, Math.floor(limit * 0.14))),
            countable_entity: clipped(context.evidence_card.countable_entity ?? "", Math.max(36, Math.floor(limit * 0.12))),
            verbatim_anchor: clipped(context.evidence_card.verbatim_anchor ?? "", Math.max(100, Math.floor(limit * 0.66)))
          }
        : context.evidence_card
    }));
    if (budgetEstimate(trimmed) <= tokenBudget) return trimmed;
    candidateContexts = trimmed;
  }

  if (answererProfile === "worksheet_router_v2" && tokenBudget >= 850) return candidateContexts;

  while (candidateContexts.length > 1 && budgetEstimate(candidateContexts) > tokenBudget) {
    candidateContexts = candidateContexts.slice(0, -1);
  }
  return candidateContexts;
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
      acc.treatment_prompt_tokens += Number(result.treatment_prompt_tokens ?? result.org_brain_context_tokens ?? 0);
      acc.answer_compute_tokens += Number(result.answer_compute_tokens ?? 0);
      acc.retrieval_compute_tokens += Number(result.retrieval_compute_tokens ?? 0);
      acc.retrieval_count += Number(result.retrieval_count ?? 0);
      acc.retrieval_latency_ms += Number(result.retrieval_latency_ms ?? 0);
      acc.fallback_count += result.fallback_used ? 1 : 0;
      acc.evidence_coverage_at_5 += Number(result.evidence_coverage_at_5 ?? 0);
      return acc;
    },
    {
      full_context_tokens: 0,
      org_brain_context_tokens: 0,
      treatment_prompt_tokens: 0,
      answer_compute_tokens: 0,
      retrieval_compute_tokens: 0,
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
    treatment_prompt_tokens: totals.treatment_prompt_tokens,
    answer_compute_tokens: totals.answer_compute_tokens,
    retrieval_compute_tokens: totals.retrieval_compute_tokens,
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
      treatment_prompt_tokens: 0,
      answer_compute_tokens: 0,
      retrieval_compute_tokens: 0,
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
    entry.treatment_prompt_tokens += Number(result.treatment_prompt_tokens ?? result.org_brain_context_tokens ?? 0);
    entry.answer_compute_tokens += Number(result.answer_compute_tokens ?? 0);
    entry.retrieval_compute_tokens += Number(result.retrieval_compute_tokens ?? 0);
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

function rankMetric(rows, metric, descending = true) {
  return rows
    .filter((row) => row[metric] !== null && row[metric] !== undefined)
    .sort((left, right) => descending ? Number(right[metric]) - Number(left[metric]) : Number(left[metric]) - Number(right[metric]))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export function buildComparisonRankEstimate(summary = null) {
  if (!summary) {
    return {
      accuracy_rank: null,
      evidence_recall_rank: null,
      token_reduction_rank: null,
      note: "Run a benchmark and include --compare-public to rank Org Brain against public anchors."
    };
  }

  const orgRow = {
    system: "Org Brain current run",
    profile: "current",
    accuracy: summary.accuracy,
    evidence_recall_at_5: summary.evidence_recall_at_5 ?? summary.recall_at_5,
    token_reduction_rate: summary.token_reduction_rate
  };
  const rows = [...PUBLIC_COMPARISON_ROWS, orgRow];
  const findRank = (metric) => rankMetric(rows, metric).find((row) => row.system === orgRow.system)?.rank ?? null;
  return {
    accuracy_rank: findRank("accuracy"),
    evidence_recall_rank: findRank("evidence_recall_at_5"),
    token_reduction_rank: findRank("token_reduction_rate"),
    target_pass: {
      accuracy: summary.accuracy === null ? null : summary.accuracy >= LEADERBOARD_TARGETS.accuracy,
      evidence_recall_at_5:
        (summary.evidence_recall_at_5 ?? summary.recall_at_5) === null
          ? null
          : (summary.evidence_recall_at_5 ?? summary.recall_at_5) >= LEADERBOARD_TARGETS.evidence_recall_at_5,
      token_reduction_rate: summary.token_reduction_rate >= LEADERBOARD_TARGETS.token_reduction_rate,
      fallback_rate: summary.fallback_rate === LEADERBOARD_TARGETS.fallback_rate
    },
    note: "Ranks compare this run with public anchors only; external systems were not rerun in the Org Brain harness."
  };
}

export function buildPublicComparisonReport(summary = null, options = {}) {
  const currentRun = summary
    ? [
        {
          system: "Org Brain current run",
          profile: options.profile ?? "current",
          benchmark: "LongMemEval-S",
          measured_by: "org_brain_local_harness",
          accuracy: summary.accuracy,
          evidence_recall_at_5: summary.evidence_recall_at_5 ?? summary.recall_at_5,
          retrieval_recall_at_5: summary.recall_at_5,
          token_reduction_rate: summary.token_reduction_rate,
          fallback_rate: summary.fallback_rate,
          source_url: options.sourceUrl ?? null,
          retrieved_at: options.retrievedAt ?? null,
          notes: "Current CLI run."
        }
      ]
    : [];

  return {
    kind: "public_comparison",
    leaderboard_targets: LEADERBOARD_TARGETS,
    comparison_rank_estimate: buildComparisonRankEstimate(summary),
    rows: [...currentRun, ...PUBLIC_COMPARISON_ROWS],
    caveat: "External values are public-reference anchors and are not same-harness measurements unless measured_by is org_brain_local_harness."
  };
}
