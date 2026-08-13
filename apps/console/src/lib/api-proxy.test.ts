import { describe, expect, it } from "vitest";
import { normalizeFallbackResponse, stripProxyHeaders } from "../pages/api/[...path]";

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
});
