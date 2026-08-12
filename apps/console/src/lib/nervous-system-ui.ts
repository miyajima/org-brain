import type {
  DashboardActivityEvent,
  DashboardActivityResponse,
  DashboardAttention,
  DashboardObservedAgent
} from "@org-brain/contracts";
import { intelligenceDateLocale, intelligencePageCopy, type IntelligenceLocale } from "./intelligence-locale";

export type ActivityActor = DashboardActivityEvent["actor"];
export type ActivityEvent = DashboardActivityEvent;
export type ObservedAgent = DashboardObservedAgent;
export type AttentionSignal = DashboardAttention;

const HOUR_MS = 60 * 60 * 1000;

export const ACTIVITY_PERIODS = [
  { key: "24h", durationMs: 24 * HOUR_MS },
  { key: "3d", durationMs: 3 * 24 * HOUR_MS },
  { key: "7d", durationMs: 7 * 24 * HOUR_MS },
  { key: "30d", durationMs: 30 * 24 * HOUR_MS }
] as const;

export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number];
export type ActivityPeriodKey = ActivityPeriod["key"];
export type ActivityCapabilityKey = "remember" | "understand" | "evaluate" | "apply";

export type ActivityCapabilitySummary = {
  key: ActivityCapabilityKey;
  count: number;
  latestEvent: ActivityEvent | null;
};

export type DashboardActivity = Omit<DashboardActivityResponse, "contract_version" | "oldest_cursor" | "newest_cursor"> & {
  oldest_cursor: string | number | null;
  newest_cursor: string | number | null;
};

export type ProjectPulse = {
  id: string;
  label: string;
  eventCount: number;
  criticalCount: number;
  lastSeenAt: number;
};

export type ActivityTimelinePoint = {
  event: ActivityEvent;
  x: number;
  row: number;
};

export type ActivityTimelineBucket = {
  index: number;
  startAt: number;
  endAt: number;
  count: number;
  warningCount: number;
  criticalCount: number;
  latestEvent: ActivityEvent | null;
};

export type ActivityEventContext = {
  project: string | null;
  category: string | null;
  title: string;
  structured: boolean;
};

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

function nullableText(value: unknown): string | null {
  const parsed = text(value);
  return parsed || null;
}

export function resolveActivityPeriod(value: string | null | undefined): ActivityPeriod {
  return ACTIVITY_PERIODS.find((period) => period.key === value) ?? ACTIVITY_PERIODS[0];
}

export function activityWindowParams(
  scope: URLSearchParams,
  period: ActivityPeriod,
  now = Date.now()
): URLSearchParams {
  const params = new URLSearchParams(scope);
  params.set("from", String(Math.max(0, now - period.durationMs)));
  params.set("to", String(now));
  params.set("limit", "250");
  return params;
}

export function activityCapabilityForEvent(event: Pick<ActivityEvent, "type">): ActivityCapabilityKey | null {
  if (event.type === "memory.write" || event.type === "decision.write") return "remember";
  if (event.type === "memory.read" || event.type === "memory.retrieval") return "understand";
  if (event.type === "memory.effect") return "evaluate";
  if (event.type.startsWith("task.") || event.type.startsWith("agent.run.") || event.type.startsWith("handoff.")) return "apply";
  return null;
}

export function resolveActivityCapability(value: string | null | undefined): ActivityCapabilityKey | null {
  return value === "remember" || value === "understand" || value === "evaluate" || value === "apply" ? value : null;
}

export function buildActivityCapabilitySummaries(events: ActivityEvent[]): ActivityCapabilitySummary[] {
  const summaries: ActivityCapabilitySummary[] = ["remember", "understand", "evaluate", "apply"].map((key) => ({
    key: key as ActivityCapabilityKey,
    count: 0,
    latestEvent: null
  }));
  const byKey = new Map(summaries.map((summary) => [summary.key, summary]));
  for (const event of events) {
    const key = activityCapabilityForEvent(event);
    if (!key) continue;
    const summary = byKey.get(key);
    if (!summary) continue;
    summary.count += 1;
    if (!summary.latestEvent || event.occurred_at > summary.latestEvent.occurred_at) summary.latestEvent = event;
  }
  return summaries;
}

