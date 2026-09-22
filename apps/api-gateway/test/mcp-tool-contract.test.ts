import manifest from "../../../packages/mcp-core/fixtures/tool-manifest.json";
import {
  capturedMcpToolContracts,
  resetCapturedMcpToolContracts
} from "@org-brain/mcp-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createOrgBrainMcpServer } from "../src/mcp";
import type { Env } from "../src/types";

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
    expect(tools).toEqual(manifest.tools);
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
