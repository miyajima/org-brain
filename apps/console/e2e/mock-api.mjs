import http from "node:http";

const args = new Map(
  process.argv.slice(2).flatMap((arg, index, all) => (arg.startsWith("--") ? [[arg.slice(2), all[index + 1]]] : []))
);
const port = Number(args.get("port") ?? process.env.CONSOLE_E2E_API_PORT ?? 19087);
const now = Date.UTC(2026, 5, 12, 9, 0, 0);

const memory = {
  id: "mem_auth_group_acl",
  project_id: "org-brain",
  content: "Login principals and group ACLs decide who can read shared organization memory.",
  summary: "Login principal group ACL design",
  tags: ["auth", "groups", "canonical-memory"],
  source: "e2e",
  external_key: "e2e-login-memory",
  created_at: now,
  kind: "semantic",
  lifecycle_state: "active",
  current_version: 3,
  last_accessed_at: now,
  confidence_score: 0.93,
  utility_score: 0.88
};

const profileItem = {
  id: memory.id,
  project_id: memory.project_id,
  summary: memory.summary,
  content_preview: memory.content,
  source: memory.source,
  created_at: memory.created_at,
  tags: memory.tags,
  memory_kind: memory.kind,
  lifecycle_state: memory.lifecycle_state,
  current_version: memory.current_version,
  last_accessed_at: memory.last_accessed_at,
  confidence_score: memory.confidence_score,
  utility_score: memory.utility_score
};

const dashboardActivity = {
  contract_version: "dashboard/v1",
  events: [
    {
      id: "usage:evt-1",
      type: "memory.read",
      occurred_at: now - 18 * 60_000,
      project_id: "org-brain",
      task_id: "task-e2e",
      trace_id: "trace-e2e",
      actor: { id: "agent:codex", label: "Codex", kind: "agent" },
      subject: { type: "memory", id: memory.id, label: memory.summary },
      target: { type: "task", id: "task-e2e", label: "Dashboard implementation" },
      severity: "info",
      status: "used",
      summary: "Codex read Login principal group ACL design",
      metadata: { access_path: "context", request_source: "api", model: "gpt-5" }
    },
    {
      id: "task:evt-2",
      type: "task.failed",
      occurred_at: now - 9 * 60_000,
      project_id: "org-brain",
      task_id: "task-failed",
      trace_id: "trace-failed",
      actor: { id: "system:cap-runner", label: "Capability runner", kind: "system" },
      subject: { type: "task", id: "task-failed", label: "Index parity check" },
      target: null,
      severity: "critical",
      status: "failed",
      summary: "Task failed: Index parity check",
      metadata: { capability: "memory_measurement", event_kind: "failed" }
    }
  ],
  observed_agents: [
    { id: "agent:codex", label: "Codex", model: "gpt-5", state: "active", last_seen_at: now - 18 * 60_000, active_task_count: 1, read_count: 4, write_count: 2, failure_count: 0 },
    { id: "agent:ops", label: "Ops Agent", model: null, state: "active", last_seen_at: now - 2 * 60 * 60_000, active_task_count: 0, read_count: 2, write_count: 1, failure_count: 1 }
  ],
  attention: [
    { id: "task_failed:task-failed", kind: "task_failed", severity: "critical", detected_at: now - 9 * 60_000, subject_type: "task", subject_id: "task-failed", reason: "A task failed and needs review" }
  ],
  oldest_cursor: "eyJ2IjoxLCJhdCI6MSwia2V5Ijoib2xkIn0",
  newest_cursor: "eyJ2IjoxLCJhdCI6Miwia2V5IjoibmV3In0",
  has_more: false,
  generated_at: now
};

