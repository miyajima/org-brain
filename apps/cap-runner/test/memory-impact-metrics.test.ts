import { describe, expect, it } from "vitest";
import {
  previousMemoryImpactUtcDay,
  rebuildMemoryImpactExecutionMetricsForDay,
  rebuildMemoryImpactMetricsForDay
} from "../src/memory-impact-metrics";

describe("memory impact daily rollup", () => {
  it("rebuilds a UTC day from latest raw effects without prompt text", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          sql,
          args: [] as unknown[],
          bind(...args: unknown[]) { this.args = args; return this; },
          async run() { return { success: true }; }
        };
        statements.push(statement);
        return statement;
      },
      async batch(batch: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(batch.map((statement) => statement.run()));
      }
    } as unknown as D1Database;
    const day = previousMemoryImpactUtcDay(Date.parse("2026-08-05T12:00:00.000Z"));
    expect(day).toBe("2026-08-04");
    await rebuildMemoryImpactMetricsForDay(db, day, Date.parse("2026-08-05T12:00:00.000Z"));
    expect(statements).toHaveLength(2);
    expect(statements[1].sql).toContain("latest_effect");
    expect(statements[1].sql).toContain("estimator_absolute_error_sum");
    expect(statements[1].sql).not.toMatch(/prompt|command_text|query_text/);
    expect(statements[1].args).toHaveLength(6);
  });

  it("rebuilds run-level daily metrics from eligible and terminal events", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          sql,
          args: [] as unknown[],
          bind(...args: unknown[]) { this.args = args; return this; },
          async run() { return { success: true }; }
        };
        statements.push(statement);
        return statement;
      },
      async batch(batch: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(batch.map((statement) => statement.run()));
      }
    } as unknown as D1Database;
    await rebuildMemoryImpactExecutionMetricsForDay(db, "2026-08-04", Date.parse("2026-08-05T12:00:00.000Z"));
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("memory_impact_daily_metrics");
    expect(statements[1].sql).toContain("memory_impact_events");
    expect(statements[1].sql).toContain("avoided_lookup_rate");
    expect(statements[1].args).toHaveLength(5);
  });
});
