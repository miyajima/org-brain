import { describe, expect, it } from "vitest";
import { activityTimelineWidth, buildProjectPulses, eventDeepLink, hasDashboardActivityContent, layoutActivityTimeline, normalizeDashboardActivity, relativeTime } from "./nervous-system-ui";

describe("nervous system view model", () => {
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