const dashboardGraph = {
  contract_version: "dashboard/v1",
  nodes: [
    { id: `memory:${memory.id}`, source_id: memory.id, type: "memory", kind: "semantic", label: memory.summary, summary: memory.content, project_id: "org-brain", status: "active", confidence: 0.93, updated_at: now, last_used_at: now - 18 * 60_000, usage_count_30d: 12, degree: 3, cluster_ids: ["cluster:project:org-brain", "cluster:memory_kind:semantic"], deep_link: `/memories?selected=${memory.id}` },
    { id: "decision:decision-e2e", source_id: "decision-e2e", type: "decision", kind: "architecture", label: "Use authenticated principals for shared memory", summary: "Access decisions are evaluated before projection.", project_id: "org-brain", status: "active", confidence: 0.9, updated_at: now - 2 * 86_400_000, last_used_at: null, usage_count_30d: 3, degree: 2, cluster_ids: ["cluster:project:org-brain", "cluster:domain:architecture"], deep_link: "/decisions?id=decision-e2e" },
    { id: "entity:group-acl", source_id: "group-acl", type: "entity", kind: "concept", label: "Group ACL", summary: null, project_id: null, status: null, confidence: 0.88, updated_at: now - 3 * 86_400_000, last_used_at: null, usage_count_30d: 0, degree: 2, cluster_ids: [], deep_link: "/memories?entity_id=group-acl" },
    { id: "project:org-brain", source_id: "org-brain", type: "project", kind: "project", label: "org-brain", summary: "Synthetic project scope", project_id: "org-brain", status: "active", confidence: null, updated_at: now, last_used_at: null, usage_count_30d: 0, degree: 2, cluster_ids: ["cluster:project:org-brain"] }
  ],
  edges: [
    { id: "edge:decision-memory", source: "decision:decision-e2e", target: `memory:${memory.id}`, relation: "derived_from", directed: true, inferred: false, weight: 1, confidence: 0.9 },
    { id: "edge:memory-entity", source: `memory:${memory.id}`, target: "entity:group-acl", relation: "mentions", directed: true, inferred: false, weight: 1, confidence: 0.88 },
    { id: "edge:memory-project", source: `memory:${memory.id}`, target: "project:org-brain", relation: "belongs_to", directed: true, inferred: false, weight: 1, confidence: null },
    { id: "edge:decision-project", source: "decision:decision-e2e", target: "project:org-brain", relation: "belongs_to", directed: true, inferred: false, weight: 1, confidence: null }
  ],
  clusters: [
    { id: "cluster:project:org-brain", kind: "project", label: "org-brain", node_ids: [`memory:${memory.id}`, "decision:decision-e2e", "project:org-brain"] },
    { id: "cluster:memory_kind:semantic", kind: "memory_kind", label: "semantic", node_ids: [`memory:${memory.id}`] },
    { id: "cluster:domain:architecture", kind: "domain", label: "architecture", node_ids: ["decision:decision-e2e"] }
  ],
  truncated: false,
  omitted_node_count: 0
};

const strataSummary = {
  id: "decision:decision-e2e",
  type: "decision",
  source_type: "decision_memory",
  source_id: "decision-e2e",
  title: "Use authenticated principals for shared memory",
  project_id: "org-brain",
  current_state: "active",
  confidence: 0.9,
  valid_from: now - 30 * 86_400_000,
  valid_until: null,
  changed_at: now - 2 * 86_400_000,
  partial: false,
  revision_count: 3,
  source_count: 2,
  attention: []
};

const canonicalStrataSummary = {
  ...strataSummary,
  id: `memory:${memory.id}`,
  type: "canonical",
  source_type: "memory",
  source_id: memory.id,
  title: memory.summary,
  current_state: "promoted",
  confidence: 0.93,
  changed_at: now,
  revision_count: 3
};

const dashboardStrata = {
  contract_version: "dashboard/v1",
  chains: [
    canonicalStrataSummary,
    strataSummary
  ],
  oldest_cursor: "eyJ2IjoxLCJhdCI6MSwia2V5Ijoic3RyYXRhIn0",
  has_more: false,
  generated_at: now,
  truncated: false
};

