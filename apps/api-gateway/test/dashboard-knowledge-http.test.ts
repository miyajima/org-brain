import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const getKnowledgeGraphMock = vi.hoisted(() => vi.fn());
const getMemoryStrataMock = vi.hoisted(() => vi.fn());
const getMemoryStrataDetailMock = vi.hoisted(() => vi.fn());
const authenticateScopedTokenMock = vi.hoisted(() => vi.fn());
const appendAuditEventMock = vi.hoisted(() => vi.fn(async () => undefined));
const assertPermissionMock = vi.hoisted(() => vi.fn(async () => undefined));
const assertRequestRateLimitMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("agents/mcp", () => {
  class MockMcpAgent {
    static serve() {
      return { fetch: () => new Response("mcp") };
    }
  }
  return { McpAgent: MockMcpAgent };
});

vi.mock("../src/knowledge-graph-service", () => ({
  getKnowledgeGraph: getKnowledgeGraphMock
}));

vi.mock("../src/memory-strata-service", () => ({
  getMemoryStrata: getMemoryStrataMock,
  getMemoryStrataDetail: getMemoryStrataDetailMock
}));

vi.mock("../src/token-service", () => ({
  authenticateScopedToken: authenticateScopedTokenMock,
  issueScopedToken: vi.fn(),
  listScopedTokens: vi.fn(),
  revokeScopedToken: vi.fn()
}));

vi.mock("../src/audit-service", () => ({
  appendAuditEvent: appendAuditEventMock,
  listAuditEvents: vi.fn(async () => []),
  parseAuditLimit: vi.fn(() => 100),
  verifyAuditChain: vi.fn(async () => ({ valid: true }))
}));

vi.mock("../src/rbac-service", () => ({
  assertPermission: assertPermissionMock,
  deleteRoleAssignment: vi.fn(),
  listRoleAssignments: vi.fn(),
  upsertRoleAssignment: vi.fn()
}));

vi.mock("../src/rate-limit-service", () => ({
  assertRequestRateLimit: assertRequestRateLimitMock
}));

const graphResponse = {
  contract_version: "dashboard/v1" as const,
  nodes: [],
  edges: [],
  clusters: [],
  generated_at: 1_000,
  truncated: false,
  omitted_node_count: 0
};

const strataResponse = {
  contract_version: "dashboard/v1" as const,
  chains: [],
  oldest_cursor: null,
  has_more: false,
  generated_at: 1_000,
  truncated: false
};

const detailResponse = {
  contract_version: "dashboard/v1" as const,
  chain: {
    id: "strata:memory:memory-one",
    type: "learning" as const,
    source_type: "memory" as const,
    source_id: "memory-one",
    title: "Memory one",
    project_id: "project-a",
    current_state: "active",
    confidence: 0.8,
    valid_from: null,
    valid_until: null,
    changed_at: 900,
    partial: false,
    revision_count: 1,
    source_count: 0,
    attention: [],
    revisions: [],
    relations: [],
    sources: []
  },
  truncated: { revisions: false, sources: false }
};

const env = {
  API_TENANT_POLICY_JSON: JSON.stringify({
    keys: [{
      api_key: "trusted-key",
      principal: "agent:trusted",
      tenants: ["tenant-a"],
      role: "service_agent"
    }]
  })
} as Env;

async function fetchDashboard(path: string) {
  const { default: worker } = await import("../src/index");
  return worker.fetch(
    new Request(`https://api.example.test${path}`, { headers: { "x-api-key": "trusted-key" } }),
    env,
    {} as ExecutionContext
  );
}

async function fetchDashboardWithScopedToken(path: string) {
  const { default: worker } = await import("../src/index");
  return worker.fetch(
    new Request(`https://api.example.test${path}`, {
      headers: { authorization: "Bearer obp_dashboard_reader" }
    }),
    env,
    {} as ExecutionContext
  );
}

