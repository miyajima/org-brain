import { describe, expect, it } from "vitest";
import { buildAdjacentRevisionDiffs, buildStrataTimeline, layoutStrataTimelineRows, normalizeStrataDetail, normalizeStrataPayload, strataDeepLink, strataTimelineTrackWidth, timelineBounds, timelinePercent, type StrataTimelineEvent } from "./memory-strata-ui";

describe("memory strata view model", () => {
  const payload = normalizeStrataPayload({
    generated_at: 100,
    chains: [
      { id: "c", type: "canonical", source_type: "memory", source_id: "m", title: "Current", changed_at: 30 },
      { id: "d", type: "decision", source_type: "decision_memory", source_id: "d", title: "Decision", changed_at: 20 }
    ]
  });

  it("preserves the API newest-first chain order while keeping the timeline chronological", () => {
    expect(payload.chains.map((chain) => chain.id)).toEqual(["c", "d"]);
    expect(buildStrataTimeline(payload, null).map((event) => event.id)).toEqual(["d", "c"]);
  });

  it("expands only the selected chain into immutable revisions", () => {
    const detail = normalizeStrataDetail({
      chain: {
        ...payload.chains[0],
        revisions: [
          { id: "r2", recorded_at: 18, summary: "Second" },
          { id: "r1", recorded_at: 10, summary: "First" }
        ]
      },
      truncated: {}
    });
    const events = buildStrataTimeline(payload, detail);
    expect(events.map((event) => event.id)).toEqual(["r1", "r2", "d"]);
    expect(events.filter((event) => event.selected)).toHaveLength(2);
  });

  it("adds a deep-linked chain that is outside the current collection page", () => {
    const detail = normalizeStrataDetail({
      chain: {
        id: "older-chain",
        type: "learning",
        source_type: "memory",
        source_id: "older-memory",
        title: "Older learning",
        changed_at: 5,
        revisions: [
          { id: "older-r1", recorded_at: 4, state: "active", summary: "Older revision" }
        ]
      },
      truncated: {}
    });

    const events = buildStrataTimeline(payload, detail);

    expect(events.map((event) => event.id)).toEqual(["older-r1", "d", "c"]);
    expect(events[0]).toMatchObject({
      chainId: "older-chain",
      lane: "learning",
      sourceId: "older-memory",
      selected: true
    });
  });

  it("keeps timeline positions bounded", () => {
    const bounds = timelineBounds(buildStrataTimeline(payload, null), 40);
    expect(timelinePercent(20, bounds)).toBeGreaterThanOrEqual(3);
    expect(timelinePercent(40, bounds)).toBeLessThanOrEqual(97);
  });

  it("diffs chronologically adjacent revision snapshots without mutating input order", () => {
    const revisions = normalizeStrataDetail({
      chain: {
        ...payload.chains[0],
        revisions: [
          { id: "r2", recorded_at: 20, state: "active", summary: "Active", partial: false, snapshot: { status: "active", confirmation_state: "user_confirmed", valid_until: null } },
          { id: "r1", recorded_at: 10, state: "proposed", summary: "Proposed", partial: false, snapshot: { status: "proposed", confirmation_state: "inferred_unconfirmed" } }
        ]
      },
      truncated: {}
    }).chain?.revisions ?? [];
    revisions.reverse();

    const diffs = buildAdjacentRevisionDiffs(revisions);

    expect(diffs.map((item) => item.revision.id)).toEqual(["r1", "r2"]);
    expect(diffs[1].changes).toEqual([
      { field: "confirmation_state", kind: "changed", before: "inferred_unconfirmed", after: "user_confirmed" },
      { field: "status", kind: "changed", before: "proposed", after: "active" },
      { field: "valid_until", kind: "added", after: null }
    ]);
    expect(revisions.map((revision) => revision.id)).toEqual(["r2", "r1"]);
  });

  it("does not infer removed fields from partial or absent snapshots", () => {
    const revisions = normalizeStrataDetail({
      chain: {
        ...payload.chains[0],
        revisions: [
          { id: "r1", recorded_at: 10, state: "active", summary: "Full", partial: false, snapshot: { content: "before", kind: "semantic", lifecycle_state: "active" } },
          { id: "r2", recorded_at: 20, state: "active", summary: "Partial", partial: true, snapshot: { content: "after" } },
          { id: "r3", recorded_at: 30, state: "active", summary: "No snapshot", partial: true }
        ]
      },
      truncated: {}
    }).chain?.revisions ?? [];

    const diffs = buildAdjacentRevisionDiffs(revisions);

    expect(diffs[1]).toMatchObject({ comparable: true, changes: [{ field: "content", kind: "changed", before: "before", after: "after" }] });
    expect(diffs[1].changes).not.toEqual(expect.arrayContaining([expect.objectContaining({ field: "kind" })]));
    expect(diffs[2]).toMatchObject({ comparable: false, changes: [] });
  });

  it("links resources by selected id and does not misroute assertions as memories", () => {
    const scope = new URLSearchParams("tenant_id=tenant-a&project_id=project-a&lang=ja");

    expect(strataDeepLink("knowledge_resource", "resource-one", scope)).toBe(
      "/resources?tenant_id=tenant-a&project_id=project-a&lang=ja&selected=resource-one"
    );
    expect(strataDeepLink("knowledge_assertion", "assertion-one", scope)).toBeNull();
  });

  it("stacks dense same-lane history deterministically without card overlap", () => {
    const dense = Array.from({ length: 150 }, (_, index): StrataTimelineEvent => ({
      id: `event-${index}`,
      chainId: `chain-${index}`,
      lane: "decision",
      title: `Decision ${index}`,
      timestamp: index + 1,
      state: "current",
      operation: "current",
      sourceType: "decision_memory",
      sourceId: String(index),
      selected: false,
      attention: null,
      partial: false
    }));
    const bounds = { start: 1, end: 150 };
    const width = strataTimelineTrackWidth(dense);
    const first = layoutStrataTimelineRows(dense, bounds, width);
    expect(layoutStrataTimelineRows(dense, bounds, width)).toEqual(first);
    expect(width).toBeGreaterThan(1_000);
    for (const row of new Set(first.map((point) => point.row))) {
      const xs = first.filter((point) => point.row === row).map((point) => point.x).sort((left, right) => left - right);
      expect(xs.every((x, index) => index === 0 || x - xs[index - 1] >= 176)).toBe(true);
    }
  });
});
