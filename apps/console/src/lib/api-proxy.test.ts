import { describe, expect, it } from "vitest";
import {
  applyProxyAuthentication,
  normalizeFallbackResponse,
  stripProxyHeaders
} from "../pages/api/[...path]";

describe("Console API proxy headers", () => {
  it("keeps Access identity at the Console boundary and replaces caller API credentials", () => {
    const headers = stripProxyHeaders(new Headers({
      accept: "application/json",
      "cf-access-authenticated-user-email": "owner@example.com",
      "cf-access-jwt-assertion": "access-jwt",
      host: "console.example.com",
      "x-api-key": "caller-key",
      "x-request-id": "request-1"
    }));

    expect(Object.fromEntries(headers.entries())).toEqual({
      accept: "application/json",
      "x-request-id": "request-1"
    });
  });

  it("never replaces session or bearer credentials with a service key", () => {
    for (const headers of [new Headers({ cookie: "__Host-orgbrain_session=invalid" }), new Headers({ authorization: "Bearer invalid" })]) {
      expect(applyProxyAuthentication(headers, "v1/memories", null, "service").has("x-api-key")).toBe(false);
    }
    expect(applyProxyAuthentication(new Headers({ cookie: "theme=dark" }), "v1/memories", null, "service").get("x-api-key")).toBe("service");
  });

  it("removes stale compression metadata from decoded fallback responses", async () => {
    const response = normalizeFallbackResponse(new Response('{"ok":true}', {
      headers: {
        "content-encoding": "gzip",
        "content-length": "999",
        "content-type": "application/json"
      }
    }));

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("forwards the verified Access identity for every endpoint", () => {
    const installationHeaders = applyProxyAuthentication(
      new Headers({ accept: "application/json" }),
      "v1/mcp-client-installations",
      "verified-access-jwt",
      "internal-key"
    );
    expect(installationHeaders.get("cf-access-jwt-assertion")).toBe("verified-access-jwt");
    expect(installationHeaders.has("x-api-key")).toBe(false);

    const regularHeaders = applyProxyAuthentication(
      new Headers({ accept: "application/json" }),
      "v1/memories",
      "verified-access-jwt",
      "internal-key"
    );
    expect(regularHeaders.get("cf-access-jwt-assertion")).toBe("verified-access-jwt");
    expect(regularHeaders.has("x-api-key")).toBe(false);
  });
});
