import { describe, expect, it } from "vitest";
import { createApiManifest, diffApiManifests, manifestEntry, type ApiRouteDefinition } from "../src/index.js";

const route: ApiRouteDefinition = {
  group: "identity",
  method: "GET",
  path: "/v1/organization",
  permission: "read",
  request_schema: null,
  response_schema: "organization/v1",
  success_statuses: [200],
  idempotent: true,
  handler: async () => ({ status: 200 })
};

describe("API manifest parity", () => {
  it("removes runtime-only fields and detects contract changes", () => {
    const manifestRoute = manifestEntry(route);
    expect(manifestRoute).not.toHaveProperty("handler");
    expect(manifestRoute).not.toHaveProperty("group");
    const expected = createApiManifest({
      ossRef: "4746fe70406656b4ec85fec485033dc4be5d4303",
      generatedAt: "2026-08-22T00:00:00.000Z",
      routes: [manifestRoute]
    });
    const actual = createApiManifest({
      ossRef: "4746fe70406656b4ec85fec485033dc4be5d4303",
      generatedAt: "2026-08-22T00:00:00.000Z",
      routes: [{ ...manifestRoute, permission: "write" }]
    });
    expect(diffApiManifests(expected, actual)).toMatchObject({
      equal: false,
      changed: ["GET /v1/organization"]
    });
  });
});
