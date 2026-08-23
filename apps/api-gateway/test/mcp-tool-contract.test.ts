import {
  capturedMcpToolContracts,
  resetCapturedMcpToolContracts
} from "@org-brain/mcp-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createOrgBrainMcpServer } from "../src/mcp";
import type { Env } from "../src/types";

describe("MCP tool contract", () => {
  beforeEach(() => resetCapturedMcpToolContracts());

  it("captures all 48 schemas and scope mappings from the shared registry", async () => {
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
    expect(tools).toHaveLength(48);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(48);
    expect(tools.every((tool) => tool.input_schema.type === "object")).toBe(true);
  });
});
