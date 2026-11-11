import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryD1Fixture } from "./fixtures/memory-d1";

const handlers = vi.hoisted(() => new Map<string, (input: any) => Promise<any>>());
const sharedKnowledgeForSearch = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ shared_knowledge: [] })));
vi.mock("@modelcontextprotocol/server", () => ({ McpServer: class {
  registerTool(name: string, _config: unknown, handler: (input: any) => Promise<any>) { handlers.set(name, handler); }
} }));
vi.mock("../src/team-knowledge-service", async (original) => ({ ...await original<object>(), sharedKnowledgeForSearch }));
vi.mock("../src/context-engine-service", async (original) => ({
  ...await original<object>(), searchDecisionMemories: async () => ({ results: [] })
}));

const props = { tenantId: "fixture", allowedTenants: ["fixture"], principal: "user:alice", defaultRole: "tenant_admin" as const,
  authSource: "oauth" as const, scopes: ["orgbrain:read"] };

describe("shared knowledge delivery on MCP memory search", () => {
  beforeEach(() => { handlers.clear(); sharedKnowledgeForSearch.mockClear(); });

  it("defers the delivery write to the request's execution context", async () => {
    const { sql, env } = memoryD1Fixture();
    try {
      const queued: Promise<unknown>[] = [];
      const { createOrgBrainMcpServer } = await import("../src/mcp");
      await createOrgBrainMcpServer(env, props as never, { waitUntil: promise => { queued.push(promise); } });
      await handlers.get("orgbrain_memories_search")!({ q: "release checklist", search_scope: "governance" });
      const options = sharedKnowledgeForSearch.mock.calls[0]![3] as { accessPath: string; waitUntil?: (promise: Promise<unknown>) => void };
      expect(options.accessPath).toBe("memory_search_mcp");
      const pending = Promise.resolve();
      options.waitUntil!(pending);
      expect(queued).toEqual([pending]);
    } finally { sql.close(); }
  });

  it("leaves the write awaited when the server is built without an execution context", async () => {
    const { sql, env } = memoryD1Fixture();
    try {
      const { createOrgBrainMcpServer } = await import("../src/mcp");
      await createOrgBrainMcpServer(env, props as never);
      await handlers.get("orgbrain_memories_search")!({ q: "release checklist", search_scope: "governance" });
      expect((sharedKnowledgeForSearch.mock.calls[0]![3] as { waitUntil?: unknown }).waitUntil).toBeUndefined();
    } finally { sql.close(); }
  });
});