export function activityEventContext(
  event: Pick<ActivityEvent, "project_id" | "subject">
): ActivityEventContext {
  const subjectLabel = event.subject.label?.trim() || event.subject.id;
  const segments = subjectLabel.split(/\s*\|\s*/u).map((segment) => segment.trim()).filter(Boolean);
  let project = event.project_id?.trim() || null;
  let structured = false;

  if (!project && segments.length >= 3 && segments[0].length <= 64) {
    project = segments.shift() ?? null;
    structured = true;
  } else if (project && segments[0]?.toLocaleLowerCase() === project.toLocaleLowerCase()) {
    segments.shift();
    structured = true;
  }

  const category = segments.length >= 2 && segments[0].length <= 32 ? segments.shift() ?? null : null;
  if (category) structured = true;

  return {
    project,
    category,
    title: segments.join(" | ") || subjectLabel,
    structured
  };
}

export function normalizeDashboardActivity(value: unknown): DashboardActivity {
  const source = record(value);
  const events = Array.isArray(source.events) ? source.events.map((raw): ActivityEvent | null => {
    const item = record(raw);
    const actor = record(item.actor);
    const subject = record(item.subject);
    const target = item.target == null ? null : record(item.target);
    const id = text(item.id);
    if (!id) return null;
    const severity = item.severity === "warning" || item.severity === "critical" ? item.severity : "info";
    const kind = actor.kind === "principal" || actor.kind === "agent" ? actor.kind : "system";
    return {
      id,
      type: text(item.type, "activity"),
      occurred_at: numeric(item.occurred_at),
      project_id: nullableText(item.project_id),
      task_id: nullableText(item.task_id),
      trace_id: nullableText(item.trace_id),
      actor: { id: text(actor.id, "system"), label: text(actor.label, text(actor.id, "System")), kind },
      subject: { type: text(subject.type, "record"), id: text(subject.id), label: text(subject.label, text(subject.id, "Record")) },
      target: target ? { type: text(target.type, "record"), id: text(target.id), label: text(target.label, text(target.id, "Record")) } : null,
      severity,
      status: nullableText(item.status),
      summary: text(item.summary, text(subject.label, "Activity")),
      metadata: Object.fromEntries(Object.entries(record(item.metadata)).filter(([, child]) => child == null || ["string", "number", "boolean"].includes(typeof child))) as ActivityEvent["metadata"]
    };
  }).filter((item): item is ActivityEvent => Boolean(item)).sort((left, right) => right.occurred_at - left.occurred_at) : [];

  const observed_agents = Array.isArray(source.observed_agents) ? source.observed_agents.map((raw): ObservedAgent | null => {
    const item = record(raw);
    const id = text(item.id);
    if (!id) return null;
    return {
      id,
      label: text(item.label, id),
      model: nullableText(item.model),
      state: item.state === "active" ? "active" : "idle",
      last_seen_at: numeric(item.last_seen_at),
      active_task_count: numeric(item.active_task_count),
      read_count: numeric(item.read_count),
      write_count: numeric(item.write_count),
      failure_count: numeric(item.failure_count)
    };
  }).filter((item): item is ObservedAgent => Boolean(item)).sort((left, right) => right.last_seen_at - left.last_seen_at) : [];

  const attention = Array.isArray(source.attention) ? source.attention.map((raw): AttentionSignal | null => {
    const item = record(raw);
    const id = text(item.id);
    const allowedKinds = new Set<AttentionSignal["kind"]>(["task_stalled", "task_failed", "handoff_unacked", "impact_unreported", "retrieval_miss", "negative_memory_effect", "decision_conflict", "memory_dormant", "memory_expired"]);
    if (!id || !allowedKinds.has(item.kind as AttentionSignal["kind"])) return null;
    return {
      id,
      kind: item.kind as AttentionSignal["kind"],
      severity: item.severity === "critical" ? "critical" : "warning",
      detected_at: numeric(item.detected_at),
      subject_type: text(item.subject_type, "record"),
      subject_id: text(item.subject_id),
      reason: text(item.reason, "Review required")
    };
  }).filter((item): item is AttentionSignal => Boolean(item)).sort((left, right) => right.detected_at - left.detected_at) : [];

  return {
    events,
    observed_agents,
    attention,
    oldest_cursor: typeof source.oldest_cursor === "string" || typeof source.oldest_cursor === "number" ? source.oldest_cursor : null,
    newest_cursor: typeof source.newest_cursor === "string" || typeof source.newest_cursor === "number" ? source.newest_cursor : null,
    has_more: source.has_more === true,
    generated_at: numeric(source.generated_at)
  };
}

