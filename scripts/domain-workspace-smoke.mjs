#!/usr/bin/env node

const baseUrl = (process.env.ORGBRAIN_SMOKE_URL || process.env.ORGBRAIN_API_URL || process.env.ORGBRAIN_API_BASE || "http://127.0.0.1:8797").replace(/\/+$/u, "");
const apiKey = process.env.ORGBRAIN_SMOKE_API_KEY || process.env.ORGBRAIN_API_KEY;
if (!apiKey) throw new Error("ORGBRAIN_SMOKE_API_KEY is required");

const tenantId = "default";
const packIds = [
  "function.build-engineering",
  "function.sre",
  "function.sales",
  "function.pdm-b2c-marketplace"
];

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (response.status >= 400) throw new Error(`${options.method ?? "GET"} ${path} failed: ${response.status} ${JSON.stringify(body)}`);
  return { status: response.status, data: body.data };
}

const catalog = await request(`/v1/domain-packs?tenant_id=${tenantId}`);
if (!Array.isArray(catalog.data) || !packIds.every((packId) => catalog.data.some((item) => item.manifest?.pack_id === packId))) {
  throw new Error("first-party Domain Pack catalog is incomplete");
}

const plan = await request("/v1/domain-packs/installations/plan", {
  method: "POST",
  body: JSON.stringify({ tenant_id: tenantId, pack_ids: packIds })
});
if (plan.data?.examples_loaded !== false || typeof plan.data?.plan_digest !== "string") {
  throw new Error("Domain Pack plan must exclude story fixtures and include a digest");
}

const installation = await request("/v1/domain-packs/installations", {
  method: "POST",
  body: JSON.stringify({ tenant_id: tenantId, pack_ids: packIds, plan_digest: plan.data.plan_digest })
});
if (installation.status !== 201 || installation.data?.installations?.length !== 4) {
  throw new Error("four Domain Packs were not installed together");
}

const workspaces = [];
for (const packId of packIds) {
  const workspace = await request(`/v1/domain-packs/${encodeURIComponent(packId)}/workspace?tenant_id=${tenantId}`);
  const metrics = workspace.data?.metric_groups?.flatMap((group) => group.metrics) ?? [];
  if (workspace.data?.pack?.pack_id !== packId || metrics.length === 0) {
    throw new Error(`Workspace is incomplete: ${packId}`);
  }
  if (metrics.some((metric) => typeof metric.current?.value === "number")) {
    throw new Error(`normal install leaked synthetic metric values: ${packId}`);
  }
  if ((workspace.data?.managed_objects ?? []).length !== 0) {
    throw new Error(`normal install leaked story managed objects: ${packId}`);
  }
  if (!(workspace.data?.source_readiness ?? []).some((source) => source.status === "unconfigured")) {
    throw new Error(`Connector placeholder is missing: ${packId}`);
  }
  workspaces.push({ pack_id: packId, metric_count: metrics.length, source_binding_count: workspace.data.source_readiness.length });
}

const sourceBindings = await request(`/v1/metric-source-bindings?tenant_id=${tenantId}&status=unconfigured`);
if (!Array.isArray(sourceBindings.data) || sourceBindings.data.length === 0 || sourceBindings.data.some((source) => source.connection_ref !== null)) {
  throw new Error("unconfigured source bindings must exist without connection secrets");
}

const snapshots = await request(`/v1/metric-snapshots/query?tenant_id=${tenantId}`);
if (!Array.isArray(snapshots.data) || snapshots.data.length !== 0) {
  throw new Error("normal install must not create metric snapshots");
}

process.stdout.write(`${JSON.stringify({
  passed: true,
  tenant_id: tenantId,
  packs: workspaces,
  unconfigured_source_bindings: sourceBindings.data.length,
  installed_snapshot_count: snapshots.data.length,
  examples_loaded: plan.data.examples_loaded
}, null, 2)}\n`);