const dashboardStrataDetail = {
  contract_version: "dashboard/v1",
  chain: {
    ...strataSummary,
    revisions: [
      { id: "decision-version-1", operation: "create", recorded_at: now - 30 * 86_400_000, valid_from: now - 30 * 86_400_000, valid_until: null, actor_id: "user:e2e-login-sub", state: "proposed", summary: "Initial access decision", partial: false, snapshot: { status: "proposed", confirmation_state: "inferred_unconfirmed" } },
      { id: "decision-version-2", operation: "confirm", recorded_at: now - 2 * 86_400_000, valid_from: now - 30 * 86_400_000, valid_until: null, actor_id: "user:e2e-login-sub", state: "active", summary: "Confirmed after ACL review", partial: false, snapshot: { status: "active", confirmation_state: "user_confirmed" } }
    ],
    relations: [{ relation: "derived_from", target_type: "memory", target_id: memory.id, valid_from: now - 30 * 86_400_000, valid_until: null }],
    sources: [{ resource_id: "resource-e2e", resource_version_id: "resource-version-e2e", title: "ACL design note", relation: "conclusion_source", captured_at: now - 31 * 86_400_000, locator: { heading: "Access model" }, unresolved: false }]
  },
  truncated: { revisions: false, sources: false }
};

const dashboardCanonicalStrataDetail = {
  contract_version: "dashboard/v1",
  chain: {
    ...canonicalStrataSummary,
    revisions: [
      { id: "memory-version-1", operation: "capture", recorded_at: now - 30 * 86_400_000, valid_from: now - 30 * 86_400_000, valid_until: null, actor_id: "agent:codex", state: "active", summary: "Captured ACL guidance", partial: false, snapshot: { lifecycle_state: "active", kind: "semantic" } },
      { id: "memory-version-2", operation: "promote", recorded_at: now, valid_from: now - 30 * 86_400_000, valid_until: null, actor_id: "user:e2e-login-sub", state: "promoted", summary: memory.summary, partial: false, snapshot: { lifecycle_state: "promoted", kind: "semantic" } }
    ],
    relations: [{ relation: "supports", target_type: "decision_memory", target_id: "decision-e2e", valid_from: now - 30 * 86_400_000, valid_until: null }],
    sources: [{ resource_id: "resource-e2e", resource_version_id: "resource-version-e2e", title: "ACL design note", relation: "source_ref", captured_at: now - 31 * 86_400_000, locator: { heading: "Access model" }, unresolved: false }]
  },
  truncated: { revisions: false, sources: false }
};

const denseActivity = {
  ...dashboardActivity,
  events: Array.from({ length: 250 }, (_, index) => ({
    ...dashboardActivity.events[index % dashboardActivity.events.length],
    id: `dense-event-${index}`,
    occurred_at: now - index * 1_000,
    summary: `Dense activity ${index + 1}`
  })),
  observed_agents: Array.from({ length: 24 }, (_, index) => ({
    ...dashboardActivity.observed_agents[index % dashboardActivity.observed_agents.length],
    id: `agent:dense-${index}`,
    label: `Dense Agent ${index + 1}`,
    last_seen_at: now - index * 1_000
  })),
  has_more: true
};

const denseGraphNodes = Array.from({ length: 150 }, (_, index) => ({
  ...dashboardGraph.nodes[index % dashboardGraph.nodes.length],
  id: `memory:dense-${index}`,
  source_id: `dense-${index}`,
  type: index % 11 === 0 ? "decision" : "memory",
  kind: index % 13 === 0 ? "pitfall" : index % 7 === 0 ? "lesson" : "semantic",
  label: `Dense knowledge ${index + 1}`,
  deep_link: `/memories?selected=dense-${index}`,
  degree: index === 0 ? 149 : 1,
  cluster_ids: ["cluster:project:org-brain"]
}));
const denseGraph = {
  ...dashboardGraph,
  nodes: denseGraphNodes,
  edges: Array.from({ length: 149 }, (_, index) => ({
    id: `dense-edge-${index}`,
    source: "memory:dense-0",
    target: `memory:dense-${index + 1}`,
    relation: "recorded_link",
    directed: true,
    inferred: false,
    weight: 1,
    confidence: 0.8
  })),
  clusters: [{ id: "cluster:project:org-brain", kind: "project", label: "org-brain", node_ids: denseGraphNodes.map((node) => node.id) }],
  truncated: true,
  omitted_node_count: 37
};

