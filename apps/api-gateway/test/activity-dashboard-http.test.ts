import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const getActivityDashboardMock = vi.hoisted(() => vi.fn());
const listTasksMock = vi.hoisted(() => vi.fn());
const createTaskMock = vi.hoisted(() => vi.fn());
const getTaskMock = vi.hoisted(() => vi.fn());
const getTaskEventsMock = vi.hoisted(() => vi.fn());
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

vi.mock("../src/activity-dashboard-service", () => ({
  getActivityDashboard: getActivityDashboardMock
}));

vi.mock("../src/task-service", () => ({
  createTask: createTaskMock,
  getTask: getTaskMock,
  getTaskEvents: getTaskEventsMock,
  listTasks: listTasksMock,
  replayFailedTask: vi.fn()
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

const dashboardResponse = {
  contract_version: "dashboard/v1" as const,
  events: [],
  observed_agents: [],
  attention: [],
  oldest_cursor: null,
  newest_cursor: null,
  has_more: false,
  generated_at: 1_000
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

async function fetchActivity(path: string, init?: RequestInit) {
  const { default: worker } = await import("../src/index");
  return worker.fetch(
    new Request(`https://api.example.test${path}`, {
      ...init,
      headers: {
        "x-api-key": "trusted-key",
        ...init?.headers
      }
    }),
    env,
    {} as ExecutionContext
  );
}

describe("GET /v1/dashboard/activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivityDashboardMock.mockResolvedValue(dashboardResponse);
  });

  it("returns the dashboard/v1 envelope and passes only the authenticated principal", async () => {
    const response = await fetchActivity(
      "/v1/dashboard/activity" +
      "?tenant_id=tenant-a&project_id=project-a&from=100&to=200&after=cursor-1&limit=25" +
      "&principal=agent%3Aspoofed"
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: dashboardResponse });
    expect(getActivityDashboardMock).toHaveBeenCalledTimes(1);
    expect(getActivityDashboardMock).toHaveBeenCalledWith(
      env,
      "tenant-a",
      {
        projectId: "project-a",
        from: 100,
        to: 200,
        before: undefined,
        after: "cursor-1",
        limit: 25,
        principal: "agent:trusted"
      }
    );
  });

  it("enforces API-key tenant grants before calling the dashboard service", async () => {
    const response = await fetchActivity("/v1/dashboard/activity?tenant_id=tenant-b");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "forbidden" }
    });
    expect(getActivityDashboardMock).not.toHaveBeenCalled();
  });

  it("returns a compact 400 error for invalid limits and windows", async () => {
    for (const query of [
      "tenant_id=tenant-a&limit=251",
      `tenant_id=tenant-a&from=0&to=${30 * 86_400_000 + 1}`
    ]) {
      const response = await fetchActivity(`/v1/dashboard/activity?${query}`);
      const body = await response.json<{ ok: boolean; error: Record<string, unknown> }>();
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ ok: false, error: { code: "invalid_query" } });
      expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
      expect(JSON.stringify(body)).not.toMatch(/ZodError|"issues"|"path"/u);
    }
    expect(getActivityDashboardMock).not.toHaveBeenCalled();
  });

  it("does not expose a body-based principal channel on the GET-only endpoint", async () => {
    const response = await fetchActivity("/v1/dashboard/activity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "tenant-a", principal: "agent:spoofed" })
    });

    expect(response.status).toBe(404);
    expect(getActivityDashboardMock).not.toHaveBeenCalled();
  });

  it("emits only bounded sampled dashboard telemetry", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const response = await fetchActivity("/v1/dashboard/activity?tenant_id=tenant-a", {
        headers: { "x-request-id": "sample-11" }
      });
      expect(response.status).toBe(200);
      expect(info).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(info.mock.calls[0][0])) as Record<string, unknown>;
      expect(payload).toMatchObject({
        event: "dashboard.view",
        view: "activity",
        count: 0,
        status: 200,
        truncated: false
      });
      expect(Object.keys(payload).sort()).toEqual([
        "count",
        "duration_ms",
        "event",
        "status",
        "truncated",
        "view"
      ]);
      expect(JSON.stringify(payload)).not.toMatch(/principal|query|tenant|body|content/ui);
    } finally {
      info.mockRestore();
    }
  });
});

describe("GET /v1/tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listTasksMock.mockResolvedValue([]);
  });

  it("enforces tenant access and forwards bounded task filters", async () => {
    const { default: worker } = await import("../src/index");
    const response = await worker.fetch(
      new Request("https://api.example.test/v1/tasks?tenant_id=tenant-a&status=failed&q=login&limit=21&offset=40", {
        headers: { "x-api-key": "trusted-key" }
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(listTasksMock).toHaveBeenCalledWith(env, "tenant-a", 21, "failed", "login", 40);
  });

  it("rejects a task query for a tenant outside the API-key grant", async () => {
    const { default: worker } = await import("../src/index");
    const response = await worker.fetch(
      new Request("https://api.example.test/v1/tasks?tenant_id=tenant-b", {
        headers: { "x-api-key": "trusted-key" }
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect(listTasksMock).not.toHaveBeenCalled();
  });

  it("applies the same tenant grant to task creation and detail reads", async () => {
    createTaskMock.mockResolvedValue({ task_id: "task-created" });
    getTaskMock.mockResolvedValue({ id: "task-a" });
    getTaskEventsMock.mockResolvedValue([]);
    const { default: worker } = await import("../src/index");

    const createAllowed = await worker.fetch(
      new Request("https://api.example.test/v1/tasks", {
        method: "POST",
        headers: { "x-api-key": "trusted-key", "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: "tenant-a", capability: "memory_measurement", input_ref: "spec://e2e" })
      }),
      env,
      {} as ExecutionContext
    );
    expect(createAllowed.status).toBe(201);
    expect(createTaskMock).toHaveBeenCalled();

    const createDenied = await worker.fetch(
      new Request("https://api.example.test/v1/tasks", {
        method: "POST",
        headers: { "x-api-key": "trusted-key", "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: "tenant-b", capability: "memory_measurement", input_ref: "spec://e2e" })
      }),
      env,
      {} as ExecutionContext
    );
    expect(createDenied.status).toBe(403);

    const detailDenied = await worker.fetch(
      new Request("https://api.example.test/v1/tasks/task-b?tenant_id=tenant-b", { headers: { "x-api-key": "trusted-key" } }),
      env,
      {} as ExecutionContext
    );
    expect(detailDenied.status).toBe(403);
    expect(getTaskMock).not.toHaveBeenCalled();

    const eventsDenied = await worker.fetch(
      new Request("https://api.example.test/v1/tasks/task-b/events?tenant_id=tenant-b", { headers: { "x-api-key": "trusted-key" } }),
      env,
      {} as ExecutionContext
    );
    expect(eventsDenied.status).toBe(403);
    expect(getTaskEventsMock).not.toHaveBeenCalled();
  });
});
