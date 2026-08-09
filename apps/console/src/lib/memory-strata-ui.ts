import type {
  DashboardSourceType,
  DashboardStrataChain,
  DashboardStrataChainSummary,
  DashboardStrataDetailResponse,
  DashboardStrataRelation,
  DashboardStrataResponse,
  DashboardStrataRevision,
  DashboardStrataSource,
  DashboardStrataType
} from "@org-brain/contracts";

export type StrataChainType = DashboardStrataType;
export type StrataSourceType = DashboardSourceType;

export type StrataAttention = {
  kind: string;
  severity: "info" | "warning" | "critical";
  reason: string;
} | null;

export type StrataChainSummary = Omit<DashboardStrataChainSummary, "attention"> & {
  attention: StrataAttention;
};

export type StrataRevision = Omit<DashboardStrataRevision, "summary"> & {
  summary: string;
};

export type StrataPayload = Omit<DashboardStrataResponse, "contract_version" | "chains" | "oldest_cursor"> & {
  chains: StrataChainSummary[];
  oldest_cursor: string | number | null;
};

export type StrataChainDetail = Omit<DashboardStrataChain, keyof DashboardStrataChainSummary | "revisions"> & StrataChainSummary & {
  revisions: StrataRevision[];
  relations: DashboardStrataRelation[];
  sources: DashboardStrataSource[];
};

export type StrataDetailPayload = {
  chain: StrataChainDetail | null;
  truncated: DashboardStrataDetailResponse["truncated"];
};

export type StrataTimelineEvent = {
  id: string;
  chainId: string;
  lane: StrataChainType;
  title: string;
  timestamp: number;
  state: string;
  operation: string;
  sourceType: StrataSourceType;
  sourceId: string;
  selected: boolean;
  attention: StrataAttention;
  partial: boolean;
};

export type PositionedStrataTimelineEvent = {
  event: StrataTimelineEvent;
  x: number;
  row: number;
};

export type StrataRevisionChange = {
  field: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};

export type StrataRevisionDiff = {
  revision: StrataRevision;
  previousRevision: StrataRevision | null;
  comparable: boolean;
  changes: StrataRevisionChange[];
};

export const STRATA_LANES: Array<{ id: StrataChainType; label: string; sublabel: string }> = [
  { id: "canonical", label: "現在の真実", sublabel: "Canonical" },
  { id: "decision", label: "意思決定", sublabel: "Decisions" },
  { id: "learning", label: "学びと洞察", sublabel: "Learnings" },
  { id: "assumption", label: "前提と仮説", sublabel: "Assumptions" },
  { id: "source", label: "一次情報", sublabel: "Sources" }
];

const CHAIN_TYPES = new Set<StrataChainType>(STRATA_LANES.map((lane) => lane.id));
const SOURCE_TYPES = new Set<StrataSourceType>(["memory", "decision_memory", "knowledge_assertion", "knowledge_resource"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableText(value: unknown): string | null {
  const parsed = text(value);
  return parsed || null;
}

function canonicalSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSnapshotValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalSnapshotValue(child)])
  );
}

function snapshotValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(canonicalSnapshotValue(left)) === JSON.stringify(canonicalSnapshotValue(right));
}

export function buildAdjacentRevisionDiffs(revisions: StrataRevision[]): StrataRevisionDiff[] {
  const ordered = [...revisions].sort((left, right) => left.recorded_at - right.recorded_at || left.id.localeCompare(right.id));
  return ordered.map((revision, index) => {
    const previousRevision = ordered[index - 1] ?? null;
    const previousSnapshot = previousRevision?.snapshot;
    const currentSnapshot = revision.snapshot;
    if (!previousRevision || !previousSnapshot || !currentSnapshot) {
      return { revision, previousRevision, comparable: false, changes: [] };
    }

    const changes: StrataRevisionChange[] = [];
    const keys = [...new Set([...Object.keys(previousSnapshot), ...Object.keys(currentSnapshot)])].sort();
    const partialComparison = previousRevision.partial || revision.partial;
    for (const field of keys) {
      const previousHasField = Object.prototype.hasOwnProperty.call(previousSnapshot, field);
      const currentHasField = Object.prototype.hasOwnProperty.call(currentSnapshot, field);
      // A missing key in a partial snapshot is unknown, not evidence of an addition or removal.
      if (partialComparison && (!previousHasField || !currentHasField)) continue;
      if (!previousHasField && currentHasField) {
        changes.push({ field, kind: "added", after: currentSnapshot[field] });
      } else if (previousHasField && !currentHasField) {
        changes.push({ field, kind: "removed", before: previousSnapshot[field] });
      } else if (!snapshotValuesEqual(previousSnapshot[field], currentSnapshot[field])) {
        changes.push({ field, kind: "changed", before: previousSnapshot[field], after: currentSnapshot[field] });
      }
    }
    return { revision, previousRevision, comparable: true, changes };
  });
}

