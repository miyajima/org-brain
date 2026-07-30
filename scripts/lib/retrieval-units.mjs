import { createHash } from "node:crypto";

export const RETRIEVAL_UNIT_EXTRACTOR = "deterministic-retrieval-units-v1";

const ROLE_LINE_RE = /^(user|assistant|system|tool)\s*:\s*/iu;
const UPDATE_RE = /\b(?:now|currently|latest|recently|changed|switched|replaced|no longer|instead|updated|moved|started|stopped)\b|(?:現在|最近|変更|切り替え|更新|やめた|始めた)/iu;
const PREFERENCE_RE = /\b(?:prefer|like|love|favorite|favourite|rather|avoid|dislike|interested in)\b|(?:好み|好き|嫌い|優先|避ける)/iu;
const EVENT_RE = /\b(?:went|visited|attended|bought|sold|started|finished|completed|graduated|married|born|traveled|travelled|returned|joined|left|met|worked|ran|drove|watched|read|made|paid|spent)\b|(?:行った|訪れた|参加|購入|売却|開始|完了|卒業|結婚|生まれ|旅行|帰った|入社|退社|会った|支払)/iu;
const QUANTITY_RE = /(?:[$€£¥]\s?\d)|(?:\b\d+(?:\.\d+)?\s*(?:%|percent|minutes?|hours?|days?|weeks?|months?|years?|miles?|kilometers?|km|pages?|times?|people|items?|dollars?)\b)|(?:\d+\s*(?:分|時間|日|週間|か月|ヶ月|年|回|人|個|円))/iu;
const DATE_RE = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|(?:月曜|火曜|水曜|木曜|金曜|土曜|日曜|\d{1,2}月\d{0,2}日?)/iu;
const FACT_RE = /\b(?:am|is|are|was|were|have|has|had|use|uses|live|work|own|graduated|degree|brand|name|role)\b|(?:です|である|持って|使って|住んで|働いて|卒業|学位|名前|役職)/iu;

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
      event_at: options.event_at ?? record.valid_from ?? record.created_at ?? null,
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
  const unitTypes = [];
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

export function retrievalUnitIntentBoost(unit, intent) {
  let score = 0;
  if (intent.speaker) {
    if (unit.speaker === intent.speaker) score += 0.025;
    else if (unit.speaker && unit.speaker !== "unknown") score -= 0.01;
  }
  if (intent.unit_types.length > 0) {
    if (intent.unit_types.includes(unit.unit_type)) score += 0.025;
  }
  return score;
}
