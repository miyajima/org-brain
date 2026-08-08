import { describe, expect, it } from "vitest";
import { dashboardApiPath, dashboardPageParams, fetchDashboardData } from "./dashboard-page";

describe("dashboard page helpers", () => {
  it("normalizes scope and keeps a default tenant explicit", () => {
    const scoped = dashboardPageParams(new URL("https://console.test/overview?project_id=p-1&lang=ja"));
    expect(scoped.tenantId).toBe("default");
    expect(scoped.projectId).toBe("p-1");
    expect(scoped.lang).toBe("ja");
    expect(scoped.params.get("tenant_id")).toBe("default");
    expect(scoped.apiParams.toString()).toBe("tenant_id=default&project_id=p-1");
    expect(dashboardApiPath("/api/v1/tasks", scoped.apiParams, { limit: 20 })).toBe(
      "/api/v1/tasks?tenant_id=default&project_id=p-1&limit=20"
    );
  });

  it("returns normalized envelope data", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: { value: "4" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    try {
      const result = await fetchDashboardData(new URL("https://console.test/api"), (value) => Number((value as { value: string }).value), 0);
      expect(result).toEqual({ data: 4, error: null });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the fallback and surfaces API errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { message: "not available" } }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
    try {
      const result = await fetchDashboardData(new URL("https://console.test/api"), String, "empty");
      expect(result).toEqual({ data: "empty", error: "not available" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
