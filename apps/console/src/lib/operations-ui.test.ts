import { describe, expect, it } from "vitest";
import { buildOperationsActions } from "./operations-ui";

describe("operations actions", () => {
  it("prioritizes actionable failures and exposes stable anchors", () => {
    const actions = buildOperationsActions({
      tasks: { failed: 2, stuck: 1 },
      retention_queue: { overdue: 1, failed: 0, manual_review: 0 },
      memories: { conflicting: 3, expired: 0 },
      decision_review: { low_confidence: 1, unconfirmed: 2 },
      audit: { denied_24h: 1, failed_24h: 1 },
      scheduled_jobs: [{ stale: true, job_name: "memory-maintenance" }]
    });

    expect(actions.map((action) => action.id)).toEqual([
      "failed-tasks",
      "retention",
      "stuck-tasks",
      "memory-conflicts",
      "decision-review",
      "stale-jobs",
      "audit-events"
    ]);
    expect(actions[0]).toMatchObject({ tone: "critical", count: 2, href: "#failed-tasks" });
  });

  it("returns no actions for a healthy operations snapshot", () => {
    expect(buildOperationsActions({
      tasks: { failed: 0, stuck: 0 },
      retention_queue: { overdue: 0, failed: 0, manual_review: 0 },
      memories: { conflicting: 0, expired: 0 },
      decision_review: { low_confidence: 0, unconfirmed: 0 },
      audit: { denied_24h: 0, failed_24h: 0 },
      scheduled_jobs: [{ stale: false }]
    })).toEqual([]);
  });
});
