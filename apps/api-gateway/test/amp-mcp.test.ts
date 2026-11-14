import { describe, expect, it, vi } from "vitest";
import { memoryD1Fixture } from "./fixtures/memory-d1";
import { handleOrgBrainMcpRequest } from "../src/mcp";
import { CloudAmpService } from "../src/amp-service";
vi.mock("../src/context-engine-service", async () => ({
  ...await vi.importActual<typeof import("../src/context-engine-service")>("../src/context-engine-service"),
  enrichContext: async (_env: unknown, _input: unknown, options: any) => ({ results: [], ...(options.projectIndex ? { project_index: options.projectIndex } : {}) })
}));

function setup() {
  const { env, sql } = memoryD1Fixture();
  env.ORGBRAIN_AMP_ENABLED = "true";
  env.API_RATE_LIMITER = { limit: async () => ({ success: true }) };
  async function call(name: string, args: Record<string, unknown>, principal = "alice", write = true) {
    const response = await handleOrgBrainMcpRequest(new Request("https://example.com/mcp", {
      method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "amp-test", version: "1" }
      } } })
    }), env, {} as ExecutionContext, {
      principal, tenantId: "default", allowedTenants: ["default"], source: "oauth", defaultRole: "tenant_admin",
      runtimeActor: principal, scopes: write ? ["orgbrain:read", "orgbrain:write"] : ["orgbrain:read"]
    });
    const text = await response.text();
    if (response.status >= 400) return { status: response.status, body: { error: text }, payload: null };
    const raw = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text;
    const body = JSON.parse(raw);
    const result = body.result;
    return { status: response.status, body, payload: result && !result.isError ? JSON.parse(result.content[0].text) : null };
  }
  return { env, sql, call };
}

describe("Cloud AMP MCP entry point", () => {
  it("saves and reads the new format with omitted defaults, scoped pointers and verified sources", async () => {
    const { call } = setup();
    const source = await call("orgbrain_wiki_ingest", { project_id: "p", name: "guide", text: "Canary launch condition." });
    expect(source.payload, JSON.stringify(source.body)).toHaveProperty("source_id");
    const saved = await call("orgbrain_wiki_amp_save", { project_id: "p", memory: {
      claim: "Canary launch condition.", evidence: [{ ref: `source:${source.payload.source_id}@1#L1-L1` }]
    } });
    expect(saved.payload, JSON.stringify(saved.body)).toMatchObject({ protocol: "amp/0.4", writes_performed: true });
    const search = await call("orgbrain_wiki_amp_search", { project_id: "p", query: "Canary", fallback: false });
    expect(search.payload.results[0]).toMatchObject({ requires_read: true, path: saved.payload.path });
    const read = await call("orgbrain_wiki_amp_read", { ...search.payload.results[0].next_read.arguments, include_evidence: true });
    expect(read.payload.results[0]).toMatchObject({ evidence_integrity: "verified", requires_read: false });
  });

  it("denies read-only writes and ungranted tenants, and isolates different authenticated owners", async () => {
    const { call, sql } = setup();
    const denied = await call("orgbrain_wiki_amp_save", { project_id: "p", memory: { claim: "Private canary" } }, "alice", false);
    expect(denied.status).toBe(403);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM amp_pages").get()).toMatchObject({ n: 0 });
    expect((await call("orgbrain_wiki_amp_save", { project_id: "p", memory: { claim: "Private canary" } })).payload.writes_performed).toBe(true);
    const other = await call("orgbrain_wiki_amp_search", { project_id: "p", query: "Private canary" }, "bob");
    expect(other.payload.results).toEqual([]);
    const tenant = await call("orgbrain_wiki_amp_search", { tenant_id: "other", project_id: "p", query: "Private canary" });
    expect(tenant.payload).toBeNull();
    expect(JSON.stringify(tenant.body)).toContain("tenant not allowed");
  });

  it("includes the project entry in ordinary context independently of the query", async () => {
    const { env, call } = setup();
    const amp = new CloudAmpService(env, { tenantId: "default", principal: "alice", projectId: "p" });
    await amp.save({ markdown: "---\namp: '0.4'\nkind: project_index\nproject_id: p\n---\n# Work\n\nRead first.\n\n## Always\n- [Rules](amp/rules.md): Every task.\n" });
    const found = await call("orgbrain_context_enrich", { project_id: "p", task: { title: "Unrelated work" } });
    expect(found.payload.project_index.next_read.arguments).toMatchObject({ tenant_id: "default", project_id: "p" });
    const other = await call("orgbrain_context_enrich", { project_id: "p", task: { title: "Unrelated work" } }, "bob");
    expect(other.payload.project_index).toBeUndefined();
    env.ORGBRAIN_AMP_ENABLED = "false";
    const disabled = await call("orgbrain_context_enrich", { project_id: "p", task: { title: "Unrelated work" } });
    expect(disabled.payload.project_index).toBeUndefined();
  });
});
