import manifest from "../../../packages/mcp-core/fixtures/tool-manifest.json";
import {
  capturedMcpToolContracts,
  resetCapturedMcpToolContracts
} from "@org-brain/mcp-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createOrgBrainMcpServer } from "../src/mcp";
import type { Env } from "../src/types";

// Zod 4.6 emits primitive unions as a type array. Compare the equivalent
// JSON Schema representation while retaining every non-union contract field.
function canonicalNullableTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalNullableTypes);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalNullableTypes(item)]));
  if (Array.isArray(result.anyOf) && result.anyOf.every((branch) =>
    branch !== null && typeof branch === "object" && Object.keys(branch).length === 1 && "type" in branch
  )) {
    result.type = result.anyOf.flatMap((branch) => (branch as { type: unknown }).type);
    delete result.anyOf;
  }
  if (Array.isArray(result.type)) result.type = [...new Set(result.type)].sort();
  return result;
}

describe("MCP tool contract", () => {
  beforeEach(() => resetCapturedMcpToolContracts());

  it("captures all schemas and scope mappings from the shared registry", async () => {
    await createOrgBrainMcpServer({} as Env, {
      principal: "manifest-generator",
      ownerPrincipal: "manifest-generator",
      runtimeActor: "manifest-generator",
      tenantId: "manifest",
      allowedTenants: ["manifest"],
      defaultRole: "reader",
      authSource: "access-service"
    });
    const tools = capturedMcpToolContracts();
    expect(canonicalNullableTypes(tools)).toEqual(canonicalNullableTypes(manifest.tools));
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(tools.find((tool) => tool.name === "orgbrain_memory_quality_audit")).toMatchObject({
      permission: "read",
      scope: "orgbrain:read"
    });
    expect(tools.find((tool) => tool.name === "orgbrain_memory_extraction_enqueue")).toMatchObject({
      permission: "write",
      scope: "orgbrain:write"
    });
    expect(tools.every((tool) => tool.input_schema.type === "object")).toBe(true);
  });
});