function normalizeAttention(value: unknown): StrataAttention {
  if (value == null || value === false) return null;
  if (Array.isArray(value)) {
    const reasons = value.map((item) => text(item)).filter(Boolean);
    return reasons.length > 0
      ? { kind: reasons[0], severity: "warning", reason: reasons.join(" · ") }
      : null;
  }
  const item = record(value);
  const kind = text(item.kind, typeof value === "string" ? value : "review_required");
  return {
    kind,
    severity: item.severity === "critical" || item.severity === "warning" ? item.severity : "info",
    reason: text(item.reason, kind)
  };
}

function normalizeChain(value: unknown): StrataChainSummary | null {
  const item = record(value);
  const id = text(item.id);
  const type = CHAIN_TYPES.has(item.type as StrataChainType) ? item.type as StrataChainType : null;
  const sourceType = SOURCE_TYPES.has(item.source_type as StrataSourceType) ? item.source_type as StrataSourceType : null;
  if (!id || !type || !sourceType) return null;
  return {
    id,
    type,
    source_type: sourceType,
    source_id: text(item.source_id, id),
    title: text(item.title, id),
    project_id: nullableText(item.project_id),
    current_state: text(item.current_state, "current"),
    confidence: nullableNumber(item.confidence),
    valid_from: nullableNumber(item.valid_from),
    valid_until: nullableNumber(item.valid_until),
    changed_at: numeric(item.changed_at),
    partial: item.partial === true,
    revision_count: Math.max(0, numeric(item.revision_count)),
    source_count: Math.max(0, numeric(item.source_count)),
    attention: normalizeAttention(item.attention)
  };
}

function normalizeRelation(value: unknown): DashboardStrataRelation | null {
  const item = record(value);
  const targetId = text(item.target_id);
  if (!targetId) return null;
  return {
    relation: text(item.relation, "related"),
    target_type: text(item.target_type, "record"),
    target_id: targetId,
    valid_from: nullableNumber(item.valid_from),
    valid_until: nullableNumber(item.valid_until)
  };
}

function normalizeSource(value: unknown): DashboardStrataSource | null {
  const item = record(value);
  const resourceId = text(item.resource_id);
  if (!resourceId) return null;
  const locator = item.locator == null ? null : record(item.locator);
  return {
    resource_id: resourceId,
    resource_version_id: nullableText(item.resource_version_id),
    title: text(item.title, resourceId),
    relation: text(item.relation, "source"),
    captured_at: nullableNumber(item.captured_at),
    locator,
    unresolved: item.unresolved === true
  };
}

export function normalizeStrataPayload(value: unknown): StrataPayload {
  const source = record(value);
  return {
    chains: Array.isArray(source.chains)
      ? source.chains.map(normalizeChain).filter((item): item is StrataChainSummary => Boolean(item))
      : [],
    oldest_cursor: typeof source.oldest_cursor === "string" || typeof source.oldest_cursor === "number" ? source.oldest_cursor : null,
    has_more: source.has_more === true,
    generated_at: numeric(source.generated_at),
    truncated: source.truncated === true
  };
}

export function normalizeStrataDetail(value: unknown): StrataDetailPayload {
  const source = record(value);
  const chainValue = record(source.chain);
  const summary = normalizeChain(chainValue);
  const revisions = Array.isArray(chainValue.revisions) ? chainValue.revisions.map((raw): StrataRevision | null => {
    const item = record(raw);
    const id = text(item.id);
    if (!id) return null;
    const snapshot = record(item.snapshot);
    return {
      id,
      operation: text(item.operation, "revision"),
      recorded_at: numeric(item.recorded_at),
      valid_from: nullableNumber(item.valid_from),
      valid_until: nullableNumber(item.valid_until),
      actor_id: nullableText(item.actor_id),
      state: text(item.state, "current"),
      summary: text(item.summary, summary?.title ?? id),
      partial: item.partial === true,
      ...(Object.keys(snapshot).length > 0 ? { snapshot } : {})
    };
  }).filter((item): item is StrataRevision => Boolean(item)).sort((left, right) => left.recorded_at - right.recorded_at) : [];
  const truncated = record(source.truncated);
  return {
    chain: summary ? {
      ...summary,
      revisions,
      relations: Array.isArray(chainValue.relations)
        ? chainValue.relations.map(normalizeRelation).filter((item): item is DashboardStrataRelation => Boolean(item))
        : [],
      sources: Array.isArray(chainValue.sources)
        ? chainValue.sources.map(normalizeSource).filter((item): item is DashboardStrataSource => Boolean(item))
        : []
    } : null,
    truncated: { revisions: truncated.revisions === true, sources: truncated.sources === true }
  };
}

