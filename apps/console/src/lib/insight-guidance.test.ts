import { describe, expect, it } from "vitest";
import { normalizeKnowledgeGraph } from "./knowledge-graph-ui";
import { normalizeDashboardActivity } from "./nervous-system-ui";
import { normalizeStrataDetail, normalizeStrataPayload } from "./memory-strata-ui";
import {
  activityRecommendedActions,
  historyRecommendedActions,
  historyHealthyCopy,
  knowledgeHealthyCopy,
  knowledgeMetricInterpretations,
  knowledgeRecommendedActions,
  pageGuide
} from "./insight-guidance";

describe("insight guidance", () => {
  it("explains every surface in plain Japanese", () => {
    expect(pageGuide("activity", "ja").useWhen).toContain("状況確認");
    expect(pageGuide("connections", "ja").learn).toContain("影響範囲");
    expect(pageGuide("history", "ja").start).toContain("時間軸");
  });

  it("turns attention into a scoped review action without inventing a source", () => {
    const data = normalizeDashboardActivity({
      events: [{ id: "event-1", occurred_at: 1, task_id: "task-1", actor: {}, subject: { id: "task-1", type: "task" }, severity: "critical", status: "failed" }],
      attention: [{ id: "attention-1", kind: "task_failed", severity: "critical", subject_type: "task", subject_id: "task-1", reason: "Task failed" }]
    });
    const actions = activityRecommendedActions(data, new URLSearchParams({ tenant_id: "acme", lang: "ja" }), "/overview", "ja");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ tone: "critical", cta: "Taskを確認" });
    expect(actions[0].reason).toContain("Taskが失敗");
    expect(actions[0].evidence).toContain("Taskの失敗");
    expect(actions[0].href).toContain("/tasks/task-1");
    expect(actions[0].href).toContain("tenant_id=acme");
  });

  it("uses conservative, evidence-backed knowledge candidates", () => {
    const node = normalizeKnowledgeGraph({ nodes: [{ id: "m", source_id: "m", type: "memory", label: "Memory", confidence: 0.65, degree: 0, usage_count_30d: 0 }] }).nodes[0];
    const actions = knowledgeRecommendedActions(node, "/memories?selected=m", "ja");
    expect(actions.map((action) => action.evidence)).toEqual(["信頼度 65%", "接続数 0", "30日利用 0"]);
    expect(actions[0].cta).toBe("根拠を追加");
    expect(knowledgeMetricInterpretations(node, "ja").confidence).toContain("確認");
  });

  it("flags missing evidence, partial history, and unconfirmed state", () => {
    const data = normalizeStrataPayload({ generated_at: 200, chains: [{ id: "m", type: "canonical", source_type: "memory", source_id: "m", title: "Memory", changed_at: 100, current_state: "active", partial: true, source_count: 0 }] });
    const detail = normalizeStrataDetail({ chain: { ...data.chains[0], revisions: [{ id: "r1", recorded_at: 100, state: "active", snapshot: { lifecycle_state: "active" } }] }, truncated: {} });
    const actions = historyRecommendedActions(data, detail, "/memories?selected=m", "ja");
    expect(actions.map((action) => action.id)).toEqual(["m:sources", "m:partial", "m:unconfirmed"]);
  });

  it("uses honest empty-state briefings when no record is selected", () => {
    expect(knowledgeHealthyCopy("ja", false).title).toBe("確認できる知識がありません");
    expect(historyHealthyCopy("ja", false).title).toBe("確認できる履歴がありません");
  });
});