export function hasDashboardActivityContent(
  activity: Pick<DashboardActivity, "events" | "observed_agents" | "attention">
): boolean {
  return activity.events.length > 0 || activity.observed_agents.length > 0 || activity.attention.length > 0;
}

export function buildProjectPulses(events: ActivityEvent[]): ProjectPulse[] {
  const pulses = new Map<string, ProjectPulse>();
  for (const event of events) {
    if (!event.project_id) continue;
    const current = pulses.get(event.project_id) ?? { id: event.project_id, label: event.project_id, eventCount: 0, criticalCount: 0, lastSeenAt: 0 };
    current.eventCount += 1;
    if (event.severity === "critical") current.criticalCount += 1;
    current.lastSeenAt = Math.max(current.lastSeenAt, event.occurred_at);
    pulses.set(event.project_id, current);
  }
  return [...pulses.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}

export function activityTimelineWidth(eventCount: number): number {
  return Math.max(960, Math.min(7_200, Math.max(0, Math.floor(eventCount)) * 24));
}

export function layoutActivityTimeline(
  events: ActivityEvent[],
  start: number,
  end: number,
  width = activityTimelineWidth(events.length),
  minimumGap = 46
): ActivityTimelinePoint[] {
  const span = Math.max(1, end - start);
  const edgeInset = 22;
  const usableWidth = Math.max(1, width - edgeInset * 2);
  const lastXByRow: number[] = [];
  return [...events]
    .sort((left, right) => left.occurred_at - right.occurred_at || left.id.localeCompare(right.id))
    .map((event) => {
      const ratio = Math.max(0, Math.min(1, (event.occurred_at - start) / span));
      const x = edgeInset + ratio * usableWidth;
      let row = lastXByRow.findIndex((lastX) => x - lastX >= minimumGap);
      if (row < 0) row = lastXByRow.length;
      lastXByRow[row] = x;
      return { event, x, row };
    });
}

export function bucketActivityTimeline(
  events: ActivityEvent[],
  start: number,
  end: number,
  bucketCount = 12
): ActivityTimelineBucket[] {
  const count = Math.max(1, Math.floor(bucketCount));
  const span = Math.max(1, end - start);
  const bucketSpan = span / count;
  const buckets = Array.from({ length: count }, (_, index): ActivityTimelineBucket => ({
    index,
    startAt: start + index * bucketSpan,
    endAt: index === count - 1 ? end : start + (index + 1) * bucketSpan,
    count: 0,
    warningCount: 0,
    criticalCount: 0,
    latestEvent: null
  }));

  for (const event of events) {
    const ratio = Math.max(0, Math.min(1, (event.occurred_at - start) / span));
    const index = Math.min(count - 1, Math.floor(ratio * count));
    const bucket = buckets[index];
    bucket.count += 1;
    if (event.severity === "warning") bucket.warningCount += 1;
    if (event.severity === "critical") bucket.criticalCount += 1;
    if (
      !bucket.latestEvent
      || event.occurred_at > bucket.latestEvent.occurred_at
      || (event.occurred_at === bucket.latestEvent.occurred_at && event.id.localeCompare(bucket.latestEvent.id) > 0)
    ) bucket.latestEvent = event;
  }

  return buckets;
}

export function eventDeepLink(event: ActivityEvent, scope: URLSearchParams): string | null {
  const params = new URLSearchParams(scope);
  if (event.task_id) return `/tasks/${encodeURIComponent(event.task_id)}?${params.toString()}`;
  const type = event.subject.type;
  if (type.includes("memory") && !type.includes("decision")) {
    params.set("selected", event.subject.id);
    return `/memories?${params.toString()}`;
  }
  if (type.includes("decision")) {
    params.set("selected", event.subject.id);
    return `/decisions?${params.toString()}`;
  }
  if (type.includes("resource")) return `/resources?${params.toString()}`;
  return null;
}

export function relativeTime(timestamp: number, now = Date.now(), locale: IntelligenceLocale = "en"): string {
  if (!timestamp) return intelligencePageCopy(locale).nervous.timeUnknown;
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  const formatter = new Intl.RelativeTimeFormat(intelligenceDateLocale(locale), { numeric: "always" });
  if (seconds < 60) return formatter.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.round(hours / 24), "day");
}
