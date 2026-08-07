import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const runOpsWatchdogMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true as const,
  checked_at: 1_000,
  active_alert_count: 1,
  sent_count: 1,
  resolved_count: 0,
  alerts: [{ alert_key: "scheduled-job:memory-maintenance", severity: "critical" as const, status: "firing" as const }]
})));

vi.mock("agents/mcp", () => {
  class MockMcpAgent {
    static serve() {
      return { fetch: () => new Response("mcp") };
    }
  }
  return { McpAgent: MockMcpAgent };
});

vi.mock("../src/ops-watchdog-service", () => ({ runOpsWatchdog: runOpsWatchdogMock }));

describe("internal operations watchdog endpoint", () => {
  beforeEach(() => runOpsWatchdogMock.mockClear());

  it("rejects requests without the dedicated bearer token", async () => {
    const { default: worker } = await import("../src/index");
    const response = await worker.fetch(
      new Request("https://api.example.test/internal/ops/watchdog/run", { method: "POST" }),
      { OPS_WATCHDOG_TOKEN: "secret" } as Env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(401);
    expect(runOpsWatchdogMock).not.toHaveBeenCalled();
  });

  it("returns only aggregate state and alert keys to an authorized caller", async () => {
    const { default: worker } = await import("../src/index");
    const response = await worker.fetch(
      new Request("https://api.example.test/internal/ops/watchdog/run", {
        method: "POST",
        headers: { authorization: "Bearer secret" }
      }),
      { OPS_WATCHDOG_TOKEN: "secret" } as Env,
      {} as ExecutionContext
    );
    const body = await response.json<Record<string, unknown>>();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      checked_at: 1_000,
      active_alert_count: 1,
      sent_count: 1,
      resolved_count: 0,
      alerts: [{ alert_key: "scheduled-job:memory-maintenance", severity: "critical", status: "firing" }]
    });
    expect(JSON.stringify(body)).not.toContain("memory_body");
  });
});
