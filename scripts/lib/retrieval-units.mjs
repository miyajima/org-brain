import { createHash } from "node:crypto";

export const RETRIEVAL_UNIT_EXTRACTOR = "deterministic-retrieval-units-v1";

const ROLE_LINE_RE = /^(user|assistant|system|tool)\s*:\s*/iu;
const UPDATE_RE = /\b(?:now|currently|latest|recently|changed|switched|replaced|no longer|instead|updated|moved|started|stopped)\b|(?:現在|最近|変更|切り替え|更新|やめた|始めた)/iu;
const PREFERENCE_RE = /\b(?:prefer|like|love|enjoy|want|would like|favorite|favourite|rather|avoid|dislike|interested in|looking (?:for|at)|thinking (?:of|about)|planning to|plan to|decided|chose|go with)\b|(?:好み|好き|嫌い|優先|避ける|欲しい|探して|考えて|予定)/iu;
const EVENT_RE = /\b(?:went|visited|attended|bought|sold|started|finished|completed|graduated|married|born|traveled|travelled|returned|joined|left|met|worked|ran|drove|watched|read|made|paid|spent)\b|(?:行った|訪れた|参加|購入|売却|開始|完了|卒業|結婚|生まれ|旅行|帰った|入社|退社|会った|支払)/iu;
const QUANTITY_RE = /(?:[$€£¥]\s?\d)|(?:\b\d+(?:\.\d+)?\s*(?:%|percent|minutes?|hours?|days?|weeks?|months?|years?|miles?|kilometers?|km|pages?|times?|people|items?|dollars?)\b)|(?:\d+\s*(?:分|時間|日|週間|か月|ヶ月|年|回|人|個|円))/iu;
const DATE_RE = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|(?:月曜|火曜|水曜|木曜|金曜|土曜|日曜|\d{1,2}月\d{0,2}日?)/iu;
const FACT_RE = /\b(?:am|is|are|was|were|have|has|had|use|uses|live|work|own|graduated|degree|brand|name|role)\b|(?:です|である|持って|使って|住んで|働いて|卒業|学位|名前|役職)/iu;
const QUERY_STOP_WORDS = new Set([
  "about", "after", "again", "ago", "also", "am", "and", "another", "any", "are", "been", "before",
  "can", "could", "current", "currently", "did", "do", "does", "first", "for", "from",
  "had", "has", "have", "how", "into", "last", "lately", "making", "many", "more",
  "most", "not", "now", "of", "on", "one", "or", "past", "some", "sure", "than",
  "that", "the", "their", "them", "then", "there", "these", "thinking", "this", "those",
  "to", "use", "using", "was", "ways", "were", "what", "when", "where", "which", "while", "who",
  "why", "with", "would", "you", "your", "ve", "recommend", "recommendation", "recommendations",
  "suggest", "suggestion", "suggestions", "ideas", "choose", "chat", "list", "name", "remind",
  "find", "interesting", "get", "getting", "upcoming", "sure", "excited", "visit", "tips", "during",
  "look", "new", "weekend", "good", "idea", "feeling", "need", "something", "extra",
  "advice", "trouble", "looking", "back", "previous", "conversation", "is", "planning", "try", "tried"
]);
const RELATIVE_NUMBER_WORDS = new Map([
  ["a", 1], ["an", 1], ["one", 1], ["two", 2], ["three", 3], ["four", 4],
  ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9],
  ["ten", 10], ["eleven", 11], ["twelve", 12], ["couple", 2]
]);
const RELATIVE_UNIT_MS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000
};
const WEEKDAY_INDEX = new Map([
  ["sunday", 0], ["monday", 1], ["tuesday", 2], ["wednesday", 3],
  ["thursday", 4], ["friday", 5], ["saturday", 6]
]);
const LEXICAL_CONCEPT_GROUPS = [
  ["publication", "paper", "article", "conference", "symposium"],
  ["doctor", "physician", "dermatologist", "clinician"],
  ["sibling", "brother", "sister"],
  ["ingredient", "recipe", "meal", "dinner", "food", "cooking", "cook", "baking", "bake", "dish", "dessert"],
  ["homegrown", "garden", "harvest", "grow"],
  ["appliance", "smoker", "oven", "grill", "blender", "toaster"],
  ["battery", "power", "charger", "charging"],
  ["milestone", "launch", "achievement", "breakthrough"]
];
const LEXICAL_CONCEPT_BY_TERM = new Map(
  LEXICAL_CONCEPT_GROUPS.flatMap((group) => group.map((term) => [term, group]))
);
const TOKEN_CORRECTIONS = new Map([["buisiness", "business"]]);
const SUBJECT_STOP_WORDS = new Set([
  "amount", "day", "days", "kind", "number", "related", "total", "type"
]);
const SUBJECT_QUERY_EXPANSIONS = new Map([
  ["publication", ["paper", "article", "conference", "symposium"]],
  ["doctor", ["physician", "dermatologist", "clinician"]],
  ["sibling", ["brother", "sister"]],
  ["occupation", ["job", "work", "role", "career", "employment", "profession"]],
  ["hamster", ["pet", "rodent", "animal"]],
  ["event", [
    "exhibit", "museum", "festival", "workshop", "conference", "concert", "show", "fair",
    "wedding", "shower", "graduation", "ceremony"
  ]],
  ["participated", ["participate", "attend", "attended", "joined"]],
  ["participate", ["attend", "attended", "joined"]],
  ["held", ["venue", "location"]],
  ["buisiness", ["business"]],
  ["meet", ["met", "meeting", "catch", "caught"]],
  ["appliance", ["smoker", "oven", "grill", "blender", "toaster"]],
  ["battery", ["power", "charger", "charging"]],
  ["milestone", [
    "launch", "launched", "achievement", "breakthrough", "contract", "client", "founded"
  ]]
]);

