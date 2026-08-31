import { metricImportJobSchema, type MetricImportJobV1 } from "@org-brain/contracts";
import { sha256, ulid } from "@org-brain/shared";
import type { Env } from "./types";

export type GithubConnection = {
  tenant_id: string;
  token: string;
  owner: string;
  repo: string;
  workflow?: string;
  branch?: string;
  deployment_workflow?: string;
};

type GithubRun = {
  id: number;
  name?: string;
  conclusion?: string | null;
  status?: string;
  event?: string;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
};

type BindingRow = {
  id: string;
  metric_definition_id: string;
  metric_binding_id: string | null;
  query_template: string;
  connection_ref: string | null;
  external_scope_ref: string | null;
  definition_json: string;
};

function connection(env: Env, tenantId: string, reference: string | null): GithubConnection {
  if (!reference) throw new Error("metric_connection_missing");
  let parsed: unknown;
  try { parsed = JSON.parse(env.GITHUB_METRIC_CONNECTIONS_JSON ?? "{}"); } catch { throw new Error("metric_connections_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metric_connections_invalid");
  const key = reference in parsed ? reference : reference.replace(/^connection:github-actions:/u, "");
  const value = (parsed as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metric_connection_not_found");
  const item = value as Record<string, unknown>;
  if (item.tenant_id !== tenantId || ![item.token, item.owner, item.repo].every((field) => typeof field === "string" && field.trim())) {
    throw new Error("metric_connection_invalid");
  }
  return item as unknown as GithubConnection;
}

export async function githubRuns(config: GithubConnection, since: number, heartbeat?: () => Promise<void>): Promise<GithubRun[]> {
  const path = config.workflow
    ? `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/actions/workflows/${encodeURIComponent(config.workflow)}/runs`
    : `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/actions/runs`;
  const url = new URL(`https://api.github.com${path}`);
  url.searchParams.set("per_page", "100");
  if (config.branch) url.searchParams.set("branch", config.branch);
  url.searchParams.set("created", `>=${new Date(since).toISOString()}`);
  const runs: GithubRun[] = [];
  for (let page = 1; page <= 10; page += 1) {
    url.searchParams.set("page", String(page));
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${config.token}`,
        "user-agent": "orgbrain-metric-import/1",
        "x-github-api-version": "2022-11-28"
      },
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 429 || response.status >= 500) throw new Error(`retryable:github_http_${response.status}`);
    if (!response.ok) throw new Error(`github_http_${response.status}`);
    const payload = await response.json() as { workflow_runs?: GithubRun[] };
    const pageRuns = payload.workflow_runs ?? [];
    runs.push(...pageRuns);
    if (heartbeat) await heartbeat();
    if (pageRuns.length < 100) break;
    if (page === 10) throw new Error("github_pagination_limit_exceeded");
  }
  return [...new Map(runs.filter((run) => Date.parse(run.created_at) >= since).map((run) => [run.id, run])).values()];
}

function percentile(values: number[], value: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((value / 100) * sorted.length) - 1))]!;
}

export function calculateGithubMetric(
  template: string,
  runs: GithubRun[],
  config: Pick<GithubConnection, "deployment_workflow">,
  windowDays = 7
): number | null {
  if (runs.length === 0) return null;
  const completed = runs.filter((run) => run.status === "completed" || run.conclusion);
  const deploymentName = (config.deployment_workflow ?? "deploy").toLowerCase();
  const isDeployment = (run: GithubRun) => (run.name ?? "").toLowerCase().includes(deploymentName);
  const deployments = completed.filter(isDeployment);
  const builds = completed.filter((run) => !isDeployment(run));
  if (template === "build_success_rate_v1") {
    if (!builds.length) return null;
    return (builds.filter((run) => run.conclusion === "success").length / builds.length) * 100;
  }
  if (template === "build_duration_p95_v1") {
    return percentile(builds.flatMap((run) => {
      const start = Date.parse(run.run_started_at ?? run.created_at);
      const end = Date.parse(run.updated_at);
      return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [(end - start) / 60_000] : [];
    }), 95);
  }
  if (template === "queue_duration_p95_v1") {
    return percentile(runs.filter((run) => !isDeployment(run)).flatMap((run) => {
      const created = Date.parse(run.created_at);
      const started = Date.parse(run.run_started_at ?? "");
      return Number.isFinite(created) && Number.isFinite(started) && started >= created ? [(started - created) / 60_000] : [];
    }), 95);
  }
  if (template === "change_failure_rate_v1") {
    if (!deployments.length) return null;
    return (deployments.filter((run) => run.conclusion === "failure").length / deployments.length) * 100;
  }
  if (template === "deployment_frequency_v1") {
    if (!deployments.length) return null;
    return deployments.filter((run) => run.conclusion === "success").length / Math.max(1, windowDays);
  }
  throw new Error("metric_query_template_unsupported");
}

export function isMetricImportJob(raw: unknown): raw is MetricImportJobV1 {
  return metricImportJobSchema.safeParse(raw).success;
}

export function githubQueryConfig(template: string, config: GithubConnection): GithubConnection {
  const deploymentMetric = template === "change_failure_rate_v1" || template === "deployment_frequency_v1";
  if (deploymentMetric && !config.deployment_workflow) throw new Error("metric_deployment_workflow_required");
  return deploymentMetric ? { ...config, workflow: config.deployment_workflow } : config;
}

export async function queueMetricImportRetry(env: Env, raw: unknown): Promise<void> {
  const job = metricImportJobSchema.parse(raw);
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE metric_source_import_runs SET status='queued', started_at=NULL, lease_expires_at=NULL, completed_at=NULL, updated_at=?
     WHERE tenant_id=? AND id=? AND status='failed' AND attempt < 3`
  ).bind(Date.now(), job.tenant_id, job.run_id).run();
}

export async function recoverExpiredMetricImports(env: Env, now = Date.now()) {
  if (env.METRIC_IMPORT_MODE !== "on" || !env.METRIC_IMPORT_QUEUE) return { recovered: 0, skipped: true };
  const exhausted = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE metric_source_import_runs SET status='failed', error_code='metric_import_attempts_exhausted',
     error_message='The import worker lease expired after the final attempt', lease_expires_at=NULL,
     completed_at=?, updated_at=? WHERE status='running' AND lease_expires_at <= ? AND attempt >= 3`
  ).bind(now, now, now).run();
  const expired = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, source_binding_id, queued_at, attempt
     FROM metric_source_import_runs
     WHERE status='running' AND lease_expires_at <= ? AND attempt < 3
     ORDER BY lease_expires_at, id LIMIT 100`
  ).bind(now).all<{ id: string; tenant_id: string; source_binding_id: string; queued_at: number; attempt: number }>();
  let recovered = 0;
  for (const run of expired.results) {
    const claim = await env.OPEN_BRAIN_DB.prepare(
      `UPDATE metric_source_import_runs SET status='queued', started_at=NULL, lease_expires_at=NULL, updated_at=?
       WHERE tenant_id=? AND id=? AND status='running' AND lease_expires_at <= ?`
    ).bind(now, run.tenant_id, run.id, now).run();
    if (!claim.meta.changes) continue;
    const job = metricImportJobSchema.parse({
      contract_version: "metric-import-job/v1",
      run_id: run.id,
      tenant_id: run.tenant_id,
      source_binding_id: run.source_binding_id,
      requested_at: run.queued_at,
      attempt: Math.min(run.attempt, 3)
    });
    try {
      await env.METRIC_IMPORT_QUEUE.send(job, { contentType: "json" });
      recovered += 1;
    } catch (error) {
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE metric_source_import_runs SET status='failed', error_code='recovery_queue_failed', error_message=?, completed_at=?, updated_at=?
         WHERE tenant_id=? AND id=? AND status='queued'`
      ).bind(String(error).slice(0, 1_000), now, now, run.tenant_id, run.id).run();
      throw error;
    }
  }
  return { recovered, failed: Number(exhausted.meta.changes ?? 0), skipped: false };
}

export async function processMetricImportJob(env: Env, raw: unknown): Promise<void> {
  if (env.METRIC_IMPORT_MODE !== "on") throw new Error("metric_import_disabled");
  const job = metricImportJobSchema.parse(raw);
  const now = Date.now();
  const leaseExpiresAt = now + 120_000;
  const claimed = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE metric_source_import_runs SET status='running', attempt=attempt+1, started_at=?, lease_expires_at=?, updated_at=?
     WHERE tenant_id=? AND id=? AND attempt < 3
       AND (status IN ('queued','failed') OR (status='running' AND lease_expires_at <= ?))`
  ).bind(now, leaseExpiresAt, now, job.tenant_id, job.run_id, now).run();
  if (!claimed.meta.changes) {
    const existing = await env.OPEN_BRAIN_DB.prepare(
      "SELECT status FROM metric_source_import_runs WHERE tenant_id=? AND id=?"
    ).bind(job.tenant_id, job.run_id).first<{ status: string }>();
    if (existing?.status === "succeeded") return;
    throw new Error("retryable:metric_import_run_leased");
  }
  try {
    const binding = await env.OPEN_BRAIN_DB.prepare(
      `SELECT s.id, s.metric_definition_id, s.metric_binding_id, s.query_template, s.connection_ref,
              s.external_scope_ref, v.definition_json
       FROM metric_source_bindings s
       JOIN metric_definitions d ON d.id=s.metric_definition_id AND d.tenant_id=s.tenant_id
       JOIN metric_definition_versions v ON v.metric_definition_id=d.id AND v.version=d.current_version
       WHERE s.tenant_id=? AND s.id=? AND s.adapter_id='github-actions'`
    ).bind(job.tenant_id, job.source_binding_id).first<BindingRow>();
    if (!binding) throw new Error("metric_source_binding_not_found");
    const definition = JSON.parse(binding.definition_json) as { aggregation_window?: string; freshness_seconds?: number };
    const days = definition.aggregation_window === "P30D" ? 30 : 7;
    const config = connection(env, job.tenant_id, binding.connection_ref);
    const deploymentMetric = binding.query_template === "change_failure_rate_v1" || binding.query_template === "deployment_frequency_v1";
    const queryConfig = githubQueryConfig(binding.query_template, config);
    const runs = await githubRuns(queryConfig, now - days * 86_400_000, async () => {
      const heartbeatAt = Date.now();
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE metric_source_import_runs SET lease_expires_at=?, updated_at=?
         WHERE tenant_id=? AND id=? AND status='running'`
      ).bind(heartbeatAt + 120_000, heartbeatAt, job.tenant_id, job.run_id).run();
    });
    const value = calculateGithubMetric(
      binding.query_template,
      runs,
      deploymentMetric && config.deployment_workflow ? { deployment_workflow: "" } : config,
      days
    );
    const state = value === null ? "unknown" : "measured";
    const snapshotId = ulid();
    const queryDigest = await sha256(JSON.stringify({
      adapter_id: "github-actions", query_template: binding.query_template,
      owner: config.owner, repo: config.repo, workflow: queryConfig.workflow ?? null,
      branch: config.branch ?? null, window_days: days
    }));
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO metric_snapshots(
         id, tenant_id, metric_definition_id, binding_id, value, state, dimensions_json,
         observed_at, expires_at, evidence_ref, query_digest, source_binding_id,
         idempotency_key, recorded_by, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(snapshotId, job.tenant_id, binding.metric_definition_id, binding.metric_binding_id,
      value, state, "{}", now, now + Math.max(1, definition.freshness_seconds ?? 86_400) * 1_000,
      `github-actions://${config.owner}/${config.repo}`, queryDigest, binding.id, job.run_id,
      "system:metric-import", now).run();
    await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE metric_source_import_runs SET status='succeeded', snapshot_id=?, error_code=NULL,
         error_message=NULL, lease_expires_at=NULL, completed_at=?, updated_at=? WHERE tenant_id=? AND id=?`
      ).bind(snapshotId, now, now, job.tenant_id, job.run_id),
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE metric_source_bindings SET status='active', last_attempt_at=?, last_success_at=?,
         last_error_code=NULL, updated_at=? WHERE tenant_id=? AND id=?`
      ).bind(now, now, now, job.tenant_id, binding.id)
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE metric_source_import_runs SET status='failed', error_code=?, error_message=?, lease_expires_at=NULL, completed_at=?, updated_at=?
         WHERE tenant_id=? AND id=?`
      ).bind(message.split(":")[0]!.slice(0, 128), message.slice(0, 1_000), Date.now(), Date.now(), job.tenant_id, job.run_id),
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE metric_source_bindings SET status='error', last_attempt_at=?, last_error_code=?, updated_at=?
         WHERE tenant_id=? AND id=?`
      ).bind(Date.now(), message.split(":")[0]!.slice(0, 128), Date.now(), job.tenant_id, job.source_binding_id)
    ]);
    throw error;
  }
}
