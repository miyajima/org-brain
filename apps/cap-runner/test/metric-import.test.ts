import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateGithubMetric, githubQueryConfig, githubRuns, recoverExpiredMetricImports } from "../src/metric-import";
import type { Env } from "../src/types";

const runs = [
  {
    id: 1, name: "CI", status: "completed", conclusion: "success",
    created_at: "2026-08-30T00:00:00.000Z", run_started_at: "2026-08-30T00:00:10.000Z", updated_at: "2026-08-30T00:01:10.000Z"
  },
  {
    id: 2, name: "CI", status: "completed", conclusion: "failure",
    created_at: "2026-08-30T01:00:00.000Z", run_started_at: "2026-08-30T01:00:20.000Z", updated_at: "2026-08-30T01:02:20.000Z"
  },
  {
    id: 3, name: "Deploy production", status: "completed", conclusion: "success",
    created_at: "2026-08-30T02:00:00.000Z", run_started_at: "2026-08-30T02:00:05.000Z", updated_at: "2026-08-30T02:00:35.000Z"
  }
];

describe("GitHub Actions metric import", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calculates the five first-party templates", () => {
    expect(calculateGithubMetric("build_success_rate_v1", runs, {})).toBe(50);
    expect(calculateGithubMetric("build_duration_p95_v1", runs, {})).toBe(2);
    expect(calculateGithubMetric("queue_duration_p95_v1", runs, {})).toBeCloseTo(1 / 3, 5);
    expect(calculateGithubMetric("change_failure_rate_v1", runs, {})).toBe(0);
    expect(calculateGithubMetric("deployment_frequency_v1", runs, {}, 30)).toBeCloseTo(1 / 30, 5);
  });

  it("keeps an empty observation unknown instead of fabricating zero", () => {
    expect(calculateGithubMetric("build_success_rate_v1", [], {})).toBeNull();
    expect(calculateGithubMetric("build_duration_p95_v1", [], {})).toBeNull();
    expect(calculateGithubMetric("queue_duration_p95_v1", [], {})).toBeNull();
    expect(calculateGithubMetric("change_failure_rate_v1", [], {})).toBeNull();
    expect(calculateGithubMetric("deployment_frequency_v1", [], {})).toBeNull();
  });

  it("requires a dedicated deployment workflow", () => {
    const config = { tenant_id: "tenant-a", token: "test-token", owner: "example", repo: "org-brain" };
    expect(() => githubQueryConfig("deployment_frequency_v1", config)).toThrow("metric_deployment_workflow_required");
    expect(githubQueryConfig("deployment_frequency_v1", { ...config, deployment_workflow: "deploy.yml" }).workflow).toBe("deploy.yml");
  });

  it("fails closed instead of understating a window beyond the pagination ceiling", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: "CI",
      status: "completed",
      conclusion: "success",
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:01:00.000Z"
    }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ workflow_runs: page }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(githubRuns({
      tenant_id: "tenant-a", token: "test-token", owner: "example", repo: "org-brain", workflow: "ci.yml"
    }, Date.parse("2026-08-29T00:00:00.000Z"))).rejects.toThrow("github_pagination_limit_exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("requeues an expired running import with a compare-and-set recovery", async () => {
    const sent: unknown[] = [];
    const sql: string[] = [];
    const db = {
      prepare(statement: string) {
        sql.push(statement);
        return {
          bind() {
            return {
              all: async () => ({ results: statement.startsWith("SELECT") ? [{
                id: "run-1", tenant_id: "tenant-a", source_binding_id: "source-1", queued_at: 10, attempt: 1
              }] : [] }),
              run: async () => ({ success: true, meta: { changes: 1 } })
            };
          }
        };
      }
    };
    const result = await recoverExpiredMetricImports({
      OPEN_BRAIN_DB: db,
      METRIC_IMPORT_MODE: "on",
      METRIC_IMPORT_QUEUE: { send: async (job: unknown) => { sent.push(job); } }
    } as unknown as Env, 1_000);
    expect(result).toEqual({ recovered: 1, failed: 1, skipped: false });
    expect(sent).toEqual([expect.objectContaining({ run_id: "run-1", tenant_id: "tenant-a" })]);
    expect(sql.some((statement) => statement.includes("status='running' AND lease_expires_at <= ?"))).toBe(true);
  });
});
