export const RETRIEVAL_UNIT_EXTRACTOR = "deterministic-retrieval-units-v1";
export const RETRIEVAL_UNIT_EXTRACTOR_V4 = "deterministic-retrieval-units-v4";
export const RETRIEVAL_SEGMENT_MAX_RECORDS = 32;
export const RETRIEVAL_SEGMENT_MAX_CHARS = 64 * 1024;
export const RETRIEVAL_SEGMENT_OVERLAP_RATIO = 0.25;

const ROLE_LINE_RE = /^(user|assistant|system|tool)\s*:\s*/iu;
const UPDATE_RE = /\b(?:now|currently|latest|recently|changed|switched|replaced|no longer|instead|updated|moved|started|stopped)\b|(?:現在|最近|変更|切り替え|更新|やめた|始めた)/iu;
const PREFERENCE_RE = /\b(?:prefer|like|love|enjoy|want|would like|favorite|favourite|rather|avoid|dislike|interested in|looking (?:for|at)|thinking (?:of|about)|planning to|plan to|decided|chose|go with)\b|(?:好み|好き|嫌い|優先|避ける|欲しい|探して|考えて|予定)/iu;
const INSTRUCTION_RE = /\b(?:always|never|must|should|please|make sure|remember to|do not|don't|avoid)\b|(?:必ず|決して|してはいけない|してください|忘れず|避ける)/iu;
const EVENT_RE = /\b(?:went|visited|attended|bought|sold|started|finished|completed|graduated|married|born|traveled|travelled|returned|joined|left|met|worked|ran|drove|watched|read|made|paid|spent)\b|(?:行った|訪れた|参加|購入|売却|開始|完了|卒業|結婚|生まれ|旅行|帰った|入社|退社|会った|支払)/iu;
const QUANTITY_RE = /(?:[$€£¥]\s?\d)|(?:\b\d+(?:\.\d+)?\s*(?:%|percent|minutes?|hours?|days?|weeks?|months?|years?|miles?|kilometers?|km|pages?|times?|people|items?|dollars?)\b)|(?:\d+\s*(?:分|時間|日|週間|か月|ヶ月|年|回|人|個|円))/iu;
const DATE_RE = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|(?:月曜|火曜|水曜|木曜|金曜|土曜|日曜|\d{1,2}月\d{0,2}日?)/iu;
const FACT_RE = /\b(?:am|is|are|was|were|have|has|had|use|uses|live|work|own|graduated|degree|brand|name|role)\b|(?:です|である|持って|使って|住んで|働いて|卒業|学位|名前|役職)/iu;
const NEGATION_RE = /\b(?:not|never|no longer|don't|doesn't|didn't|cannot|can't|avoid|dislike)\b|(?:ない|ません|禁止|避ける|嫌い)/iu;
const POLICY_RE = /\b(?:policy|rule|must|required|prohibited|approved|authority)\b|(?:方針|規則|必須|禁止|承認|権限)/iu;
const DATE_VALUE_RE = /\b((?:19|20)\d{2}(?:[-/]\d{1,2}(?:[-/]\d{1,2})?)?)\b/u;
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

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
];
const SHA256_ROUND = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function hash(value) {
  const input = new TextEncoder().encode(String(value));
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_ROUND[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((part) => part.toString(16).padStart(8, "0")).join("");
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
  if (INSTRUCTION_RE.test(text)) return "instruction";
  if (PREFERENCE_RE.test(text)) return "preference";
  if (EVENT_RE.test(text) || DATE_RE.test(text)) return "event";
  if (QUANTITY_RE.test(text)) return "quantity";
  if (FACT_RE.test(text)) return "fact";
  return null;
}

function unitTypeFromRecordKind(kind) {
  if (["constraint", "pitfall"].includes(kind)) return "instruction";
  if (kind === "preference") return "preference";
  if (["decision", "fact", "semantic", "org_knowledge"].includes(kind)) return "fact";
  if (["episodic", "event"].includes(kind)) return "event";
  if (kind === "update") return "update";
  return null;
}

function inferDomain(text) {
  if (POLICY_RE.test(text)) return "policy";
  if (PREFERENCE_RE.test(text)) return "preference";
  if (INSTRUCTION_RE.test(text)) return "instruction";
  if (EVENT_RE.test(text) || DATE_RE.test(text)) return "event";
  return "general";
}

function normalizedDate(text) {
  const match = String(text).match(DATE_VALUE_RE);
  if (!match) return null;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function atomicMetadata(text, speaker) {
  const normalized = collapseWhitespace(text);
  const copula = normalized.match(
    /^(.{1,160}?)\s+(?:is|are|was|were|has|have|uses?|prefers?|likes?|wants?|must|should|started|stopped|changed to)\s+(.{1,320})$/iu
  );
  const japanese = copula ? null : normalized.match(/^(.{1,160}?)(?:は|が)(.{1,320}?)(?:です|である|になった|を使う|が好き)$/u);
  const match = copula ?? japanese;
  return {
    subject: collapseWhitespace(match?.[1] ?? (speaker === "user" ? "user" : speaker ?? "unknown")),
    predicate: copula
      ? collapseWhitespace(normalized.slice(match[1].length, normalized.length - match[2].length))
      : japanese
        ? "states"
        : "mentions",
    object: collapseWhitespace(match?.[2] ?? normalized),
    polarity: NEGATION_RE.test(normalized) ? "negative" : "positive",
    domain: inferDomain(normalized),
    normalized_at: normalizedDate(normalized)
  };
}

function segmentText(text) {
  const normalized = collapseWhitespace(text);
  if (!normalized) return [];
  if (normalized.length <= RETRIEVAL_SEGMENT_MAX_CHARS) return [normalized];
  const overlap = Math.floor(RETRIEVAL_SEGMENT_MAX_CHARS * RETRIEVAL_SEGMENT_OVERLAP_RATIO);
  const step = RETRIEVAL_SEGMENT_MAX_CHARS - overlap;
  const segments = [];
  for (let offset = 0; offset < normalized.length; offset += step) {
    segments.push(normalized.slice(offset, offset + RETRIEVAL_SEGMENT_MAX_CHARS));
    if (offset + RETRIEVAL_SEGMENT_MAX_CHARS >= normalized.length) break;
  }
  return segments;
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
  const seen = new Set();
  const append = (unitType, text, options = {}) => {
    const normalized = clip(text, 20_000);
    if (!normalized) return;
    const dedupeKey = `${unitType}\0${options.speaker ?? ""}\0${normalized.toLowerCase()}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
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

  return units;
}

/**
 * Additive v4 projection. It is deliberately deterministic and network-free;
 * callers may replace the metadata with Gemini structured extraction during
 * ingestion, but retrieval never invokes a generative model.
 */
export function buildRetrievalUnitsV4(record) {
  const base = buildRetrievalUnits(record);
  const units = [];
  const append = (unitType, text, options = {}) => {
    const normalized = clip(text, RETRIEVAL_SEGMENT_MAX_CHARS);
    if (!normalized) return;
    const index = units.length;
    const eventAt = options.event_at ?? retrievalUnitEventAt(record);
    units.push({
      id: `rv4_${hash(`${record.id}\0${unitType}\0${index}\0${normalized}`).slice(0, 27)}`,
      memory_id: record.id,
      tenant_id: record.tenant_id,
      project_id: record.project_id ?? null,
      unit_type: unitType,
      speaker: options.speaker ?? null,
      text: normalized,
      event_at: eventAt,
      valid_from: record.valid_from ?? null,
      valid_until: record.valid_until ?? null,
      source_ref_json: JSON.stringify(sourceReference(record)),
      source_span_start: options.source_span_start ?? null,
      source_span_end: options.source_span_end ?? null,
      content_hash: hash(normalized),
      metadata_json: JSON.stringify(options.metadata ?? {}),
      segment_id: options.segment_id ?? null,
      extractor: RETRIEVAL_UNIT_EXTRACTOR_V4,
      extractor_version: "4",
      extraction_state: "degraded",
      degraded_reason: "gemini_structured_extractor_not_configured",
      created_at: record.updated_at ?? record.created_at ?? Date.now()
    });
  };

  const semanticUnitTypes = ["fact", "update", "preference", "instruction", "event", "quantity"];
  const semanticUnits = base.filter((unit) => semanticUnitTypes.includes(unit.unit_type));
  const kindUnitType = unitTypeFromRecordKind(record.kind);
  if (kindUnitType && !semanticUnits.some((unit) => unit.unit_type === kindUnitType)) {
    semanticUnits.push({
      ...base.find((unit) => unit.unit_type === "turn") ?? base[0],
      unit_type: kindUnitType,
      speaker: "unknown",
      text: collapseWhitespace(record.content),
      event_at: retrievalUnitEventAt(record)
    });
  }

  for (const unit of semanticUnits) {
    if (semanticUnitTypes.includes(unit.unit_type)) {
      const atomic = atomicMetadata(unit.text, unit.speaker);
      append("atomic", unit.text, {
        speaker: unit.speaker,
        event_at: atomic.normalized_at,
        metadata: atomic
      });
      if (["preference", "instruction", "update", "fact"].includes(unit.unit_type)) {
        append("profile", unit.text, {
          speaker: unit.speaker,
          event_at: unit.event_at,
          metadata: {
            facet_kind:
              unit.unit_type === "instruction"
                ? "instruction"
                : unit.unit_type === "update"
                  ? "current_state"
                  : unit.unit_type,
            state_key: `${atomic.domain}:${atomic.subject}:${atomic.predicate}`.toLowerCase(),
            authority: POLICY_RE.test(unit.text) ? "policy" : "ordinary",
            ...atomic
          }
        });
      }
      if (unit.unit_type === "update") {
        append("ledger", unit.text, {
          speaker: unit.speaker,
          event_at: unit.event_at,
          metadata: {
            state_key: `${atomic.domain}:${atomic.subject}:${atomic.predicate}`.toLowerCase(),
            operation: "supersedes",
            supersedes_unit_id: null,
            ...atomic
          }
        });
      }
      if (unit.unit_type === "event" || atomic.normalized_at !== null) {
        append("timeline", unit.text, {
          speaker: unit.speaker,
          event_at: atomic.normalized_at,
          metadata: {
            relation: "event",
            starts_at: atomic.normalized_at,
            ends_at: null,
            causes: [],
            follows: [],
            ...atomic
          }
        });
      }
    }
  }

  let learning = record.learning;
  if ((!learning || typeof learning !== "object") && typeof record.learning_json === "string") {
    try {
      const parsed = JSON.parse(record.learning_json);
      learning = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      learning = null;
    }
  }
  const rationale = collapseWhitespace(learning?.rationale ?? record.rationale);
  const reuseRule = collapseWhitespace(learning?.reuse_rule ?? learning?.reuse_when ?? record.reuse_rule);
  if (rationale) {
    append("profile", `Rationale: ${rationale}`, {
      metadata: { channel: "rationale", lesson_type: learning?.lesson_type ?? null }
    });
  }
  if (reuseRule) {
    append("profile", `Reuse or avoid: ${reuseRule}`, {
      metadata: { channel: "reuse_or_avoidance", lesson_type: learning?.lesson_type ?? null }
    });
  }
  const learningContext = [
    learning?.trigger ? `Trigger: ${learning.trigger}` : null,
    learning?.decision_key ? `Decision key: ${learning.decision_key}` : null,
    learning?.question ? `Question: ${learning.question}` : null,
    learning?.symptom ? `Symptom: ${learning.symptom}` : null,
    learning?.failed_approach ? `Failed approach: ${learning.failed_approach}` : null,
    learning?.root_cause ? `Root cause: ${learning.root_cause}` : null,
    learning?.correction ? `Correction: ${learning.correction}` : null,
    learning?.verified_outcome ? `Verified outcome: ${learning.verified_outcome}` : null,
    learning?.avoidance_rule ? `Avoidance rule: ${learning.avoidance_rule}` : null,
    ...(Array.isArray(learning?.applicability?.components)
      ? learning.applicability.components.map((component) => `Component: ${component}`)
      : [])
  ].filter(Boolean);
  if (learningContext.length > 0) {
    append("profile", learningContext.join(" "), {
      metadata: { channel: "learning_context", lesson_type: learning?.lesson_type ?? null }
    });
  }

  segmentText(`${record.summary ?? ""}\n${record.content}`).forEach((text, index) => {
    const segmentId = `seg_${hash(`${record.id}\0${index}\0${text}`).slice(0, 28)}`;
    append("segment", text, {
      segment_id: segmentId,
      metadata: {
        level: "record",
        record_count: 1,
        overlap_ratio: RETRIEVAL_SEGMENT_OVERLAP_RATIO,
        max_records: RETRIEVAL_SEGMENT_MAX_RECORDS,
        max_chars: RETRIEVAL_SEGMENT_MAX_CHARS
      }
    });
  });

  return units;
}

export function buildVerifiedLearningRetrievalUnits(record, now = Date.now()) {
  if (record?.capture_origin !== "observed" || record?.verification_state !== "verified") return [];
  if (Number.isFinite(record.valid_until) && record.valid_until <= now) return [];
  let learning;
  try { learning = JSON.parse(record.learning_json ?? "null"); } catch { return []; }
  if (!learning || typeof learning !== "object") return [];
  const conclusion = collapseWhitespace(learning.conclusion);
  const rationale = collapseWhitespace(learning.rationale);
  const trigger = collapseWhitespace(learning.trigger);
  const reuseRule = collapseWhitespace(learning.reuse_rule);
  const outcome = collapseWhitespace(learning.outcome ?? "decision recorded");
  if (!conclusion || !rationale || !trigger || !reuseRule) return [];
  const applicability = learning.applicability && typeof learning.applicability === "object" ? learning.applicability : {};
  const scope = [
    ...(Array.isArray(applicability.target_files) ? applicability.target_files : []),
    ...(Array.isArray(applicability.components) ? applicability.components : [])
  ].map(collapseWhitespace).filter(Boolean);
  const specs = [
    ["atomic", conclusion, { channel: "atomic", lesson_type: learning.lesson_type, kind: learning.kind }],
    ["profile", `Trigger: ${trigger}. Reuse or avoid: ${reuseRule}. Applies to: ${scope.join(", ") || "project scope"}.`, { channel: "profile", scope }],
    ["ledger", `Verified outcome: ${outcome}.`, { channel: "ledger", verification_state: "verified" }],
    ["timeline", `Observed and verified at ${new Date(record.verified_at ?? record.updated_at).toISOString()}.`, { channel: "timeline" }],
    ["segment", `${conclusion} Reason: ${rationale} Reuse or avoidance: ${reuseRule} Outcome: ${outcome}.`, { channel: "segment" }]
  ];
  return specs.map(([unitType, rawText, metadata], index) => {
    const text = clip(rawText, RETRIEVAL_SEGMENT_MAX_CHARS);
    return {
      id: `learn_${hash(`${record.id}\0${unitType}\0${index}\0${text}`).slice(0, 27)}`,
      memory_id: record.id,
      tenant_id: record.tenant_id,
      project_id: record.project_id ?? null,
      unit_type: unitType,
      speaker: null,
      text,
      event_at: unitType === "timeline" ? record.verified_at ?? record.updated_at : retrievalUnitEventAt(record),
      valid_from: record.valid_from ?? null,
      valid_until: record.valid_until ?? null,
      source_ref_json: JSON.stringify(sourceReference(record)),
      source_span_start: null,
      source_span_end: null,
      content_hash: hash(text),
      metadata_json: JSON.stringify(metadata),
      segment_id: unitType === "segment" ? `seg_${hash(`${record.id}\0${text}`).slice(0, 28)}` : null,
      extractor: "verified-learning",
      extractor_version: "1",
      extraction_state: "ready",
      degraded_reason: null,
      created_at: record.updated_at ?? record.created_at ?? Date.now()
    };
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
  if (
    /\b(?:implement|implementation|show me how|code snippets?|format(?:ting)?|write (?:code|a function)|generate (?:code|an example))\b|(?:実装|コード|書き方|形式)/u.test(text)
  ) unitTypes.push("instruction");
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