const denseStrata = {
  ...dashboardStrata,
  chains: Array.from({ length: 100 }, (_, index) => ({
    ...strataSummary,
    id: index === 0 ? strataSummary.id : `memory:dense-${index}`,
    type: index === 0 ? "decision" : index % 9 === 0 ? "assumption" : index % 5 === 0 ? "learning" : "canonical",
    source_type: index === 0 ? "decision_memory" : "memory",
    source_id: index === 0 ? strataSummary.source_id : `dense-${index}`,
    title: index === 0 ? strataSummary.title : `Dense lineage ${index + 1}`,
    changed_at: now - index * 60_000
  })),
  has_more: true,
  truncated: true
};

const decisionMemory = {
  id: "decision-e2e",
  tenantId: "default",
  projectId: "org-brain",
  domain: "architecture",
  title: "Use authenticated principals for shared memory",
  decision: "Only authenticated principals may read restricted organization memory.",
  rationale: "ACL checks must run before dashboard projections are assembled.",
  constraints: ["Do not accept actor identity from request payloads."],
  knownPitfalls: ["Historical rows may have no actor attribution."],
  sourceRefs: [{ type: "resource", id: "resource-e2e", title: "ACL design note" }],
  ownerRefs: [{ type: "user", id: "user:e2e-login-sub", name: "E2E Login User" }],
  reviewerRefs: [{ type: "user", id: "user:e2e-login-sub", name: "E2E Login User" }],
  validFrom: now - 30 * 86_400_000,
  validUntil: null,
  status: "active",
  supersededBy: null,
  confidence: 0.9,
  visibility: "tenant",
  confirmationState: "user_confirmed",
  confirmationNote: "Reviewed in E2E",
  confirmedAt: now - 2 * 86_400_000,
  createdAt: now - 30 * 86_400_000,
  updatedAt: now - 2 * 86_400_000,
  trustSignals: {
    confidence: 0.9,
    confirmationState: "user_confirmed",
    humanConfirmed: true,
    sourceAuthority: 0.9,
    sourceCount: 1,
    ownerCount: 1,
    reviewerCount: 1,
    freshness: "fresh",
    conflictCount: 0,
    visibility: "tenant",
    permissionFilteredSourceCount: 0
  }
};

