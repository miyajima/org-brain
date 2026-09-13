import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateGithubMetric, githubQueryConfig, githubRuns, processMetricImportJob, recoverExpiredMetricImports } from "../src/metric-import";
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

  it("preserves binding dimensions and enforces the preview tenant boundary in the Runner", async () => {
    let snapshotArguments: unknown[] | null = null;
    let disabledRunArguments: unknown[] | null = null;
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) { args = values; return statement; },
          async first() {
            if (sql.includes("FROM metric_source_bindings s")) return {
              id: "source-1", metric_definition_id: "metric-1", metric_binding_id: "binding-1",
              query_template: "build_success_rate_v1", connection_ref: "connection:github-actions:primary",
              external_scope_ref: null, definition_json: JSON.stringify({ freshness_seconds: 3600 }),
              dimensions_json: JSON.stringify({ branch: "main" })
            };
            return null;
          },
          async run() {
            if (sql.includes("INSERT INTO metric_snapshots")) snapshotArguments = args;
            if (sql.includes("error_code='metric_import_disabled'")) disabledRunArguments = args;
            return { success: true, meta: { changes: 1 } };
          }
        };
        return statement;
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) { return Promise.all(statements.map((statement) => statement.run())); }
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ workflow_runs: [{
      id: 1, name: "CI", status: "completed", conclusion: "success",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }] }), { status: 200 })));
    const runnerEnv = {
      OPEN_BRAIN_DB: db,
      METRIC_IMPORT_MODE: "preview",
      KNOWLEDGE_LOOP_PREVIEW_WRITE_TENANTS_JSON: JSON.stringify(["tenant-a"]),
      GITHUB_METRIC_CONNECTIONS_JSON: JSON.stringify({ primary: { tenant_id: "tenant-a", token: "test", owner: "example", repo: "org-brain" } })
    } as unknown as Env;
    const job = { contract_version: "metric-import-job/v1", run_id: "run-1", tenant_id: "tenant-a", source_binding_id: "source-1", requested_at: Date.now(), attempt: 0 };
    await processMetricImportJob(runnerEnv, job);
    expect(snapshotArguments?.[6]).toBe(JSON.stringify({ branch: "main" }));
    await processMetricImportJob(runnerEnv, { ...job, tenant_id: "tenant-b", run_id: "run-2" });
    expect(disabledRunArguments).toEqual([expect.any(Number), expect.any(Number), "tenant-b", "run-2"]);
  });
});
