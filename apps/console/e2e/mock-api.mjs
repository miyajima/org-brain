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
        email: body.email ?? null,
        company_name: body.company_name ?? null,
        organization_name: body.organization_name ?? null,
        avatar_url: body.avatar_url ?? null
      }
    }));
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
