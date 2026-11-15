import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { requirementForMcpTool } from "@org-brain/mcp-core";
import { registerTool } from "../src/mcp/common";

describe("internal MCP registration", () => {
  it("rejects an unclassified tool before SDK registration while preserving the public fallback", () => {
    const register = vi.fn();
    const server = { registerTool: register } as unknown as McpServer;
    expect(requirementForMcpTool("orgbrain_unclassified_test")).toEqual({ permission: "read", scope: "orgbrain:read" });
    // @ts-expect-error Exercise the runtime boundary for an unclassified caller.
    expect(() => registerTool(server, "orgbrain_unclassified_test", {}, async () => ({ content: [] }))).toThrow(/unclassified_mcp_tool/);
    expect(register).not.toHaveBeenCalled();
  });

  it("rejects a declaration that conflicts with the established permission", () => {
    const register = vi.fn();
    const server = { registerTool: register } as unknown as McpServer;
    expect(() => registerTool(server, "orgbrain_memories_confirm", {}, async () => ({ content: [] }), "read"))
      .toThrow(/mcp_tool_permission_mismatch/);
    expect(register).not.toHaveBeenCalled();
  });

  it("uses the SDK's duplicate-name protection", () => {
    const server = new McpServer({ name: "classification-test", version: "1" });
    const handler = async () => ({ content: [] });
    registerTool(server, "orgbrain_memories_confirm", {}, handler, "write");
    expect(() => registerTool(server, "orgbrain_memories_confirm", {}, handler, "write")).toThrow();
  });
});
