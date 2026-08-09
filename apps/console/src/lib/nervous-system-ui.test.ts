import { describe, expect, it } from "vitest";
import { activityCapabilityForEvent, activityTimelineWidth, activityWindowParams, buildActivityCapabilitySummaries, buildProjectPulses, eventDeepLink, hasDashboardActivityContent, layoutActivityTimeline, normalizeDashboardActivity, relativeTime, resolveActivityCapability, resolveActivityPeriod } from "./nervous-system-ui";

describe("nervous system view model", () => {
  it("builds deterministic activity windows through 30 days", () => {
    const now = Date.UTC(2026, 7, 8, 12);
    expect(resolveActivityPeriod(null).key).toBe("24h");
    expect(resolveActivityPeriod("unknown").key).toBe("24h");
    const period = resolveActivityPeriod("30d");
    const params = activityWindowParams(new URLSearchParams({ tenant_id: "default", project_id: "org-brain" }), period, now);
    expect(params.get("tenant_id")).toBe("default");
    expect(params.get("project_id")).toBe("org-brain");
    expect(Number(params.get("to")) - Number(params.get("from"))).toBe(30 * 86_400_000);
    expect(params.get("limit")).toBe("250");
  });

  it("classifies activity into the four visible Org Brain capabilities", () => {
    const events = normalizeDashboardActivity({
      events: [
        { id: "write", type: "memory.write", occurred_at: 4, actor: {}, subject: { id: "m", type: "memory" } },
        { id: "search", type: "memory.retrieval", occurred_at: 3, actor: {}, subject: { id: "t", type: "task" } },
        { id: "effect", type: "memory.effect", occurred_at: 2, actor: {}, subject: { id: "u", type: "memory_usage" } },
        { id: "task", type: "task.failed", occurred_at: 1, actor: {}, subject: { id: "t", type: "task" } },
        { id: "future", type: "future.event", occurred_at: 5, actor: {}, subject: { id: "x", type: "record" } }
      ]
    }).events;
    expect(events.map(activityCapabilityForEvent)).toEqual([null, "remember", "understand", "evaluate", "apply"]);
    expect(buildActivityCapabilitySummaries(events).map(({ key, count, latestEvent }) => ({ key, count, latest: latestEvent?.id }))).toEqual([
      { key: "remember", count: 1, latest: "write" },
      { key: "understand", count: 1, latest: "search" },
      { key: "evaluate", count: 1, latest: "effect" },
      { key: "apply", count: 1, latest: "task" }
    ]);
    expect(resolveActivityCapability("evaluate")).toBe("evaluate");
    expect(resolveActivityCapability("unknown")).toBeNull();
  });

  it("normalizes and orders real activity records", () => {
    const result = normalizeDashboardActivity({
      generated_at: 100,
      events: [
        { id: "old", occurred_at: 10, actor: { id: "a", kind: "agent" }, subject: { id: "m", type: "memory" } },
        { id: "new", occurred_at: 20, severity: "critical", project_id: "p", actor: { id: "b" }, subject: { id: "t", type: "task" } }
      ],
      observed_agents: [{ id: "b", state: "active", last_seen_at: 20 }],
      attention: []
    });
    expect(result.events.map((event) => event.id)).toEqual(["new", "old"]);
    expect(result.events[0].actor.kind).toBe("system");
    expect(buildProjectPulses(result.events)).toMatchObject([{ id: "p", criticalCount: 1 }]);
  });

  it("builds canonical deep links without dropping scope", () => {
    const event = normalizeDashboardActivity({ events: [{ id: "e", occurred_at: 1, actor: {}, subject: { id: "mem 1", type: "memory" } }] }).events[0];
    const href = eventDeepLink(event, new URLSearchParams({ tenant_id: "acme", project_id: "project 1", lang: "ja" }));
    expect(href).toBe("/memories?tenant_id=acme&project_id=project+1&lang=ja&selected=mem+1");
  });

  it("formats relative event time in the requested locale", () => {
    const now = Date.UTC(2026, 7, 7, 12);
    const oneHourAgo = now - 60 * 60 * 1000;
    expect(relativeTime(oneHourAgo, now, "en")).toBe("1 hour ago");
    expect(relativeTime(oneHourAgo, now, "ja")).toBe("1 時間前");
    expect(relativeTime(oneHourAgo, now, "zh")).toBe("1小时前");
    expect(relativeTime(0, now, "zh")).toBe("时间未知");
  });

  it("preserves expired-memory attention from dashboard/v1", () => {
    const result = normalizeDashboardActivity({
      attention: [{
        id: "attention:memory:m1:expired",
        kind: "memory_expired",
        severity: "warning",
        detected_at: 100,
        subject_type: "memory",
        subject_id: "m1",
        reason: "Memory validity expired"
      }]
    });

    expect(result.attention).toEqual([
      expect.objectContaining({ kind: "memory_expired", subject_id: "m1" })
    ]);
    expect(hasDashboardActivityContent(result)).toBe(true);
    expect(hasDashboardActivityContent(normalizeDashboardActivity({}))).toBe(false);
  });

  it("stacks a dense 250-event timeline deterministically without same-row target overlap", () => {
    const start = Date.UTC(2026, 7, 7);
    const end = start + 86_400_000;
    const events = normalizeDashboardActivity({
      events: Array.from({ length: 250 }, (_, index) => ({
        id: `event-${index}`,
        occurred_at: start + index * (end - start) / 249,
        actor: { id: "agent", kind: "agent" },
        subject: { id: `subject-${index}`, type: "task" }
      }))
    }).events;
    const width = activityTimelineWidth(events.length);
    const first = layoutActivityTimeline(events, start, end, width);
    expect(layoutActivityTimeline(events, start, end, width)).toEqual(first);
    expect(width).toBeGreaterThan(960);
    for (const row of new Set(first.map((point) => point.row))) {
      const xs = first.filter((point) => point.row === row).map((point) => point.x).sort((left, right) => left - right);
      expect(xs.every((x, index) => index === 0 || x - xs[index - 1] >= 46)).toBe(true);
    }
  });
});
