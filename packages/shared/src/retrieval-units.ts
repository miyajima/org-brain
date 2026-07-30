import { sha256 } from "./hash";
import type { MemoryRecordV2, MemorySourceReference } from "./memory-store";

export const RETRIEVAL_UNIT_EXTRACTOR = "deterministic-retrieval-units-v1";
export const RETRIEVAL_UNIT_EXTRACTOR_VERSION = "1";

export type RetrievalUnitType =
  | "session"
  | "turn"
  | "fact"
  | "update"
  | "preference"
  | "event"
  | "quantity"
  | "synopsis";

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
>;

const ROLE_LINE_RE = /^(user|assistant|system|tool)\s*:\s*/iu;
const UPDATE_RE = /\b(?:now|currently|latest|recently|changed|switched|replaced|no longer|instead|updated|moved|started|stopped)\b|(?:現在|最近|変更|切り替え|更新|やめた|始めた)/iu;
const PREFERENCE_RE = /\b(?:prefer|like|love|favorite|favourite|rather|avoid|dislike|interested in)\b|(?:好み|好き|嫌い|優先|避ける)/iu;
const EVENT_RE = /\b(?:went|visited|attended|bought|sold|started|finished|completed|graduated|married|born|traveled|travelled|returned|joined|left|met|worked|ran|drove|watched|read|made|paid|spent)\b|(?:行った|訪れた|参加|購入|売却|開始|完了|卒業|結婚|生まれ|旅行|帰った|入社|退社|会った|支払)/iu;
const QUANTITY_RE = /(?:[$€£¥]\s?\d)|(?:\b\d+(?:\.\d+)?\s*(?:%|percent|minutes?|hours?|days?|weeks?|months?|years?|miles?|kilometers?|km|pages?|times?|people|items?|dollars?)\b)|(?:\d+\s*(?:分|時間|日|週間|か月|ヶ月|年|回|人|個|円))/iu;
const DATE_RE = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|(?:月曜|火曜|水曜|木曜|金曜|土曜|日曜|\d{1,2}月\d{0,2}日?)/iu;
const FACT_RE = /\b(?:am|is|are|was|were|have|has|had|use|uses|live|work|own|graduated|degree|brand|name|role)\b|(?:です|である|持って|使って|住んで|働いて|卒業|学位|名前|役職)/iu;

function collapseWhitespace(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function classifyAtomicUnit(text: string): RetrievalUnitType | null {
  if (UPDATE_RE.test(text)) return "update";
  if (PREFERENCE_RE.test(text)) return "preference";
  if (EVENT_RE.test(text) || DATE_RE.test(text)) return "event";
  if (QUANTITY_RE.test(text)) return "quantity";
  if (FACT_RE.test(text)) return "fact";
  return null;
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
      event_at: record.valid_from ?? record.created_at,
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
  speaker: "user" | "assistant" | null;
  unit_types: RetrievalUnitType[];
};

export function analyzeRetrievalIntent(query: string): RetrievalIntent {
  const text = collapseWhitespace(query).toLowerCase();
  const temporalDirection =
    /\b(?:first|earliest|before|initially|originally)\b|(?:最初|以前|当初)/u.test(text)
      ? "earliest"
      : /\b(?:latest|most recent|recently|currently|current|now|last)\b|(?:最新|最近|現在|今|最後)/u.test(text)
        ? "latest"
        : null;
  const speaker =
    /\b(?:assistant|you said|you recommended|you suggested|your answer)\b|(?:アシスタント|あなたが(?:言|勧|提案))/u.test(text)
      ? "assistant"
      : /\b(?:i said|i mentioned|my|i currently|i use|i prefer)\b|(?:私|自分)/u.test(text)
        ? "user"
        : null;
  const unitTypes: RetrievalUnitType[] = [];
  if (PREFERENCE_RE.test(text)) unitTypes.push("preference");
  if (UPDATE_RE.test(text)) unitTypes.push("update");
  if (QUANTITY_RE.test(text) || /\b(?:how many|how much|total|average|percentage)\b|(?:いくつ|何回|合計|平均|割合)/u.test(text)) {
    unitTypes.push("quantity");
  }
  if (DATE_RE.test(text) || temporalDirection) unitTypes.push("event");
  return {
    temporal_direction: temporalDirection,
    speaker,
    unit_types: [...new Set(unitTypes)]
  };
}
