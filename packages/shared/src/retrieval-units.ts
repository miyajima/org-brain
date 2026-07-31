import { sha256 } from "./hash";
import type { MemoryRecordV2, MemorySourceReference } from "./memory-store";

export const RETRIEVAL_UNIT_EXTRACTOR = "deterministic-retrieval-units-v1";
export const RETRIEVAL_UNIT_EXTRACTOR_VERSION = "1";
export const RETRIEVAL_UNIT_EXTRACTOR_V4 = "deterministic-retrieval-units-v4";
export const RETRIEVAL_UNIT_EXTRACTOR_V4_VERSION = "4";

export type RetrievalUnitType =
  | "session"
  | "turn"
  | "fact"
  | "update"
  | "preference"
  | "event"
  | "quantity"
  | "synopsis"
  | "instruction"
  | "atomic"
  | "profile"
  | "ledger"
  | "timeline"
  | "segment";

export type RetrievalUnit = {
  id: string;
  memory_id: string;
  tenant_id: string;
  project_id: string | null;
  unit_type: RetrievalUnitType;
  speaker: "user" | "assistant" | "system" | "tool" | "unknown" | null;
  text: string;
  event_at: number | null;
  valid_from: number | null;
  valid_until: number | null;
  source_ref_json: string;
  source_span_start: number | null;
  source_span_end: number | null;
  content_hash: string;
  extractor: string;
  extractor_version: string;
  extraction_state: "ready" | "degraded";
  degraded_reason: string | null;
  created_at: number;
};

export type RetrievalProjectionJob = {
  version: 1;
  tenant_id: string;
  memory_id: string;
  content_hash: string;
  requested_at: number;
};

export type RetrievalUnitV4 = RetrievalUnit & {
  metadata_json: string;
  segment_id: string | null;
};

type RetrievalUnitRecord = Pick<
  MemoryRecordV2,
  | "id"
  | "tenant_id"
  | "project_id"
  | "content"
  | "summary"
  | "created_at"
  | "updated_at"
  | "valid_from"
  | "valid_until"
  | "source_references"
> & Partial<Pick<MemoryRecordV2, "kind">>;

