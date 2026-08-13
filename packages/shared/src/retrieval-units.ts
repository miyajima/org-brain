import { sha256 } from "./hash";
import type { MemoryRecordV2, MemorySourceReference } from "./memory-store";
import {
  RETRIEVAL_SEGMENT_MAX_CHARS,
  RETRIEVAL_SEGMENT_MAX_RECORDS,
  RETRIEVAL_SEGMENT_OVERLAP_RATIO,
  RETRIEVAL_UNIT_EXTRACTOR,
  RETRIEVAL_UNIT_EXTRACTOR_V4,
  analyzeRetrievalIntent as analyzeCoreRetrievalIntent,
  buildRetrievalUnits as buildCoreRetrievalUnits,
  buildRetrievalUnitsV4 as buildCoreRetrievalUnitsV4,
  buildVerifiedLearningRetrievalUnits as buildCoreVerifiedLearningRetrievalUnits,
  retrievalQueryTokens,
  retrievalSubjectQueryTokens,
  retrievalUnitIntentBoost,
  retrievalUnitLexicalSpecificity,
  splitRetrievalTurns
} from "./retrieval-units-core.mjs";

export {
  RETRIEVAL_SEGMENT_MAX_CHARS,
  RETRIEVAL_SEGMENT_MAX_RECORDS,
  RETRIEVAL_SEGMENT_OVERLAP_RATIO,
  RETRIEVAL_UNIT_EXTRACTOR,
  RETRIEVAL_UNIT_EXTRACTOR_V4,
  retrievalQueryTokens,
  retrievalSubjectQueryTokens,
  retrievalUnitIntentBoost,
  retrievalUnitLexicalSpecificity,
  splitRetrievalTurns
};

export const RETRIEVAL_UNIT_EXTRACTOR_VERSION = "1";
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

export type RetrievalUnitV4 = RetrievalUnit & {
  metadata_json: string;
  segment_id: string | null;
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
> & Partial<Pick<MemoryRecordV2, "kind">>;

export type VerifiedLearningRetrievalRecord = RetrievalUnitRecord & {
  capture_origin?: string | null;
  verification_state?: string | null;
  verified_at?: number | null;
  learning_json?: string | null;
};

export type RetrievalIntent = {
  temporal_direction: "earliest" | "latest" | null;
  relative_age_ms: number | null;
  relative_weekday: number | null;
  speaker: "user" | "assistant" | null;
  unit_types: RetrievalUnitType[];
};

type StructuredUnit = {
  text: string;
  speaker?: RetrievalUnit["speaker"];
  metadata: Record<string, unknown>;
  unit_type?: "atomic" | "profile" | "ledger" | "timeline";
  event_at?: number | null;
};

function firstSourceReference(record: RetrievalUnitRecord): MemorySourceReference | null {
  return record.source_references[0] ?? null;
}

function retrievalUnitEventAt(record: RetrievalUnitRecord): number | null {
  const capturedAt = Number(firstSourceReference(record)?.captured_at);
  if (Number.isFinite(capturedAt) && capturedAt > 0) return capturedAt;
  if (record.valid_from !== null && record.valid_from !== undefined) return record.valid_from;
  return record.created_at;
}

function segmentText(text: string): string[] {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= RETRIEVAL_SEGMENT_MAX_CHARS) return [normalized];
  const overlap = Math.floor(RETRIEVAL_SEGMENT_MAX_CHARS * RETRIEVAL_SEGMENT_OVERLAP_RATIO);
  const step = RETRIEVAL_SEGMENT_MAX_CHARS - overlap;
  const segments: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += step) {
    segments.push(normalized.slice(offset, offset + RETRIEVAL_SEGMENT_MAX_CHARS));
    if (offset + RETRIEVAL_SEGMENT_MAX_CHARS >= normalized.length) break;
  }
  return segments;
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
  const extractionState = options.extractionState ?? "degraded";
  return (buildCoreRetrievalUnits(record) as RetrievalUnit[]).map((unit) => ({
    ...unit,
    extractor: options.extractor ?? RETRIEVAL_UNIT_EXTRACTOR,
    extractor_version: options.extractorVersion ?? RETRIEVAL_UNIT_EXTRACTOR_VERSION,
    extraction_state: extractionState,
    degraded_reason:
      extractionState === "ready"
        ? null
        : options.degradedReason === undefined
          ? unit.degraded_reason
          : options.degradedReason,
    created_at: record.updated_at
  }));
}