export function buildStrataTimeline(payload: StrataPayload, detail: StrataDetailPayload | null): StrataTimelineEvent[] {
  const selected = detail?.chain ?? null;
  const events: StrataTimelineEvent[] = [];
  const chains = selected && !payload.chains.some((chain) => chain.id === selected.id)
    ? [...payload.chains, selected]
    : payload.chains;
  for (const chain of chains) {
    const isSelected = selected?.id === chain.id;
    const displayChain = isSelected ? selected : chain;
    if (isSelected && selected.revisions.length > 0) {
      for (const revision of selected.revisions) {
        events.push({
          id: revision.id,
          chainId: displayChain.id,
          lane: displayChain.type,
          title: revision.summary,
          timestamp: revision.recorded_at,
          state: revision.state,
          operation: revision.operation,
          sourceType: displayChain.source_type,
          sourceId: displayChain.source_id,
          selected: true,
          attention: displayChain.attention,
          partial: revision.partial
        });
      }
    } else {
      events.push({
        id: displayChain.id,
        chainId: displayChain.id,
        lane: displayChain.type,
        title: displayChain.title,
        timestamp: displayChain.changed_at,
        state: displayChain.current_state,
        operation: "current",
        sourceType: displayChain.source_type,
        sourceId: displayChain.source_id,
        selected: isSelected,
        attention: displayChain.attention,
        partial: displayChain.partial
      });
    }
  }
  return events.sort((left, right) => left.timestamp - right.timestamp);
}

export function timelineBounds(events: StrataTimelineEvent[], now = Date.now()): { start: number; end: number } {
  const timestamps = events.map((event) => event.timestamp).filter((value) => value > 0);
  if (timestamps.length === 0) return { start: now - 30 * 86_400_000, end: now };
  const start = Math.min(...timestamps);
  const end = Math.max(now, ...timestamps);
  return start === end ? { start: start - 86_400_000, end } : { start, end };
}

export function timelinePercent(timestamp: number, bounds: { start: number; end: number }): number {
  const span = Math.max(1, bounds.end - bounds.start);
  return Math.max(3, Math.min(97, ((timestamp - bounds.start) / span) * 94 + 3));
}

export function strataTimelineTrackWidth(events: StrataTimelineEvent[]): number {
  const counts = new Map<StrataChainType, number>();
  for (const event of events) counts.set(event.lane, (counts.get(event.lane) ?? 0) + 1);
  const densestLane = Math.max(0, ...counts.values());
  return Math.max(1_000, Math.min(12_000, densestLane * 90));
}

export function layoutStrataTimelineRows(
  events: StrataTimelineEvent[],
  bounds: { start: number; end: number },
  trackWidth = strataTimelineTrackWidth(events),
  minimumGap = 176
): PositionedStrataTimelineEvent[] {
  const lastXByLaneAndRow = new Map<StrataChainType, number[]>();
  return [...events]
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    .map((event) => {
      const unclampedX = timelinePercent(event.timestamp, bounds) / 100 * trackWidth;
      const cardHalfWidth = 88;
      const x = Math.max(cardHalfWidth, Math.min(trackWidth - cardHalfWidth, unclampedX));
      const laneRows = lastXByLaneAndRow.get(event.lane) ?? [];
      let row = laneRows.findIndex((lastX) => x - lastX >= minimumGap);
      if (row < 0) row = laneRows.length;
      laneRows[row] = x;
      lastXByLaneAndRow.set(event.lane, laneRows);
      return { event, x, row };
    });
}

export function strataDeepLink(sourceType: StrataSourceType, sourceId: string, scope: URLSearchParams): string | null {
  const params = new URLSearchParams(scope);
  if (sourceType === "decision_memory") {
    params.set("selected", sourceId);
    return `/decisions?${params.toString()}`;
  }
  if (sourceType === "knowledge_resource") {
    params.set("selected", sourceId);
    return `/resources?${params.toString()}`;
  }
  if (sourceType === "knowledge_assertion") return null;
  params.set("selected", sourceId);
  return `/memories?${params.toString()}`;
}
