#!/usr/bin/env node

const baseUrl = (process.env.ORGBRAIN_SMOKE_URL || process.env.ORGBRAIN_API_URL || process.env.ORGBRAIN_API_BASE || "http://127.0.0.1:8797").replace(/\/+$/u, "");
const apiKey = process.env.ORGBRAIN_SMOKE_API_KEY || process.env.ORGBRAIN_API_KEY;
if (!apiKey) throw new Error("ORGBRAIN_SMOKE_API_KEY is required");
const tenantId = "default";
const projectId = `smoke-${Date.now()}`;

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
  return { status: response.status, body };
}

const capture = await request("/v1/memories/capture", {
  method: "POST",
  body: JSON.stringify({
    tenant_id: tenantId,
    source: "integration-smoke",
    items: [{
      external_key: "policy:smoke",
      project_id: projectId,
      kind: "constraint",
      content: "Deployment smoke policy requires approval before production release.",
      summary: "Production release approval policy",
      tags: ["curated-memory", "policy"],
      source_references: [{ type: "test", ref: "api-integration-smoke" }],
      confidence_score: 1,
      utility_score: 1
    }]
  })
});
if (capture.status !== 201) throw new Error(`capture failed: ${capture.status}`);
const memoryId = capture.body.data.items[0].memory_id;

const search = await request("/v1/memories/search", {
  method: "POST",
  body: JSON.stringify({
    tenant_id: tenantId,
    project_id: projectId,
    q: "production release approval",
    search_mode: "hybrid_v2",
    limit: 5
  })
});
const first = search.body.data?.results?.[0];
if (
  search.status !== 200 ||
  first?.id !== memoryId ||
  first?.score_breakdown?.semantic !== null ||
  search.body.data?.meta?.retrieval?.degraded !== true ||
  first?.source_references?.[0]?.ref !== "api-integration-smoke"
) {
  throw new Error("hybrid_v2 smoke assertions failed");
}

let hybridV3;
for (let attempt = 0; attempt < 20; attempt += 1) {
  hybridV3 = await request("/v1/memories/search", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: tenantId,
      project_id: projectId,
      q: "production release approval",
      search_mode: "hybrid_v3",
      limit: 5
    })
  });
  if (hybridV3.status === 200 && hybridV3.body.data?.results?.some((item) => item.id === memoryId)) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (
  hybridV3?.status !== 200 ||
  !hybridV3.body.data?.results?.some((item) => item.id === memoryId)
) {
  throw new Error(`hybrid_v3 smoke assertions failed: ${JSON.stringify({
    status: hybridV3?.status,
    hit: hybridV3?.body.data?.results?.some((item) => item.id === memoryId) ?? false,
    retrieval: hybridV3?.body.data?.meta?.retrieval ?? null
  })}`);
}

const issued = await request("/v1/scoped-tokens", {
  method: "POST",
  body: JSON.stringify({
    tenant_id: tenantId,
    principal: "service:smoke-reader",
    scopes: ["read"],
    expires_in_seconds: 300
  })
});
if (issued.status !== 201 || !issued.body.data?.token?.startsWith("obp_")) {
  throw new Error("scoped token issuance failed");
}
const token = issued.body.data.token;
const tokenRead = await fetch(`${baseUrl}/v1/memories/search`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ tenant_id: tenantId, q: "production release", limit: 1 })
});
const tokenWrite = await fetch(`${baseUrl}/v1/memories/capture`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({
    tenant_id: tenantId,
    source: "forbidden",
    items: [{ external_key: "forbidden", content: "must not write" }]
  })
});
const crossTenantRead = await fetch(`${baseUrl}/v1/memories/search`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ tenant_id: "smoke-forbidden-tenant", q: "production release", limit: 1 })
});
if (tokenRead.status !== 200 || tokenWrite.status !== 403 || crossTenantRead.status !== 403) {
  throw new Error(
    `scoped token enforcement failed: read=${tokenRead.status}, write=${tokenWrite.status}, cross_tenant=${crossTenantRead.status}`
  );
}

const unauthenticatedMcp = await fetch(`${baseUrl}/mcp`, { method: "POST" });
if (![401, 403].includes(unauthenticatedMcp.status)) {
  throw new Error(`unauthenticated MCP request was not rejected: ${unauthenticatedMcp.status}`);
}

