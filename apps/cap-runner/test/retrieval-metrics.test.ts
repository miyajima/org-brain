import { describe, expect, it } from "vitest";
import { pruneRetrievalEvents, rawRetentionCutoff, rollupRetrievalMetricsForDay } from "../src/retrieval-metrics";
import {
  computeRawRetrievalMetrics,
  countTopMemoryIds,
  mergeRetrievalMetrics,
  summarizeReplayComparisons
} from "../../../scripts/lib/retrieval-metrics-core.mjs";
import { resolveReplayInput } from "../../../scripts/lib/retrieval-replay-core.mjs";

class FakeStatement {
  db: FakeD1;
  sql: string;
  args: unknown[] = [];

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async all<T>() {
    if (this.sql.includes("FROM retrieval_events")) {
      return { results: this.db.retrievalRows as T[] };
    }

    if (this.sql.includes("FROM tasks") && this.sql.includes("WHERE id IN")) {
      const ids = new Set(this.args.map((value) => String(value)));
      return { results: this.db.tasks.filter((task) => ids.has(task.id)) as T[] };
    }

    return { results: [] as T[] };
  }

  async run() {
    this.db.statements.push({ sql: this.sql, args: this.args });
    return { success: true };
  }
}

class FakeD1 {
  retrievalRows: Array<Record<string, unknown>>;
  tasks: Array<{ id: string; status: string; created_at: number; updated_at: number }>;
  statements: Array<{ sql: string; args: unknown[] }> = [];

  constructor(
    retrievalRows: Array<Record<string, unknown>>,
    tasks: Array<{ id: string; status: string; created_at: number; updated_at: number }>
  ) {
    this.retrievalRows = retrievalRows;
    this.tasks = tasks;
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    for (const statement of statements) {
      await statement.run();
    }
    return [];
  }
}

