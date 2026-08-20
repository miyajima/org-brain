import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/types";

const verifyAssertionMock = vi.hoisted(() => vi.fn());
const serviceSubjectMock = vi.hoisted(() => vi.fn());
const authorizeMcpRequestMock = vi.hoisted(() => vi.fn());
const activateMock = vi.hoisted(() => vi.fn());
const appendAuditEventMock = vi.hoisted(() => vi.fn());

vi.mock("agents/mcp/server", () => ({
  createMcpHandler: () => async () => new Response("mcp", { status: 200 })
}));

vi.mock("../src/mcp-security", () => ({
  verifyMcpAccessAssertion: verifyAssertionMock,
  accessServiceSubject: serviceSubjectMock,
  authorizeMcpRequest: authorizeMcpRequestMock
}));

vi.mock("../src/mcp-client-installation-service", () => ({
  activateMcpClientInstallation: activateMock
}));

vi.mock("../src/audit-service", () => ({
  appendAuditEvent: appendAuditEventMock
}));

let mountMcp: typeof import("../src/mcp").mountMcp;

beforeAll(async () => {
  ({ mountMcp } = await import("../src/mcp"));
}, 15_000);

describe("MCP client installation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAssertionMock.mockResolvedValue({ common_name: "service-client-id" });
    serviceSubjectMock.mockReturnValue("service-client-id");
    activateMock.mockResolvedValue({
      id: "install-1",
      tenant_id: "tenant-a",
      owner_principal: "user:alice",
      client_type: "codex",
      device_label: "Work Mac",
      purpose: "capture",
      status: "active",
      created_at: 1,
      activated_at: 2,
      last_used_at: 2,
      revoked_at: null,
      enrollment_expires_at: null
    });
    appendAuditEventMock.mockResolvedValue(undefined);
    authorizeMcpRequestMock.mockResolvedValue({
      source: "access-service",
      tenantId: "tenant-a",
      principal: "user:alice",
      clientInstallationId: "install-1",
      clientType: "codex",
      runtimeActor: "client:install-1"
    });
  });

  it("activates with the Access service subject and returns no enrollment or subject secret", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);
    const response = await app.fetch(new Request(
      "https://example.test/mcp/client-installations/activate",
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": "signed" },
        body: JSON.stringify({ enrollment_code: "obi_once", client_type: "codex" })
      }
    ), {} as Env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(activateMock).toHaveBeenCalledWith(expect.anything(), "obi_once", "service-client-id", "codex");
    const body = await response.json<Record<string, unknown>>();
    expect(JSON.stringify(body)).not.toMatch(/enrollment_code|token_hash|access_subject/u);
  });

  it("returns only metadata after the service token resolves to the same installation", async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountMcp(app);
    const response = await app.fetch(
      new Request("https://example.test/mcp/client-installations/status"),
      {} as Env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        id: "install-1",
        tenant_id: "tenant-a",
        client_type: "codex",
        runtime_actor: "client:install-1"
      }
    });
  });
});
