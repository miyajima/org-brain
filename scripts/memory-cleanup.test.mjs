import { describe, expect, it } from "vitest";
import {
  buildDeleteStatements,
  buildPromotionStatements,
  classifyMemoryCleanupRows,
  summarizeCleanupPlan
} from "./memory-cleanup.mjs";

describe("memory cleanup planning", () => {
  const rows = [
    {
      id: "fact-1",
      tenant_id: "default",
      project_id: "org-brain",
      summary: "org-brain | project-fact | production D1 is source of truth",
      content: "# Project Fact\n\n## Result\nproduction D1 is source of truth",
      tags_json: JSON.stringify(["openclaw", "hook", "learning-loop", "project-fact", "org-brain"]),
      source: "openclaw",
      created_at: 1,
      current_version: 1
    },
    {
      id: "route-only",
      tenant_id: "default",
      project_id: "tetori",
      summary: "tetori | agent-turn-complete | route=inline/current-agent",
      content: "route=inline/current-agent",
      tags_json: JSON.stringify(["codex", "hook", "agent-turn-complete", "tetori"]),
      source: "codex",
      created_at: 2,
      current_version: 1
    },
    {
      id: "diagnosis-1",
      tenant_id: "default",
      project_id: "org-brain",
      summary: "org-brain | promoted-memory | 原因は OAuth 未完了でした。",
      content: "原因は OAuth 未完了でした。対処として `wrangler login` を実行し、成功を確認しました。",
      tags_json: JSON.stringify(["codex", "hook", "promoted", "diagnosis", "org-brain"]),
      source: "codex",
      created_at: 3,
      current_version: 1
    }
  ];

  it("classifies rows into delete, promote, and keep buckets without mutating input rows", () => {
    const before = JSON.stringify(rows);
    const plan = classifyMemoryCleanupRows(rows, { keepProjectFacts: true });
    expect(plan.deleteRows.map((item) => item.row.id)).toEqual(["route-only"]);
    expect(plan.promoteRows.map((item) => item.row.id)).toEqual(["fact-1"]);
    expect(plan.keepRows.map((item) => item.row.id)).toEqual(["diagnosis-1"]);
    expect(JSON.stringify(rows)).toBe(before);

    const summary = summarizeCleanupPlan({ inspectedCount: rows.length, ...plan });
    expect(summary).toMatchObject({ inspected_count: 3, delete_count: 1, promote_count: 1, keep_count: 1 });
  });

  it("builds delete SQL for every memory-related table while leaving retrieval events intact", () => {
    const plan = classifyMemoryCleanupRows(rows, { keepProjectFacts: true });
    const sql = buildDeleteStatements("default", plan.deleteRows).join("\n");
    expect(sql).toContain("DELETE FROM decision_evidence");
    expect(sql).toContain("DELETE FROM decision_rationales");
    expect(sql).toContain("DELETE FROM memory_entities");
    expect(sql).toContain("DELETE FROM memory_edges");
    expect(sql).toContain("DELETE FROM memory_versions");
    expect(sql).toContain("DELETE FROM memories_fts");
    expect(sql).toContain("DELETE FROM memories");
    expect(sql).not.toContain("retrieval_events");
  });

  it("builds promotion SQL that makes project facts semantic curated memories", () => {
    const plan = classifyMemoryCleanupRows(rows, { keepProjectFacts: true });
    const sql = buildPromotionStatements("default", plan.promoteRows[0], 1234).join("\n");
    expect(sql).toContain("curated-memory");
    expect(sql).toContain("kind = 'semantic'");
    expect(sql).toContain("INSERT INTO memories_fts");
    expect(sql).toContain("'promote'");
    expect(sql).toContain("memory-cleanup");
  });
});