function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function clip(value, limit = 20_000) {
  const normalized = collapseWhitespace(value);
  return normalized.length <= limit ? normalized : normalized.slice(0, limit);
}

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function retrievalPrimaryQueryTokens(value) {
  const tokens = [...new Set(
    String(value ?? "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token))
      .map((token) => TOKEN_CORRECTIONS.get(token) ?? token)
  )];
  const inflected = [...new Set(tokens.flatMap((token) => {
    if (!/^[a-z]+$/u.test(token) || token.length <= 3) return [token];
    if (token.endsWith("ies") && token.length > 4) return [token, `${token.slice(0, -3)}y`];
    if (token.endsWith("ing") && token.length > 5) {
      const base = token.slice(0, -3);
      const undoubled = base.at(-1) === base.at(-2) ? base.slice(0, -1) : base;
      return [token, base, undoubled, `${base}e`];
    }
    if (token.endsWith("ed") && token.length > 4) {
      const base = token.slice(0, -2);
      return [token, base, `${base}e`];
    }
    if (token.endsWith("s") && !token.endsWith("ss")) return [token, token.slice(0, -1)];
    return [token];
  }))];
  return inflected;
}

export function retrievalQueryTokens(value) {
  return [...new Set(
    retrievalPrimaryQueryTokens(value)
      .flatMap((token) => [token, ...(LEXICAL_CONCEPT_BY_TERM.get(token) ?? [])])
  )];
}

export function retrievalSubjectQueryTokens(value) {
  return retrievalPrimaryQueryTokens(value)
    .filter((token) => !SUBJECT_STOP_WORDS.has(token))
    .flatMap((token) => [token, ...(SUBJECT_QUERY_EXPANSIONS.get(token) ?? [])])
    .filter((token, index, tokens) => tokens.indexOf(token) === index);
}

export function retrievalUnitLexicalSpecificity(units, query) {
  const queryTokens = retrievalSubjectQueryTokens(query);
  const scores = new Map();
  if (queryTokens.length === 0 || units.length === 0) return scores;
  const unitTokens = new Map(units.map((unit) => [unit.id, new Set(retrievalQueryTokens(unit.text))]));
  const weights = new Map(queryTokens.map((token) => {
    const documentFrequency = [...unitTokens.values()].filter((tokens) => tokens.has(token)).length;
    return [token, documentFrequency === 0 ? 0 : Math.log((units.length + 1) / (documentFrequency + 1)) + 1];
  }));
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  if (totalWeight === 0) return scores;
  for (const unit of units) {
    const tokens = unitTokens.get(unit.id);
    const matchedWeight = queryTokens.reduce(
      (sum, token) => sum + (tokens?.has(token) ? (weights.get(token) ?? 0) : 0),
      0
    );
    scores.set(unit.id, matchedWeight / totalWeight);
  }
  return scores;
}

function stableUnitId(memoryId, unitType, index, text) {
  return `ru_${hash(`${memoryId}\0${unitType}\0${index}\0${text}`).slice(0, 28)}`;
}

export function splitRetrievalTurns(content) {
  const lines = String(content ?? "").split(/\r?\n/u);
  const turns = [];
  let current = null;
  const push = () => {
    if (!current) return;
    current.text = collapseWhitespace(current.parts.join("\n"));
    if (current.text) turns.push({ speaker: current.speaker, text: current.text });
    current = null;
  };
  for (const line of lines) {
    const match = line.match(ROLE_LINE_RE);
    if (match) {
      push();
      current = {
        speaker: match[1].toLowerCase(),
        parts: [line.slice(match[0].length)]
      };
    } else if (current) {
      current.parts.push(line);
    } else if (line.trim()) {
      current = { speaker: "unknown", parts: [line] };
    }
  }
  push();
  return turns.length > 0 ? turns : [{ speaker: "unknown", text: collapseWhitespace(content) }].filter((turn) => turn.text);
}

function sentenceUnits(text) {
  return String(text ?? "")
    .split(/(?:\r?\n)+|(?<=[。！？.!?])\s+/u)
    .map(collapseWhitespace)
    .filter((sentence) => sentence.length >= 18);
}

function classifyAtomicUnit(text) {
  if (UPDATE_RE.test(text)) return "update";
  if (PREFERENCE_RE.test(text)) return "preference";
  if (EVENT_RE.test(text) || DATE_RE.test(text)) return "event";
  if (QUANTITY_RE.test(text)) return "quantity";
  if (FACT_RE.test(text)) return "fact";
  return null;
}

function sourceReference(record) {
  return Array.isArray(record.source_references) && record.source_references.length > 0
    ? record.source_references[0]
    : null;
}

function retrievalUnitEventAt(record) {
  const capturedAt = Number(sourceReference(record)?.captured_at);
  if (Number.isFinite(capturedAt) && capturedAt > 0) return capturedAt;
  if (record.valid_from !== null && record.valid_from !== undefined) return record.valid_from;
  return record.created_at ?? null;
}

export function buildRetrievalUnits(record) {
  const content = collapseWhitespace(record.content);
  if (!content) return [];
  const turns = splitRetrievalTurns(record.content);
  const units = [];
  const append = (unitType, text, options = {}) => {
    const normalized = clip(text, 20_000);
    if (!normalized) return;
    const index = units.length;
    units.push({
      id: stableUnitId(record.id, unitType, index, normalized),
      memory_id: record.id,
      tenant_id: record.tenant_id,
      project_id: record.project_id ?? null,
      unit_type: unitType,
      speaker: options.speaker ?? null,
      text: normalized,
      event_at: options.event_at ?? retrievalUnitEventAt(record),
      valid_from: record.valid_from ?? null,
      valid_until: record.valid_until ?? null,
      source_ref_json: JSON.stringify(sourceReference(record)),
      source_span_start: options.source_span_start ?? null,
      source_span_end: options.source_span_end ?? null,
      content_hash: hash(normalized),
      extractor: RETRIEVAL_UNIT_EXTRACTOR,
      extractor_version: "1",
      extraction_state: "degraded",
      degraded_reason: "atomic_extractor_not_configured",
      created_at: record.updated_at ?? record.created_at ?? Date.now()
    });
  };

  append("session", `${record.summary ?? ""}\n${record.content}`);
  const synopsisParts = [
    record.summary,
    ...turns
      .flatMap((turn) => sentenceUnits(turn.text).filter((sentence) => classifyAtomicUnit(sentence)))
      .slice(0, 8)
  ].filter(Boolean);
  append("synopsis", synopsisParts.join(" "));

  for (const turn of turns) {
    append("turn", turn.text, { speaker: turn.speaker });
    for (const sentence of sentenceUnits(turn.text)) {
      const unitType = classifyAtomicUnit(sentence);
      if (unitType) append(unitType, sentence, { speaker: turn.speaker });
    }
  }

  const seen = new Set();
  return units.filter((unit) => {
    const key = `${unit.unit_type}\0${unit.speaker ?? ""}\0${unit.text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function analyzeRetrievalIntent(query) {
  const text = collapseWhitespace(query).toLowerCase();
  const relativeMatch = text.match(
    /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple)(?:\s+of)?\s+(day|week|month|year)s?\s+ago\b/u
  );
  const relativeCount = relativeMatch
    ? Number(relativeMatch[1]) || RELATIVE_NUMBER_WORDS.get(relativeMatch[1]) || 0
    : 0;
  const relativeAgeMs = relativeMatch && relativeCount > 0
    ? relativeCount * RELATIVE_UNIT_MS[relativeMatch[2]]
    : /\byesterday\b/u.test(text)
      ? RELATIVE_UNIT_MS.day
      : /\blast (?:week|weekend)\b/u.test(text)
        ? RELATIVE_UNIT_MS.week
        : /\blast month\b/u.test(text)
          ? RELATIVE_UNIT_MS.month
          : /\blast year\b/u.test(text)
            ? RELATIVE_UNIT_MS.year
            : null;
  const weekdayMatch = text.match(
    /\blast (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u
  );
  const temporalDirection =
    /\b(?:first|earliest|before|initially|originally)\b|(?:最初|以前|当初)/u.test(text)
      ? "earliest"
      : /\b(?:latest|most recent|recently|currently|current|now|last)\b|(?:最新|最近|現在|今|最後)/u.test(text)
        ? "latest"
        : null;
  const speaker =
    /\b(?:assistant|you (?:say|said|recommend|recommended|suggest|suggested|create|created|write|wrote|generate|generated|compose|composed|tell|told|give|gave)|your (?:answer|response|suggestion|recommendation))\b|(?:アシスタント|あなたが(?:言|勧|提案|作成|書|生成))/u.test(text)
      ? "assistant"
      : /\b(?:i said|i mentioned|my|i currently|i use|i prefer|i have|i had|do i have)\b|(?:私|自分)/u.test(text)
        ? "user"
        : null;
  const unitTypes = [];
  if (
    PREFERENCE_RE.test(text) ||
    /\b(?:recommend|recommendation|suggestions?|ideas?(?:\s+on|\s+for)?|what should i)\b|(?:おすすめ|提案|アイデア)/u.test(text)
  ) unitTypes.push("preference", "fact");
  if (UPDATE_RE.test(text)) unitTypes.push("update");
  if (/\bhow many\b|(?:いくつ|何回)/u.test(text)) unitTypes.push("fact", "event");
  if (QUANTITY_RE.test(text) || /\b(?:how much|total|average|percentage)\b|(?:合計|平均|割合)/u.test(text)) {
    unitTypes.push("quantity");
  }
  if (DATE_RE.test(text) || temporalDirection) unitTypes.push("event");
  return {
    temporal_direction: temporalDirection,
    relative_age_ms: relativeAgeMs,
    relative_weekday: weekdayMatch ? WEEKDAY_INDEX.get(weekdayMatch[1]) ?? null : null,
    speaker,
    unit_types: [...new Set(unitTypes)]
  };
}

export function retrievalUnitIntentBoost(unit, intent) {
  let score = 0;
  if (intent.speaker) {
    if (unit.speaker === intent.speaker) score += 0.006;
    else if (unit.speaker && unit.speaker !== "unknown") score -= 0.002;
  }
  if (intent.unit_types.length > 0) {
    if (intent.unit_types.includes(unit.unit_type)) score += 0.006;
  }
  return score;
}
