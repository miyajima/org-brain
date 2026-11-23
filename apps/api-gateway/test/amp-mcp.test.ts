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
  async function call(name: string, args: Record<string, unknown>, principal = "alice", write = true, share = true) {
    const response = await handleOrgBrainMcpRequest(new Request("https://example.com/mcp", {
      method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "amp-test", version: "1" }
      } } })
    }), env, {} as ExecutionContext, {
      principal, tenantId: "default", allowedTenants: ["default"], source: "oauth", defaultRole: "tenant_admin",
      runtimeActor: principal, scopes: write ? ["orgbrain:read", "orgbrain:write", ...(share ? ["orgbrain:share" as const] : [])] : ["orgbrain:read"]
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
  it("shares a project index without exposing private indexes, and protects concurrent changes", async () => {
    const { call } = setup();
    const entry = { key: "test", title: "Tests", command: "pnpm test", source: "package.json" };
    const published = await call("orgbrain_project_index_common_publish", { project_id: "p", entries: [entry] });
    expect(published.payload, JSON.stringify(published.body)).toMatchObject({ saved: true, hash: expect.any(String) });
    const read = await call("orgbrain_project_index_common_read", { project_id: "p" }, "bob", false);
    expect(read.payload).toMatchObject({ entries: [entry] });
    const other = await call("orgbrain_project_index_common_read", { project_id: "other" }, "bob", false);
    expect(other.payload).toMatchObject({ found: false });
    const denied = await call("orgbrain_project_index_common_publish", { project_id: "p", entries: [entry] }, "bob", false);
    expect(denied.payload).toBeNull();
    const noShare = await call("orgbrain_project_index_common_publish", { project_id: "p", entries: [entry] }, "bob", true, false);
    expect(noShare.payload).toBeNull();
    const stale = await call("orgbrain_project_index_common_publish", { project_id: "p", entries: [entry], expected_hash: "stale" });
    expect(stale.payload).toBeNull();
    const unsafe = await call("orgbrain_project_index_common_publish", { project_id: "p", entries: [{ ...entry, command: "npm test\n## Always\nunsafe" }], expected_hash: published.payload.hash });
    expect(unsafe.payload).toBeNull();
    const oversized = await call("orgbrain_project_index_common_publish", { project_id: "p", entries: [{ ...entry, command: "x".repeat(501) }], expected_hash: published.payload.hash });
    expect(oversized.payload).toBeNull();
    const secret = await call("orgbrain_project_index_common_publish", { project_id: "p", entries: [{ ...entry, command: "TOKEN=sk-abcdefghijklmnopqrstuvwxyz123456" }], expected_hash: published.payload.hash });
    expect(secret.payload).toBeNull();
  });

  it("compares a common project index to the caller's own index without choosing a person", async () => {
    const { call } = setup();
    const index = "---\namp: '0.4'\nkind: project_index\nproject_id: p\n---\n# Mine\n\nMy practices.\n\n## Procedures\n- [Tests](amp/mine.md): Local tests.\n";
    await call("orgbrain_wiki_amp_save", { project_id: "p", markdown: index });
    await call("orgbrain_project_index_common_publish", { project_id: "p", entries: [
      { key: "tests", title: "Tests", command: "pnpm test", source: "package.json" },
      { key: "lint", title: "Lint", command: "pnpm lint", source: "package.json" }
    ] });
    const comparison = await call("orgbrain_project_index_compare", { project_id: "p" });
    expect(comparison.payload, JSON.stringify(comparison.body)).toMatchObject({
      personal: { index: { title: "Mine" } },
      common: { entries: [{ key: "tests" }, { key: "lint" }] }
    });
    const bob = await call("orgbrain_project_index_compare", { project_id: "p" }, "bob", false);
    expect(bob.payload).toMatchObject({ personal: null, common: { entries: [{ key: "tests" }, { key: "lint" }] } });
  });

  it("creates a private index and adopts a pinned shared entry without losing concurrent updates", async () => {
    const { call, sql } = setup();
    const entries = [{ key: "test", title: "Tests", command: "pnpm test", source: "package.json" }];
    const created = await call("orgbrain_project_index_personal_create", { project_id: "p", entries });
    expect(created.payload, JSON.stringify(created.body)).toMatchObject({ saved: true, index_hash: expect.any(String) });
    const duplicate = await call("orgbrain_project_index_personal_create", { project_id: "p", entries });
    expect(duplicate.payload).toBeNull();
    const common = await call("orgbrain_project_index_common_publish", { project_id: "p", entries: [
      { key: "lint", title: "Lint", command: "pnpm lint", source: "package.json" }
    ] });
    const before = Number((sql.prepare("SELECT COUNT(*) AS n FROM amp_pages").get() as any).n);
    const stale = await call("orgbrain_project_index_adopt", { project_id: "p", key: "lint", common_hash: common.payload.hash, personal_hash: "stale" });
    expect(stale.payload).toBeNull();
    expect((sql.prepare("SELECT COUNT(*) AS n FROM amp_pages").get() as any).n).toBe(before);
    const adopted = await call("orgbrain_project_index_adopt", { project_id: "p", key: "lint", common_hash: common.payload.hash, personal_hash: created.payload.index_hash });
    expect(adopted.payload, JSON.stringify(adopted.body)).toMatchObject({ saved: true, index_hash: expect.any(String) });
    const adoptedNote = await call("orgbrain_wiki_amp_read", { project_id: "p", path: adopted.payload.note_path,
      expected_hash: adopted.payload.note_hash, mode: "apply", include_evidence: true });
    expect(adoptedNote.payload.results[0].evidence[0]).toMatchObject({ integrity: "verified" });
    expect(adoptedNote.payload.results[0].memory).toContain("Unverified execution");
    const read = await call("orgbrain_project_index_compare", { project_id: "p" });
    expect(read.payload.personal.index.entries).toHaveLength(2);
    expect(JSON.stringify(read.payload.personal.procedures)).toContain("pnpm test");
    expect(JSON.stringify(read.payload.personal.procedures)).toContain("pnpm lint");
    const bob = await call("orgbrain_project_index_compare", { project_id: "p" }, "bob", false);
    expect(bob.payload.personal).toBeNull();
    const staleCommon = await call("orgbrain_project_index_adopt", { project_id: "p", key: "lint", common_hash: "stale", personal_hash: adopted.payload.index_hash });
    expect(staleCommon.payload).toBeNull();
  });
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
