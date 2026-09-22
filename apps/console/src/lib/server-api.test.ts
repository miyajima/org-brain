import { describe, expect, it, vi } from "vitest";
import { createServerApi } from "./server-api";

describe("server-rendered API authentication", () => {
  it("preserves identity and Headers instances without permitting credential overrides", async () => {
    const transport = vi.fn(async (_url: unknown, _init: RequestInit) => new Response("{}"));
    const api = createServerApi(new Request("https://console.test/page", {
      headers: { cookie: "__Host-orgbrain_session=session", "cf-access-jwt-assertion": "jwt" }
    }), transport as typeof fetch);
    await api("/api/v1/memories", { headers: new Headers({ accept: "application/json", cookie: "other", "x-api-key": "service" }) });
    const init = transport.mock.calls[0][1];
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe("__Host-orgbrain_session=session");
    expect(headers.get("cf-access-jwt-assertion")).toBe("jwt");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("x-api-key")).toBe(false);
    expect(init.redirect).toBe("manual");
    await expect(api("https://other.test/api/steal")).rejects.toThrow("same-origin");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("forwards trusted Origin and CSRF for mutations, rejecting missing or foreign origins", async () => {
    const transport = vi.fn(async (_url: unknown, _init: RequestInit) => new Response("{}"));
    for (const origin of [null, "https://attacker.test", "https://console.test"]) {
      const api = createServerApi(new Request("https://console.test/retrospectives", {
        method: "POST", headers: origin ? { origin } : {}
      }), transport as typeof fetch);
      const response = await api("/api/v1/retrospectives/x/close", {
        method: "POST", headers: new Headers({ "x-csrf-token": "csrf", "x-idempotency-key": "operation" })
      });
      expect(response.status).toBe(origin === "https://console.test" ? 200 : 403);
    }
    expect(transport).toHaveBeenCalledTimes(1);
    const headers = new Headers(transport.mock.calls[0][1].headers);
    expect(headers.get("origin")).toBe("https://console.test");
    expect(headers.get("x-csrf-token")).toBe("csrf");
    expect(headers.get("x-idempotency-key")).toBe("operation");
  });

  it("supports only explicitly read-only POST endpoints during SSR GET rendering", async () => {
    const transport = vi.fn(async () => new Response("{}"));
    const api = createServerApi(new Request("https://console.test/memories"), transport as typeof fetch);
    expect((await api("/api/v1/memories/search", { method: "POST" })).status).toBe(200);
    expect((await api("/api/v1/memories/profile", { method: "POST" })).status).toBe(200);
    expect((await api("/api/v1/decision-memories/search", { method: "POST" })).status).toBe(200);
    expect((await api("/api/v1/memories", { method: "POST" })).status).toBe(403);
    expect((await api("/api/v1/decision-memories/search", { method: "PUT" })).status).toBe(403);
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