const hold = await request("/v1/retention-policies", {
  method: "PUT",
  body: JSON.stringify({ tenant_id: tenantId, project_id: projectId, retention_days: 30, legal_hold: true })
});
if (hold.status !== 200) throw new Error("legal hold creation failed");
const heldDelete = await request(`/v1/memories/${memoryId}?tenant_id=${encodeURIComponent(tenantId)}`, {
  method: "DELETE"
});
if (heldDelete.status !== 409) throw new Error(`legal hold did not block delete: ${heldDelete.status}`);

await request("/v1/retention-policies", {
  method: "PUT",
  body: JSON.stringify({ tenant_id: tenantId, project_id: projectId, retention_days: 30, legal_hold: false })
});
const deleted = await request(`/v1/memories/${memoryId}?tenant_id=${encodeURIComponent(tenantId)}`, {
  method: "DELETE"
});
if (deleted.status !== 200) throw new Error(`delete failed: ${deleted.status}`);
const afterDelete = await request("/v1/memories/search", {
  method: "POST",
  body: JSON.stringify({ tenant_id: tenantId, q: "production release approval", search_mode: "hybrid_v2" })
});
if (afterDelete.body.data?.results?.some((item) => item.id === memoryId)) {
  throw new Error("deleted memory reappeared in retrieval");
}
const afterDeleteV3 = await request("/v1/memories/search", {
  method: "POST",
  body: JSON.stringify({
    tenant_id: tenantId,
    project_id: projectId,
    q: "production release approval",
    search_mode: "hybrid_v3"
  })
});
if (afterDeleteV3.body.data?.results?.some((item) => item.id === memoryId)) {
  throw new Error("deleted memory reappeared in hybrid_v3 retrieval");
}

const audit = await request(`/v1/audit-events/verify?tenant_id=${encodeURIComponent(tenantId)}`);
if (audit.status !== 200 || audit.body.data?.ok !== true) {
  throw new Error("audit chain verification failed");
}
const operations = await request(`/v1/ops/status?tenant_id=${encodeURIComponent(tenantId)}`);
if (
  operations.status !== 200 ||
  typeof operations.body.data?.memories?.total !== "number" ||
  operations.body.data?.retrieval?.lexical !== "d1-fts5" ||
  operations.body.data?.authorization?.roles?.length !== 6 ||
  !Array.isArray(operations.body.data?.scheduled_jobs) ||
  operations.body.data.scheduled_jobs.length !== 3 ||
  typeof operations.body.data?.retention_queue?.pending !== "number"
) {
  throw new Error("operations status smoke assertions failed");
}

process.stdout.write(`${JSON.stringify({
  passed: true,
  tenant_id: tenantId,
  project_id: projectId,
  capture_status: capture.status,
  hybrid_v2: {
    status: search.status,
    semantic_available: search.body.data.meta.retrieval.semantic.available,
    degraded: search.body.data.meta.retrieval.degraded,
    source_reference_present: true
  },
  hybrid_v3: {
    status: hybridV3.status,
    hit: true,
    retrieval: hybridV3.body.data.meta.retrieval
  },
  scoped_token: {
    read_status: tokenRead.status,
    denied_write_status: tokenWrite.status,
    denied_cross_tenant_read_status: crossTenantRead.status
  },
  unauthenticated_mcp_status: unauthenticatedMcp.status,
  legal_hold_delete_status: heldDelete.status,
  delete_status: deleted.status,
  delete_resurrection_count: afterDelete.body.data.results.filter((item) => item.id === memoryId).length,
  hybrid_v3_delete_resurrection_count:
    afterDeleteV3.body.data.results.filter((item) => item.id === memoryId).length,
  audit_chain: audit.body.data,
  operations_status: {
    status: operations.status,
    memories: operations.body.data.memories,
    tasks: operations.body.data.tasks,
    retrieval: operations.body.data.retrieval,
    scheduled_jobs: operations.body.data.scheduled_jobs,
    retention_queue: operations.body.data.retention_queue
  }
}, null, 2)}\n`);
