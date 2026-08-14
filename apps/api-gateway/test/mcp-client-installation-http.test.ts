import { HttpError } from "@org-brain/shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const createMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
const revokeMock = vi.hoisted(() => vi.fn());
const assertPermissionMock = vi.hoisted(() => vi.fn());
const authorizePermissionMock = vi.hoisted(() => vi.fn());

vi.mock("../src/mcp", () => ({ mountMcp: vi.fn() }));
vi.mock("../src/mcp-client-installation-service", () => ({
  createMcpClientInstallation: createMock,
  listMcpClientInstallations: listMock,
  revokeMcpClientInstallation: revokeMock
}));
vi.mock("../src/audit-service", () => ({
  appendAuditEvent: vi.fn(async () => undefined),
  listAuditEvents: vi.fn(async () => []),
  parseAuditLimit: vi.fn(() => 100),
  verifyAuditChain: vi.fn(async () => ({ valid: true }))
}));
vi.mock("../src/rbac-service", () => ({
  assertPermission: assertPermissionMock,
  authorizePermission: authorizePermissionMock,
  deleteRoleAssignment: vi.fn(),
  listRoleAssignments: vi.fn(),
  upsertRoleAssignment: vi.fn()
}));
vi.mock("../src/rate-limit-service", () => ({
  assertRequestRateLimit: vi.fn(async () => undefined)
}));

const env = {
  API_TENANT_POLICY_JSON: JSON.stringify({
    keys: [{
      api_key: "trusted-key",
      principal: "user:alice",
      tenants: ["tenant-a"],
      role: "member"
    }]
  })
} as Env;

let worker: typeof import("../src/index").default;

beforeAll(async () => {
  ({ default: worker } = await import("../src/index"));
}, 15_000);

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-api-key", "trusted-key");
  if (init.body) headers.set("content-type", "application/json");
  return worker.fetch(
    new Request(`https://api.example.test${path}`, { ...init, headers }),
    env,
    {} as ExecutionContext
  );
}

describe("MCP client installation management HTTP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertPermissionMock.mockResolvedValue(undefined);
    authorizePermissionMock.mockResolvedValue({ allowed: false });
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue({
      installation: { id: "install-1", owner_principal: "user:alice", status: "pending" },
      enrollment_code: "obi_once",
      enrollment_expires_at: 123
    });
    revokeMock.mockImplementation(async (
      _env: Env,
      _tenantId: string,
      installationId: string,
      _principal: string,
      isAdmin: boolean
    ) => {
      if (installationId === "other-install" && !isAdmin) {
        throw new HttpError(403, "forbidden", "Only the owner or a tenant admin can revoke this installation");
      }
      return { id: installationId, status: "revoked" };
    });
  });

  it("lists only the authenticated principal by default and requires admin for tenant scope", async () => {
    expect((await request("/v1/mcp-client-installations?tenant_id=tenant-a")).status).toBe(200);
    expect(listMock).toHaveBeenLastCalledWith(env, "tenant-a", "user:alice");

    expect((await request("/v1/mcp-client-installations?tenant_id=tenant-a&scope=tenant")).status).toBe(200);
    expect(assertPermissionMock).toHaveBeenCalledWith(env, expect.objectContaining({
      tenantId: "tenant-a",
      principal: "user:alice",
      permission: "admin"
    }));
    expect(listMock).toHaveBeenLastCalledWith(env, "tenant-a", undefined);
  });

  it("binds create and revoke operations to the authenticated principal", async () => {
    const created = await request("/v1/mcp-client-installations", {
      method: "POST",
      body: JSON.stringify({ tenant_id: "tenant-a", client_type: "codex", device_label: "Work Mac" })
    });
    expect(created.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(
      env,
      "tenant-a",
      "user:alice",
      expect.objectContaining({ client_type: "codex" })
    );

    const revoked = await request("/v1/mcp-client-installations/install-1?tenant_id=tenant-a", {
      method: "DELETE"
    });
    expect(revoked.status).toBe(200);
    expect(revokeMock).toHaveBeenCalledWith(env, "tenant-a", "install-1", "user:alice", false);
  });

  it("rejects another user's revoke for a non-admin and permits a tenant admin", async () => {
    const denied = await request("/v1/mcp-client-installations/other-install?tenant_id=tenant-a", {
      method: "DELETE"
    });
    expect(denied.status).toBe(403);
    expect(revokeMock).toHaveBeenLastCalledWith(env, "tenant-a", "other-install", "user:alice", false);

    authorizePermissionMock.mockResolvedValueOnce({ allowed: true });
    const allowed = await request("/v1/mcp-client-installations/other-install?tenant_id=tenant-a", {
      method: "DELETE"
    });
    expect(allowed.status).toBe(200);
    expect(revokeMock).toHaveBeenLastCalledWith(env, "tenant-a", "other-install", "user:alice", true);
  });
});
