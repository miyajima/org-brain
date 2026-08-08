const ACTIVITY_FORBIDDEN_KEYS = new Set([
  "body",
  "content",
  "input_refs",
  "message_body",
  "payload",
  "query",
  "snapshot_json",
  "task_payload"
]);
const ALWAYS_FORBIDDEN_KEYS = new Set(["snapshot_json"]);

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertRedacted(value, forbiddenKeys, path = "data") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertRedacted(child, forbiddenKeys, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new Error(`Dashboard response exposed forbidden field ${path}.${key}`);
    assertRedacted(child, forbiddenKeys, `${path}.${key}`);
  }
}

async function requestDashboard(fetchImpl, apiUrl, apiKey, pathname, params, forbiddenKeys = ALWAYS_FORBIDDEN_KEYS) {
  const url = new URL(pathname.replace(/^\//u, ""), `${apiUrl.replace(/\/$/u, "")}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "x-api-key": apiKey
    }
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true || !body.data) {
    throw new Error(`${pathname} smoke failed with HTTP ${response.status}`);
  }
  if (body.data.contract_version !== "dashboard/v1") {
    throw new Error(`${pathname} returned an unexpected dashboard contract`);
  }
  assertRedacted(body.data, forbiddenKeys);
  return body.data;
}

export async function runDashboardLiveSmoke({ env = process.env, fetchImpl = fetch } = {}) {
  const apiUrl = env.ORGBRAIN_API_URL?.trim() || env.ORGBRAIN_API_BASE?.trim();
  if (!apiUrl) throw new Error("ORGBRAIN_API_URL is required (ORGBRAIN_API_BASE is a compatibility alias)");
  const apiKey = required(env, "ORGBRAIN_API_KEY");
  const tenantId = required(env, "ORGBRAIN_TENANT_ID");
  const projectId = env.ORGBRAIN_PROJECT_ID?.trim() || "";
  const scope = { tenant_id: tenantId, project_id: projectId };

  const activity = await requestDashboard(
    fetchImpl,
    apiUrl,
    apiKey,
    "/v1/dashboard/activity",
    { ...scope, limit: "1" },
    ACTIVITY_FORBIDDEN_KEYS
  );
  const graph = await requestDashboard(fetchImpl, apiUrl, apiKey, "/v1/dashboard/knowledge-graph", {
    ...scope,
    node_limit: "1",
    edge_limit: "1"
  });
  const strata = await requestDashboard(fetchImpl, apiUrl, apiKey, "/v1/dashboard/strata", { ...scope, limit: "1" });
  const firstChain = Array.isArray(strata.chains) ? strata.chains[0] : null;
  let detail = null;
  if (firstChain?.source_type && firstChain?.source_id) {
    detail = await requestDashboard(
      fetchImpl,
      apiUrl,
      apiKey,
      `/v1/dashboard/strata/${encodeURIComponent(firstChain.source_type)}/${encodeURIComponent(firstChain.source_id)}`,
      scope
    );
  }

  return {
    activity_events: Array.isArray(activity.events) ? activity.events.length : 0,
    graph_nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
    strata_chains: Array.isArray(strata.chains) ? strata.chains.length : 0,
    strata_detail_checked: Boolean(detail)
  };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  runDashboardLiveSmoke()
    .then((summary) => console.log(JSON.stringify({ ok: true, dashboard_live_smoke: summary })))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