const decisionContext = {
  decisionMemory,
  whyTrustThis: {
    trustSignals: decisionMemory.trustSignals,
    provenance: {
      decidedBy: decisionMemory.ownerRefs,
      reviewedBy: decisionMemory.reviewerRefs,
      sourceRefs: decisionMemory.sourceRefs,
      createdAt: decisionMemory.createdAt,
      updatedAt: decisionMemory.updatedAt,
      confirmedAt: decisionMemory.confirmedAt,
      confirmationNote: decisionMemory.confirmationNote,
      applicableContext: {
        domain: decisionMemory.domain,
        projectId: decisionMemory.projectId,
        validFrom: decisionMemory.validFrom,
        validUntil: decisionMemory.validUntil,
        status: decisionMemory.status,
        constraints: decisionMemory.constraints,
        knownPitfalls: decisionMemory.knownPitfalls
      }
    },
    conflicts: [],
    versions: [
      {
        id: "decision-version-2",
        operation: "confirm",
        snapshot: {
          title: decisionMemory.title,
          decision: decisionMemory.decision,
          rationale: decisionMemory.rationale,
          confirmationState: "user_confirmed",
          status: "active",
          validFrom: decisionMemory.validFrom,
          validUntil: decisionMemory.validUntil,
          supersededBy: null
        },
        actorRefs: decisionMemory.ownerRefs,
        reviewerRefs: decisionMemory.reviewerRefs,
        note: "Reviewed in E2E",
        createdAt: decisionMemory.updatedAt
      },
      {
        id: "decision-version-1",
        operation: "create",
        snapshot: {
          title: decisionMemory.title,
          decision: decisionMemory.decision,
          rationale: decisionMemory.rationale,
          confirmationState: "inferred_unconfirmed",
          status: "uncertain",
          validFrom: decisionMemory.validFrom,
          validUntil: decisionMemory.validUntil,
          supersededBy: null
        },
        actorRefs: decisionMemory.ownerRefs,
        reviewerRefs: [],
        note: "Created from the initial proposal",
        createdAt: decisionMemory.createdAt
      }
    ]
  },
  related: []
};

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function ok(data) {
  return { ok: true, data };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (path === "/health") {
    json(response, 200, { ok: true });
    return;
  }

  if (path === "/v1/dashboard/activity" && request.method === "GET") {
    const state = url.searchParams.get("project_id");
    if (state === "e2e-error") {
      json(response, 503, { ok: false, error: { code: "dashboard_unavailable", message: "Dashboard fixture unavailable" } });
      return;
    }
    if (state === "e2e-empty") {
      json(response, 200, ok({
        ...dashboardActivity,
        events: [],
        observed_agents: [],
        attention: [],
        oldest_cursor: null,
        newest_cursor: null
      }));
      return;
    }
    if (url.searchParams.has("after")) {
      json(response, 200, ok({
        ...dashboardActivity,
        events: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more: false,
        generated_at: Date.now()
      }));
      return;
    }
    if (state === "e2e-sparse") {
      json(response, 200, ok({
        ...dashboardActivity,
        events: dashboardActivity.events.slice(0, 1),
        observed_agents: dashboardActivity.observed_agents.slice(0, 1),
        attention: []
      }));
      return;
    }
    if (state === "e2e-dense") {
      json(response, 200, ok(denseActivity));
      return;
    }
    json(response, 200, ok(dashboardActivity));
    return;
  }

  if (path === "/v1/dashboard/knowledge-graph" && request.method === "GET") {
    const state = url.searchParams.get("project_id");
    if (state === "e2e-empty") {
      json(response, 200, ok({ ...dashboardGraph, nodes: [], edges: [], clusters: [] }));
      return;
    }
    if (state === "e2e-sparse") {
      json(response, 200, ok({ ...dashboardGraph, nodes: dashboardGraph.nodes.slice(0, 1), edges: [], clusters: [] }));
      return;
    }
    if (state === "e2e-dense") {
      json(response, 200, ok(denseGraph));
      return;
    }
    json(response, 200, ok(state === "e2e-truncated"
      ? { ...dashboardGraph, truncated: true, omitted_node_count: 42 }
      : dashboardGraph));
    return;
  }

  if (path === "/v1/dashboard/strata" && request.method === "GET") {
    const state = url.searchParams.get("project_id");
    if (state === "e2e-empty") {
      json(response, 200, ok({ ...dashboardStrata, chains: [], oldest_cursor: null }));
      return;
    }
    if (state === "e2e-sparse") {
      json(response, 200, ok({ ...dashboardStrata, chains: dashboardStrata.chains.slice(0, 1) }));
      return;
    }
    if (state === "e2e-dense") {
      json(response, 200, ok(denseStrata));
      return;
    }
    json(response, 200, ok(state === "e2e-truncated"
      ? { ...dashboardStrata, has_more: true, truncated: true }
      : dashboardStrata));
    return;
  }

  if (path.startsWith("/v1/dashboard/strata/") && request.method === "GET") {
    const state = url.searchParams.get("project_id");
    if (state === "e2e-partial-error") {
      json(response, 503, { ok: false, error: { code: "detail_unavailable", message: "Strata detail fixture unavailable" } });
      return;
    }
    const detail = path.includes("/strata/memory/")
      ? dashboardCanonicalStrataDetail
      : dashboardStrataDetail;
    json(response, 200, ok(state === "e2e-truncated"
      ? { ...detail, truncated: { revisions: true, sources: true } }
      : detail));
    return;
  }

  if (path === "/v1/decision-memories/search" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 200, ok({
      tenant_id: body.tenant_id ?? "default",
      project_id: body.project_id ?? null,
      q: body.q ?? "",
      results: [decisionMemory]
    }));
    return;
  }

  if (path === `/v1/decision-memories/${decisionMemory.id}/context` && request.method === "GET") {
    json(response, 200, ok(decisionContext));
    return;
  }

  if (
    (path === `/v1/decision-memories/${decisionMemory.id}/revise` ||
      path === `/v1/decision-memories/${decisionMemory.id}/confirm`) &&
    request.method === "POST"
  ) {
    await readJson(request);
    json(response, 200, ok({ decisionMemory }));
    return;
  }

  if (path === "/v1/auth/me" && request.method === "GET") {
    json(response, 200, ok({
      tenant_id: url.searchParams.get("tenant_id") || "default",
      auth: {
        principal: "user:e2e-login-sub",
        source: "access-jwt",
        allowed_tenants: ["default"],
        email: "e2e@example.com",
        display_name: "E2E Login User"
      },
      profile: {
        display_name: "E2E Login User",
        full_name: "E2E Full Name",
        email: "e2e@example.com",
        company_name: "Example Holdings",
        organization_name: "Platform Lab",
        avatar_url: "https://example.com/avatar.png"
      },
      groups: []
    }));
    return;
  }

  if (path === "/v1/auth/me/profile" && request.method === "PUT") {
    const body = await readJson(request);
    json(response, 200, ok({
      tenant_id: body.tenant_id ?? "default",
      profile: {
        display_name: body.display_name ?? null,
        full_name: body.full_name ?? null,
        email: body.email ?? null,
        company_name: body.company_name ?? null,
        organization_name: body.organization_name ?? null,
        avatar_url: body.avatar_url ?? null
      }
    }));
    return;
  }

  if (path === "/v1/organization" && request.method === "GET") {
    json(response, 200, ok({ tenant_id: "default", slug: "default", display_name: "E2E Organization", allowed_email_domains: ["example.com"], email_self_registration_enabled: true }));
    return;
  }
  if (path === "/v1/organization" && request.method === "PATCH") {
    json(response, 200, ok(await readJson(request)));
    return;
  }
  if (path === "/v1/users" && request.method === "GET") {
    json(response, 200, ok({ users: [{ principal: "user:e2e-login-sub", display_name: "E2E Login User", full_name: "E2E Full Name", email: "e2e@example.com", status: "active", provision_source: "legacy", full_name_source: "legacy", role: "tenant_admin" }] }));
    return;
  }
  if (path === "/v1/users" && request.method === "POST") {
    json(response, 201, ok({ ...(await readJson(request)), principal: "user:invited", status: "invited" }));
    return;
  }
  if (path.startsWith("/v1/users/") && request.method === "PATCH") {
    json(response, 200, ok(await readJson(request)));
    return;
  }
  if (path === "/v1/directory" && request.method === "GET") {
    json(response, 200, ok({ users: [{ principal: "user:e2e-login-sub", display_name: "E2E Login User", avatar_url: null, status: "active" }] }));
    return;
  }
  if (path === "/v1/groups" && request.method === "GET") {
    json(response, 200, ok({ tenant_id: "default", groups: [{ id: "group-e2e", slug: "reviewers", name: "Reviewers", description: "Local review group", source: "local", role: "owner", updated_at: now }] }));
    return;
  }
  if (path === "/v1/groups" && request.method === "POST") {
    json(response, 201, ok({ group: { ...(await readJson(request)), id: "group-created", source: "local" } }));
    return;
  }
  if (path === "/v1/groups/group-e2e" && request.method === "GET") {
    json(response, 200, ok({ group: { id: "group-e2e", slug: "reviewers", name: "Reviewers", description: "Local review group", source: "local", role: "owner" }, members: [{ principal: "user:e2e-login-sub", role: "owner", source: "local" }] }));
    return;
  }
  if (path.startsWith("/v1/groups/group-e2e") && ["POST", "PATCH", "DELETE"].includes(request.method)) {
    json(response, 200, ok({ updated: true }));
    return;
  }
  if (path === "/v1/business-categories" && request.method === "GET") {
    json(response, 200, ok([{ id: "category-e2e", tenant_id: "default", slug: "engineering", label: "Engineering", description: "Build work", is_active: true, created_at: now, updated_at: now }]));
    return;
  }
  if ((path === "/v1/business-categories" && request.method === "POST") || (path.startsWith("/v1/business-categories/") && request.method === "PATCH")) {
    json(response, request.method === "POST" ? 201 : 200, ok(await readJson(request)));
    return;
  }

  if (path === "/v1/memories" && request.method === "GET") {
    json(response, 200, ok({
      tenant_id: url.searchParams.get("tenant_id") || "default",
      project_id: url.searchParams.get("project_id") || null,
      source: null,
      items: [memory],
      meta: {
        limit: 20,
        offset: 0,
        total: 1,
        has_next: false,
        has_prev: false,
        canonical_count: 1,
        digest_count: 0,
        compacted_count: 0
      }
    }));
    return;
  }

  if (path === "/v1/memories/profile" && request.method === "POST") {
    json(response, 200, ok({
      tenant_id: "default",
      project_id: "org-brain",
      durable: [profileItem],
      recent: [profileItem],
      search_results: [profileItem],
      meta: {
        durable_count: 1,
        recent_count: 1
      }
    }));
    return;
  }

  if (path === "/v1/memories/search" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 200, ok({
      tenant_id: body.tenant_id ?? "default",
      project_id: body.project_id ?? null,
      q: body.q ?? "",
      rewrite_query: Boolean(body.rewrite_query),
      search_mode: body.search_mode ?? "hybrid",
      include_history: Boolean(body.include_history),
      results: [{
        kind: "memory",
        id: memory.id,
        summary: memory.summary,
        content_preview: memory.content,
        score: 0.987,
        source: memory.source,
        created_at: memory.created_at,
        memory_kind: memory.kind,
        lifecycle_state: memory.lifecycle_state,
        current_version: memory.current_version
      }],
      meta: {
        search_strategy: "mock-hybrid",
        matched_count: 1,
        returned_count: 1,
        fallback_used: false,
        variant_count: 1
      }
    }));
    return;
  }

  if (path === `/v1/memories/${memory.id}/details` && request.method === "GET") {
    json(response, 200, ok({
      tenant_id: url.searchParams.get("tenant_id") || "default",
      memory_id: memory.id,
      versions: [{
        version: 3,
        operation: "upsert",
        summary: memory.summary,
        kind: memory.kind,
        lifecycle_state: memory.lifecycle_state,
        actor_type: "principal",
        actor_id: "user:e2e-login-sub",
        created_at: now
      }],
      rationales: [{
        id: "rat_e2e",
        decision_type: "policy",
        conclusion: "Use login principal for shared memory access.",
        reason_summary: "The UI should show provenance and management actions for authenticated memory owners.",
        status: "accepted",
        confirmation_state: "user_confirmed",
        confidence_score: 0.9,
        created_at: now,
        confirmed_at: now,
        evidence: []
      }]
    }));
    return;
  }

  if (path === "/v1/memories/refresh" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 200, ok({ memory_id: body.memory_id, refreshed: true }));
    return;
  }

  if (path === "/v1/memories/suppress" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 200, ok({ memory_id: body.memory_id, suppressed: true }));
    return;
  }

  json(response, 404, { ok: false, error: { code: "not_found", message: `${request.method} ${path}` } });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock api listening on http://127.0.0.1:${port}`);
});