describe("dashboard knowledge HTTP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getKnowledgeGraphMock.mockResolvedValue(graphResponse);
    getMemoryStrataMock.mockResolvedValue(strataResponse);
    getMemoryStrataDetailMock.mockResolvedValue(detailResponse);
    authenticateScopedTokenMock.mockResolvedValue(null);
  });

  it("returns envelopes and forwards only the authenticated principal", async () => {
    const graph = await fetchDashboard(
      "/v1/dashboard/knowledge-graph?tenant_id=tenant-a&project_id=project-a&q=auth" +
      "&focus_type=memory&focus_id=memory-one&depth=2&node_limit=25&edge_limit=50" +
      "&principal=agent%3Aspoofed"
    );
    expect(graph.status).toBe(200);
    await expect(graph.json()).resolves.toEqual({ ok: true, data: graphResponse });
    expect(getKnowledgeGraphMock).toHaveBeenCalledWith(env, "tenant-a", {
      project_id: "project-a",
      q: "auth",
      focus_type: "memory",
      focus_id: "memory-one",
      depth: 2,
      node_limit: 25,
      edge_limit: 50,
      principal: "agent:trusted"
    });

    const strata = await fetchDashboard(
      "/v1/dashboard/strata?tenant_id=tenant-a&project_id=project-a" +
      "&types=canonical,assumption&from=100&to=200&before=cursor-one&limit=12" +
      "&principal=agent%3Aspoofed"
    );
    expect(strata.status).toBe(200);
    await expect(strata.json()).resolves.toEqual({ ok: true, data: strataResponse });
    expect(getMemoryStrataMock).toHaveBeenCalledWith(env, "tenant-a", {
      project_id: "project-a",
      types: ["canonical", "assumption"],
      from: 100,
      to: 200,
      before: "cursor-one",
      limit: 12,
      principal: "agent:trusted"
    });

    const detail = await fetchDashboard(
      "/v1/dashboard/strata/memory/memory-one?tenant_id=tenant-a&project_id=project-a" +
      "&principal=agent%3Aspoofed"
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toEqual({ ok: true, data: detailResponse });
    expect(getMemoryStrataDetailMock).toHaveBeenCalledWith(
      env,
      "tenant-a",
      "memory",
      "memory-one",
      {
        project_id: "project-a",
        principal: "agent:trusted"
      }
    );
  });

  it("enforces API tenant grants before invoking dashboard services", async () => {
    for (const path of [
      "/v1/dashboard/knowledge-graph?tenant_id=tenant-b",
      "/v1/dashboard/strata?tenant_id=tenant-b",
      "/v1/dashboard/strata/memory/memory-one?tenant_id=tenant-b"
    ]) {
      const response = await fetchDashboard(path);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "forbidden" }
      });
    }
    expect(getKnowledgeGraphMock).not.toHaveBeenCalled();
    expect(getMemoryStrataMock).not.toHaveBeenCalled();
    expect(getMemoryStrataDetailMock).not.toHaveBeenCalled();
  });

  it("honors scoped-token read and project restrictions", async () => {
    authenticateScopedTokenMock.mockResolvedValue({
      id: "token-dashboard-reader",
      tenant_id: "tenant-a",
      principal: "agent:scoped-reader",
      scopes: ["read"],
      project_id: "project-a",
      expires_at: Date.now() + 60_000,
      revoked_at: null,
      rotated_from_id: null,
      created_by_principal: "user:admin",
      created_at: Date.now(),
      last_used_at: null
    });

    const allowed = await fetchDashboardWithScopedToken(
      "/v1/dashboard/knowledge-graph?tenant_id=tenant-a&project_id=project-a"
    );
    expect(allowed.status).toBe(200);
    expect(getKnowledgeGraphMock).toHaveBeenCalledWith(
      env,
      "tenant-a",
      expect.objectContaining({
        project_id: "project-a",
        principal: "agent:scoped-reader"
      })
    );

    getKnowledgeGraphMock.mockClear();
    const denied = await fetchDashboardWithScopedToken(
      "/v1/dashboard/knowledge-graph?tenant_id=tenant-a&project_id=project-b"
    );
    expect(denied.status).toBe(403);
    expect(getKnowledgeGraphMock).not.toHaveBeenCalled();
  });

  it("returns compact errors for invalid queries and source types", async () => {
    const cases = [
      ["/v1/dashboard/knowledge-graph?tenant_id=tenant-a&focus_type=memory", "invalid_query"],
      ["/v1/dashboard/strata?tenant_id=tenant-a&limit=101", "invalid_query"],
      ["/v1/dashboard/strata/unknown/source-one?tenant_id=tenant-a", "invalid_source_type"],
      ["/v1/dashboard/strata/memory/source-one?tenant_id=tenant-a&project_id=", "invalid_query"]
    ] as const;
    for (const [path, code] of cases) {
      const response = await fetchDashboard(path);
      const body = await response.json<{ ok: boolean; error: Record<string, unknown> }>();
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ ok: false, error: { code } });
      expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
      expect(JSON.stringify(body)).not.toMatch(/ZodError|"issues"|"path"/u);
    }
    expect(getKnowledgeGraphMock).not.toHaveBeenCalled();
    expect(getMemoryStrataMock).not.toHaveBeenCalled();
    expect(getMemoryStrataDetailMock).not.toHaveBeenCalled();
  });
});
