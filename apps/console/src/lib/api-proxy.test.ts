import { describe, expect, it } from "vitest";
import { stripProxyHeaders } from "../pages/api/[...path]";

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
});