const ROLE_LINE_RE = /^(user|assistant|system|tool)\s*:\s*/iu;
const UPDATE_RE = /\b(?:now|currently|latest|recently|changed|switched|replaced|no longer|instead|updated|moved|started|stopped)\b|(?:現在|最近|変更|切り替え|更新|やめた|始めた)/iu;
const PREFERENCE_RE = /\b(?:prefer|like|love|enjoy|want|would like|favorite|favourite|rather|avoid|dislike|interested in|looking (?:for|at)|thinking (?:of|about)|planning to|plan to|decided|chose|go with)\b|(?:好み|好き|嫌い|優先|避ける|欲しい|探して|考えて|予定)/iu;
const EVENT_RE = /\b(?:went|visited|attended|bought|sold|started|finished|completed|graduated|married|born|traveled|travelled|returned|joined|left|met|worked|ran|drove|watched|read|made|paid|spent)\b|(?:行った|訪れた|参加|購入|売却|開始|完了|卒業|結婚|生まれ|旅行|帰った|入社|退社|会った|支払)/iu;
const QUANTITY_RE = /(?:[$€£¥]\s?\d)|(?:\b\d+(?:\.\d+)?\s*(?:%|percent|minutes?|hours?|days?|weeks?|months?|years?|miles?|kilometers?|km|pages?|times?|people|items?|dollars?)\b)|(?:\d+\s*(?:分|時間|日|週間|か月|ヶ月|年|回|人|個|円))/iu;
const DATE_RE = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|(?:月曜|火曜|水曜|木曜|金曜|土曜|日曜|\d{1,2}月\d{0,2}日?)/iu;
const FACT_RE = /\b(?:am|is|are|was|were|have|has|had|use|uses|live|work|own|graduated|degree|brand|name|role)\b|(?:です|である|持って|使って|住んで|働いて|卒業|学位|名前|役職)/iu;
const INSTRUCTION_RE = /\b(?:always|never|must|should|please|make sure|remember to|do not|don't|avoid)\b|(?:必ず|決して|してはいけない|してください|忘れず|避ける)/iu;
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
const RELATIVE_UNIT_MS: Record<string, number> = {
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
const SUBJECT_QUERY_EXPANSIONS = new Map<string, string[]>([
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

function collapseWhitespace(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function retrievalPrimaryQueryTokens(value: unknown): string[] {
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

export function retrievalQueryTokens(value: unknown): string[] {
  return [...new Set(
    retrievalPrimaryQueryTokens(value)
      .flatMap((token) => [token, ...(LEXICAL_CONCEPT_BY_TERM.get(token) ?? [])])
  )];
}

export function retrievalSubjectQueryTokens(value: unknown): string[] {
  return retrievalPrimaryQueryTokens(value)
    .filter((token) => !SUBJECT_STOP_WORDS.has(token))
    .flatMap((token) => [token, ...(SUBJECT_QUERY_EXPANSIONS.get(token) ?? [])])
    .filter((token, index, tokens) => tokens.indexOf(token) === index);
}

export function retrievalUnitLexicalSpecificity(
  units: Array<{ id: string; text: string }>,
  query: string
): Map<string, number> {
  const queryTokens = retrievalSubjectQueryTokens(query);
  const scores = new Map<string, number>();
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

function classifyAtomicUnit(text: string): RetrievalUnitType | null {
  if (UPDATE_RE.test(text)) return "update";
  if (INSTRUCTION_RE.test(text)) return "instruction";
  if (PREFERENCE_RE.test(text)) return "preference";
  if (EVENT_RE.test(text) || DATE_RE.test(text)) return "event";
  if (QUANTITY_RE.test(text)) return "quantity";
  if (FACT_RE.test(text)) return "fact";
  return null;
}

function unitTypeFromRecordKind(kind: string | undefined): RetrievalUnitType | null {
  if (["constraint", "pitfall"].includes(kind ?? "")) return "instruction";
  if (kind === "preference") return "preference";
  if (["decision", "fact", "semantic", "org_knowledge"].includes(kind ?? "")) return "fact";
  if (["episodic", "event"].includes(kind ?? "")) return "event";
  if (kind === "update") return "update";
  return null;
}

export async function buildRetrievalUnitsV4(
  record: RetrievalUnitRecord,
  options: {
    structuredUnits?: Array<{
      text: string;
      speaker?: RetrievalUnit["speaker"];
      metadata: Record<string, unknown>;
      unit_type?: "atomic" | "profile" | "ledger" | "timeline";
      event_at?: number | null;
    }>;
  } = {}
): Promise<RetrievalUnitV4[]> {
  const base = await buildRetrievalUnits(record, {
    extractor: RETRIEVAL_UNIT_EXTRACTOR_V4,
    extractorVersion: RETRIEVAL_UNIT_EXTRACTOR_V4_VERSION,
    extractionState: options.structuredUnits ? "ready" : "degraded",
    degradedReason: options.structuredUnits ? null : "gemini_structured_extractor_not_configured"
  });
  const fallbackCandidates: NonNullable<typeof options.structuredUnits> = [];
  const semanticUnits = base.filter((item) =>
    !["session", "synopsis", "turn"].includes(item.unit_type)
  );
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
      const metadata = {
        subject: unit.speaker === "user" ? "user" : unit.speaker ?? "unknown",
        predicate: "mentions",
        object: unit.text,
        polarity: /\b(?:not|never|avoid|dislike)\b|(?:ない|禁止|避ける)/iu.test(unit.text)
          ? "negative"
          : "positive",
        domain: unit.unit_type,
        normalized_at: unit.event_at
      };
      const atomic = {
        text: unit.text,
        speaker: unit.speaker,
        event_at: unit.event_at,
        unit_type: "atomic" as const,
        metadata
      };
      fallbackCandidates.push(atomic);
      if (unit.unit_type === "event") {
        fallbackCandidates.push({ ...atomic, unit_type: "timeline" });
        continue;
      }
      if (["preference", "instruction", "update", "fact"].includes(unit.unit_type)) {
        fallbackCandidates.push({ ...atomic, unit_type: "profile" });
        if (unit.unit_type === "update") {
          fallbackCandidates.push({ ...atomic, unit_type: "ledger" });
        }
      }
  }
  const candidates = options.structuredUnits ?? fallbackCandidates;
  const output: RetrievalUnitV4[] = [];
  for (const candidate of candidates) {
    const contentHash = await sha256(candidate.text);
    const idHash = await sha256(
      `${record.id}\0${candidate.unit_type ?? "atomic"}\0${output.length}\0${candidate.text}`
    );
    output.push({
      id: `rv4_${idHash.slice(0, 27)}`,
      memory_id: record.id,
      tenant_id: record.tenant_id,
      project_id: record.project_id,
      unit_type: candidate.unit_type ?? "atomic",
      speaker: candidate.speaker ?? null,
      text: candidate.text.slice(0, 64 * 1024),
      event_at: candidate.event_at ?? retrievalUnitEventAt(record),
      valid_from: record.valid_from,
      valid_until: record.valid_until,
      source_ref_json: JSON.stringify(firstSourceReference(record)),
      source_span_start: null,
      source_span_end: null,
      content_hash: contentHash,
      metadata_json: JSON.stringify(candidate.metadata),
      segment_id: null,
      extractor: RETRIEVAL_UNIT_EXTRACTOR_V4,
      extractor_version: RETRIEVAL_UNIT_EXTRACTOR_V4_VERSION,
      extraction_state: options.structuredUnits ? "ready" : "degraded",
      degraded_reason: options.structuredUnits ? null : "gemini_structured_extractor_not_configured",
      created_at: record.updated_at
    });
  }
  const sessionText = collapseWhitespace(`${record.summary ?? ""}\n${record.content}`).slice(0, 64 * 1024);
  if (sessionText) {
    const contentHash = await sha256(sessionText);
    const idHash = await sha256(`${record.id}\0segment\0${sessionText}`);
    output.push({
      ...base[0],
      id: `rv4_${idHash.slice(0, 27)}`,
      unit_type: "segment",
      text: sessionText,
      content_hash: contentHash,
      metadata_json: JSON.stringify({
        level: "record",
        record_count: 1,
        max_records: 32,
        max_chars: 64 * 1024,
        overlap_ratio: 0.25
      }),
      segment_id: `seg_${idHash.slice(0, 28)}`,
      extractor: RETRIEVAL_UNIT_EXTRACTOR_V4,
      extractor_version: RETRIEVAL_UNIT_EXTRACTOR_V4_VERSION
    });
  }
  return output;
}

function splitTurns(content: string): Array<{ speaker: RetrievalUnit["speaker"]; text: string }> {
  const turns: Array<{ speaker: RetrievalUnit["speaker"]; parts: string[] }> = [];
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(ROLE_LINE_RE);
    if (match) {
      turns.push({
        speaker: match[1].toLowerCase() as RetrievalUnit["speaker"],
        parts: [line.slice(match[0].length)]
      });
    } else if (turns.length > 0) {
      turns.at(-1)?.parts.push(line);
    } else if (line.trim()) {
      turns.push({ speaker: "unknown", parts: [line] });
    }
  }
  return turns
    .map((turn) => ({ speaker: turn.speaker, text: collapseWhitespace(turn.parts.join("\n")) }))
    .filter((turn) => turn.text);
}

function sentences(text: string): string[] {
  return text
    .split(/(?:\r?\n)+|(?<=[。！？.!?])\s+/u)
    .map(collapseWhitespace)
    .filter((sentence) => sentence.length >= 18);
}

function firstSourceReference(record: RetrievalUnitRecord): MemorySourceReference | null {
  return record.source_references[0] ?? null;
}

function retrievalUnitEventAt(record: RetrievalUnitRecord): number | null {
  const capturedAt = Number(firstSourceReference(record)?.captured_at);
  if (Number.isFinite(capturedAt) && capturedAt > 0) return capturedAt;
  if (record.valid_from !== null && record.valid_from !== undefined) return record.valid_from;
  return record.created_at;
}

export async function buildRetrievalUnits(
  record: RetrievalUnitRecord,
  options: {
    extractionState?: "ready" | "degraded";
    degradedReason?: string | null;
    extractor?: string;
    extractorVersion?: string;
  } = {}
): Promise<RetrievalUnit[]> {
  const content = collapseWhitespace(record.content);
  if (!content) return [];
  const extractionState = options.extractionState ?? "degraded";
  const degradedReason =
    options.degradedReason === undefined
      ? "atomic_extractor_not_configured"
      : options.degradedReason;
  const turns = splitTurns(record.content);
  const candidates: Array<{
    unitType: RetrievalUnitType;
    text: string;
    speaker?: RetrievalUnit["speaker"];
  }> = [];
  candidates.push({ unitType: "session", text: `${record.summary ?? ""}\n${record.content}` });
  const synopsis = [
    record.summary,
    ...turns.flatMap((turn) => sentences(turn.text).filter((sentence) => classifyAtomicUnit(sentence))).slice(0, 8)
  ].filter(Boolean).join(" ");
  if (synopsis) candidates.push({ unitType: "synopsis", text: synopsis });
  for (const turn of turns) {
    candidates.push({ unitType: "turn", text: turn.text, speaker: turn.speaker });
    for (const sentence of sentences(turn.text)) {
      const unitType = classifyAtomicUnit(sentence);
      if (unitType) candidates.push({ unitType, text: sentence, speaker: turn.speaker });
    }
  }

  const seen = new Set<string>();
  const units: RetrievalUnit[] = [];
  for (const candidate of candidates) {
    const text = collapseWhitespace(candidate.text).slice(0, 20_000);
    const dedupeKey = `${candidate.unitType}\0${candidate.speaker ?? ""}\0${text.toLowerCase()}`;
    if (!text || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const contentHash = await sha256(text);
    const idHash = await sha256(`${record.id}\0${candidate.unitType}\0${units.length}\0${text}`);
    units.push({
      id: `ru_${idHash.slice(0, 28)}`,
      memory_id: record.id,
      tenant_id: record.tenant_id,
      project_id: record.project_id,
      unit_type: candidate.unitType,
      speaker: candidate.speaker ?? null,
      text,
      event_at: retrievalUnitEventAt(record),
      valid_from: record.valid_from,
      valid_until: record.valid_until,
      source_ref_json: JSON.stringify(firstSourceReference(record)),
      source_span_start: null,
      source_span_end: null,
      content_hash: contentHash,
      extractor: options.extractor ?? RETRIEVAL_UNIT_EXTRACTOR,
      extractor_version: options.extractorVersion ?? RETRIEVAL_UNIT_EXTRACTOR_VERSION,
      extraction_state: extractionState,
      degraded_reason: extractionState === "degraded" ? degradedReason : null,
      created_at: record.updated_at
    });
  }
  return units;
}

export type RetrievalIntent = {
  temporal_direction: "earliest" | "latest" | null;
  relative_age_ms: number | null;
  relative_weekday: number | null;
  speaker: "user" | "assistant" | null;
  unit_types: RetrievalUnitType[];
};

export function analyzeRetrievalIntent(query: string): RetrievalIntent {
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
  const unitTypes: RetrievalUnitType[] = [];
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