describe("retrieval metrics helpers", () => {
  it("rolls up daily retrieval metrics idempotently", async () => {
    const db = new FakeD1(
      [
        {
          tenant_id: "default",
          capability: "plan_writer",
          search_strategy: "bm25_v1",
          task_id: "task1",
          matched_count: 2,
          returned_count: 2,
          fallback_used: 0,
          latency_ms: 10,
          created_at: 0
        },
        {
          tenant_id: "default",
          capability: "plan_writer",
          search_strategy: "bm25_v1",
          task_id: "task2",
          matched_count: 1,
          returned_count: 1,
          fallback_used: 0,
          latency_ms: 30,
          created_at: 0
        },
        {
          tenant_id: "default",
          capability: "code_review",
          search_strategy: "fallback_recent_v1",
          task_id: "task3",
          matched_count: 0,
          returned_count: 5,
          fallback_used: 1,
          latency_ms: 50,
          created_at: 0
        }
      ],
      [
        { id: "task1", status: "succeeded", created_at: 100, updated_at: 300 },
        { id: "task2", status: "failed", created_at: 200, updated_at: 500 },
        { id: "task3", status: "succeeded", created_at: 300, updated_at: 800 }
      ]
    );

    const first = await rollupRetrievalMetricsForDay(db as unknown as D1Database, "2026-03-10", 9999);
    const second = await rollupRetrievalMetricsForDay(db as unknown as D1Database, "2026-03-10", 9999);

    expect(first).toEqual({ day: "2026-03-10", rawEventCount: 3, groupCount: 2 });
    expect(second).toEqual(first);

    const bm25Insert = db.statements.find(
      (statement) =>
        statement.sql.startsWith("INSERT INTO retrieval_daily_metrics") &&
        statement.args[2] === "plan_writer" &&
        statement.args[3] === "bm25_v1"
    );
    expect(bm25Insert?.args[4]).toBe(2);
    expect(bm25Insert?.args[5]).toBe(2);
    expect(bm25Insert?.args[6]).toBe(1);
    expect(bm25Insert?.args[13]).toBe(250);
    expect(bm25Insert?.args[14]).toBe(1);
  });

  it("prunes raw retrieval events before the retention cutoff", async () => {
    const db = new FakeD1([], []);
    const cutoff = rawRetentionCutoff(Date.parse("2026-03-11T00:00:00.000Z"));

    await pruneRetrievalEvents(db as unknown as D1Database, cutoff);

    const deleteStatement = db.statements.find((statement) => statement.sql.startsWith("DELETE FROM retrieval_events"));
    expect(deleteStatement?.args[0]).toBe(cutoff);
  });

  it("builds report-friendly retrieval aggregates from raw and daily rows", () => {
    const rawMetrics = computeRawRetrievalMetrics(
      [
        {
          tenant_id: "default",
          capability: "plan_writer",
          search_strategy: "bm25_v1",
          task_id: "task1",
          matched_count: 2,
          returned_count: 2,
          fallback_used: 0,
          latency_ms: 10,
          top_memory_ids_json: JSON.stringify(["m1", "m2"])
        },
        {
          tenant_id: "default",
          capability: "plan_writer",
          search_strategy: "bm25_v1",
          task_id: "task2",
          matched_count: 0,
          returned_count: 1,
          fallback_used: 1,
          latency_ms: 20,
          top_memory_ids_json: JSON.stringify(["m2"])
        }
      ],
      new Map([
        ["task1", { id: "task1", status: "succeeded", created_at: 0, updated_at: 100 }],
        ["task2", { id: "task2", status: "failed", created_at: 0, updated_at: 200 }]
      ])
    );
    const merged = mergeRetrievalMetrics(rawMetrics, [
      {
        tenant_id: "default",
        capability: "plan_writer",
        search_strategy: "bm25_v1",
        search_count: 3,
        task_count: 3,
        hit_rate: 1,
        fallback_rate: 0,
        avg_matched_count: 3,
        avg_returned_count: 2,
        avg_latency_ms: 40,
        p95_latency_ms: 60,
        success_rate: 1,
        avg_task_duration_ms: 300,
        failed_task_count: 0
      }
    ]);

    expect(merged[0]).toMatchObject({
      search_count: 5,
      task_count: 5
    });
    expect(merged[0]?.p95_latency_ms).toBeNull();
    expect(countTopMemoryIds([
      { top_memory_ids_json: JSON.stringify(["m1", "m2"]) },
      { top_memory_ids_json: JSON.stringify(["m2"]) }
    ])).toEqual([
      { memory_id: "m2", count: 2 },
      { memory_id: "m1", count: 1 }
    ]);
  });

  it("resolves replay inputs across inline, memory, and r2 refs", async () => {
    const memoryCache = new Map<string, string>();
    const loads = {
      loadMemory: async (memoryId: string) => `memory:${memoryId}`,
      loadR2: async (key: string) => `r2:${key}`
    };

    const inline = await resolveReplayInput({ input_ref: "plain text" }, loads, memoryCache);
    const memory = await resolveReplayInput({ input_ref: "memory://mem-1" }, loads, memoryCache);
    const r2 = await resolveReplayInput({ input_ref: "r2://bucket/path.txt" }, loads, memoryCache);

    expect(inline).toEqual({ input: "plain text", input_source: "inline" });
    expect(memory).toEqual({ input: "memory:mem-1", input_source: "memory" });
    expect(r2).toEqual({ input: "r2:bucket/path.txt", input_source: "r2" });
  });

  it("summarizes replay comparisons across bm25, rewrite, and hybrid strategies", () => {
    const summary = summarizeReplayComparisons([
      {
        input_source: "inline",
        bm25_v1: { returned_count: 2, fallback_used: false, memory_ids: ["m1", "m2"] },
        bm25_rewrite_v1: { returned_count: 3, fallback_used: false, memory_ids: ["m1", "m2", "m3"] },
        hybrid_memory_docs_v1: { returned_count: 2, fallback_used: true, memory_ids: ["m1", "doc:1"] },
        overlap_vs_bm25: { bm25_rewrite_v1: 2, hybrid_memory_docs_v1: 1 },
        changed_vs_bm25: { bm25_rewrite_v1: true, hybrid_memory_docs_v1: true }
      },
      {
        input_source: "memory",
        bm25_v1: { returned_count: 1, fallback_used: true, memory_ids: [] },
        bm25_rewrite_v1: { returned_count: 1, fallback_used: false, memory_ids: ["m9"] },
        hybrid_memory_docs_v1: { returned_count: 1, fallback_used: false, memory_ids: ["doc:2"] },
        overlap_vs_bm25: { bm25_rewrite_v1: 0, hybrid_memory_docs_v1: 0 },
        changed_vs_bm25: { bm25_rewrite_v1: true, hybrid_memory_docs_v1: true }
      }
    ]);

    expect(summary.total_tasks).toBe(2);
    expect(summary.input_sources).toEqual({ inline: 1, memory: 1, r2: 0 });
    expect(summary.strategies.bm25_v1).toMatchObject({
      task_count: 2,
      fallback_rate: 0.5,
      average_returned_count: 1.5,
      changed_rate_vs_bm25: 0,
      average_overlap_at_5_vs_bm25: 1
    });
    expect(summary.strategies.bm25_rewrite_v1).toMatchObject({
      task_count: 2,
      fallback_rate: 0,
      changed_rate_vs_bm25: 1,
      average_overlap_at_5_vs_bm25: 1
    });
    expect(summary.strategies.hybrid_memory_docs_v1).toMatchObject({
      task_count: 2,
      fallback_rate: 0.5,
      changed_rate_vs_bm25: 1,
      average_overlap_at_5_vs_bm25: 0.5
    });
  });
});