export async function buildRetrievalUnitsV4(
  record: RetrievalUnitRecord,
  options: { structuredUnits?: StructuredUnit[]; includeRecordSegments?: boolean } = {}
): Promise<RetrievalUnitV4[]> {
  if (!options.structuredUnits) {
    return buildCoreRetrievalUnitsV4(record) as RetrievalUnitV4[];
  }

  const output: RetrievalUnitV4[] = [];
  for (const candidate of options.structuredUnits) {
    const text = candidate.text.replace(/\s+/gu, " ").trim().slice(0, RETRIEVAL_SEGMENT_MAX_CHARS);
    if (!text) continue;
    const unitType = candidate.unit_type ?? "atomic";
    const idHash = await sha256(`${record.id}\0${unitType}\0${output.length}\0${text}`);
    output.push({
      id: `rv4_${idHash.slice(0, 27)}`,
      memory_id: record.id,
      tenant_id: record.tenant_id,
      project_id: record.project_id,
      unit_type: unitType,
      speaker: candidate.speaker ?? null,
      text,
      event_at: candidate.event_at ?? retrievalUnitEventAt(record),
      valid_from: record.valid_from,
      valid_until: record.valid_until,
      source_ref_json: JSON.stringify(firstSourceReference(record)),
      source_span_start: null,
      source_span_end: null,
      content_hash: await sha256(text),
      metadata_json: JSON.stringify(candidate.metadata),
      segment_id: null,
      extractor: RETRIEVAL_UNIT_EXTRACTOR_V4,
      extractor_version: RETRIEVAL_UNIT_EXTRACTOR_V4_VERSION,
      extraction_state: "ready",
      degraded_reason: null,
      created_at: record.updated_at
    });
  }

  for (const [segmentIndex, text] of (options.includeRecordSegments === false
    ? []
    : segmentText(`${record.summary ?? ""}\n${record.content}`)).entries()) {
    const idHash = await sha256(`${record.id}\0segment\0${output.length}\0${text}`);
    const segmentHash = await sha256(`${record.id}\0${segmentIndex}\0${text}`);
    output.push({
      id: `rv4_${idHash.slice(0, 27)}`,
      memory_id: record.id,
      tenant_id: record.tenant_id,
      project_id: record.project_id,
      unit_type: "segment",
      speaker: null,
      text,
      event_at: retrievalUnitEventAt(record),
      valid_from: record.valid_from,
      valid_until: record.valid_until,
      source_ref_json: JSON.stringify(firstSourceReference(record)),
      source_span_start: null,
      source_span_end: null,
      content_hash: await sha256(text),
      metadata_json: JSON.stringify({
        level: "record",
        record_count: 1,
        overlap_ratio: RETRIEVAL_SEGMENT_OVERLAP_RATIO,
        max_records: RETRIEVAL_SEGMENT_MAX_RECORDS,
        max_chars: RETRIEVAL_SEGMENT_MAX_CHARS
      }),
      segment_id: `seg_${segmentHash.slice(0, 28)}`,
      extractor: RETRIEVAL_UNIT_EXTRACTOR_V4,
      extractor_version: RETRIEVAL_UNIT_EXTRACTOR_V4_VERSION,
      extraction_state: "ready",
      degraded_reason: null,
      created_at: record.updated_at
    });
  }

  return output;
}

export async function buildVerifiedLearningRetrievalUnits(
  record: VerifiedLearningRetrievalRecord,
  now = Date.now()
): Promise<RetrievalUnitV4[]> {
  return buildCoreVerifiedLearningRetrievalUnits(record, now) as RetrievalUnitV4[];
}

export function analyzeRetrievalIntent(query: string): RetrievalIntent {
  return analyzeCoreRetrievalIntent(query) as RetrievalIntent;
}
