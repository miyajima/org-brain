import { describe, expect, it } from "vitest";
import {
  collectCompatibilityManifestEntries,
  collectSharedRouteDefinitions,
  createApiManifest
} from "../src/index.js";

describe("shared API manifest", () => {
  it("is generated from the eight route registrars with the approved operation counts", () => {
    const definitions = collectSharedRouteDefinitions();
    const counts = Object.fromEntries(
      [...new Set(definitions.map((definition) => definition.group))]
        .map((group) => [group, definitions.filter((definition) => definition.group === group).length])
    );
    expect(counts).toEqual({
      "asset-agent": 20,
      collaboration: 20,
      "dashboard-access": 10,
      "decision-context": 33,
      domain: 27,
      identity: 19,
      memory: 43,
      operations: 13
    });
    expect(definitions).toHaveLength(185);
  });

  it("adds MCP and OAuth protocol operations without duplicates", () => {
    const routes = collectCompatibilityManifestEntries();
    const manifest = createApiManifest({
      ossRef: "4746fe70406656b4ec85fec485033dc4be5d4303",
      generatedAt: "2026-08-20T00:00:00.000Z",
      routes
    });
    expect(manifest.routes).toHaveLength(194);
    expect(new Set(manifest.routes.map((route) => `${route.method} ${route.path}`)).size).toBe(194);
    const shared = manifest.routes.filter((route) => route.path.startsWith("/v1/") || route.path.startsWith("/api/"));
    expect(shared.every((route) => route.request_schema && route.response_schema)).toBe(true);
  });
});
