import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

const CLI = resolve("packages/orgbrain-cli/src/local-memory.mjs");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-mcp-protocol-"));
  await chmod(directory, 0o700);
  return {
    dbPath: join(directory, "memory.sqlite"),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function connect(dbPath, { legacy = false, toolProfile = null } = {}) {
  const args = [CLI, "mcp"];
  if (toolProfile) args.push("--tool-profile", toolProfile);
  if (legacy) {
    args.push(
      "--compat",
      "2025-11-25",
      "--legacy-until",
      new Date(Date.now() + 60_000).toISOString()
    );
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { ...getDefaultEnvironment(), ORGBRAIN_LOCAL_DB: dbPath },
    stderr: "pipe"
  });
  const client = new Client(
    { name: "orgbrain-protocol-test", version: "1.0.0" },
    legacy
      ? {}
      : { versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 2_000 } } }
  );
  await client.connect(transport);
  return { client, transport };
}

async function close(connection) {
  await connection.client.close().catch(() => undefined);
  await connection.transport.close().catch(() => undefined);
}

test("strict local MCP negotiates 2026-07-28 and survives a process restart between propose and confirm", async () => {
  const ctx = await fixture();
  let first;
  let second;
  try {
    first = await connect(ctx.dbPath);
    assert.equal(first.client.getProtocolEra(), "modern");
    assert.deepEqual(first.client.getDiscoverResult()?.supportedVersions, ["2026-07-28"]);
    const catalog = await first.client.listTools();
    assert.ok(catalog.tools.some((tool) => tool.name === "orgbrain_memories_propose"));

    const proposed = await first.client.callTool({
      name: "orgbrain_memories_propose",
      arguments: {
        tenant_id: "default",
        item: {
          external_key: "protocol:test-restart-confirmation",
          content: "結論: MCP確認を再起動後も継続する。\n理由: 確認境界をプロセス寿命から分離するため。",
          summary: "MCP確認を再起動後も継続する"
        }
      }
    });
    const proposal = JSON.parse(proposed.content[0].text);
    assert.match(proposal.confirmation_token, /^[0-9a-f-]{36}$/u);
    await close(first);
    first = null;

    second = await connect(ctx.dbPath);
    const confirmed = await second.client.callTool({
      name: "orgbrain_memories_confirm",
      arguments: {
        tenant_id: "default",
        confirmation_token: proposal.confirmation_token,
        approved: true
      }
    });
    const result = JSON.parse(confirmed.content[0].text);
    assert.equal(result.saved, true);
    assert.match(result.memory_id, /^[0-9a-f-]{36}$/u);
  } finally {
    if (first) await close(first);
    if (second) await close(second);
    await ctx.cleanup();
  }
});

test("legacy local MCP is explicit and deadline bounded", async () => {
  const ctx = await fixture();
  let connection;
  try {
    connection = await connect(ctx.dbPath, { legacy: true });
    assert.equal(connection.client.getProtocolEra(), "legacy");
    assert.equal(connection.client.getNegotiatedProtocolVersion(), "2025-11-25");
    const catalog = await connection.client.listTools();
    assert.ok(catalog.tools.some((tool) => tool.name === "orgbrain_memory_search"));
  } finally {
    if (connection) await close(connection);
    await ctx.cleanup();
  }
});

test("strict local MCP rejects an implicit legacy handshake", async () => {
  const ctx = await fixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env: { ...getDefaultEnvironment(), ORGBRAIN_LOCAL_DB: ctx.dbPath },
    stderr: "pipe"
  });
  const client = new Client({ name: "orgbrain-legacy-rejection-test", version: "1.0.0" });
  try {
    await assert.rejects(client.connect(transport));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await ctx.cleanup();
  }
});

test("answer UX MCP profile exposes only the exact read-only context surface", async () => {
  const ctx = await fixture();
  let connection;
  try {
    const store = new LocalMemoryStore(ctx.dbPath, { denseEmbeddingProvider: null });
    await store.capture({
      tenant_id: "default", project_id: "answer-ux", kind: "decision", lifecycle_state: "active",
      scope_type: "project", scope_key: "answer-ux",
      content: "The internal raw memory body must not be returned by the answer UX profile.",
      summary: "Two reviewers are required before the read-only smoke check.",
      tags: ["approval"], source: "test", source_references: [{ type: "document", ref: "RUNBOOK-SAFE" }],
      external_key: "answer-ux:safe", actor_type: "principal", actor_id: "test", confidence_score: 0.9
    });
    connection = await connect(ctx.dbPath, { toolProfile: "answer-ux-readonly" });
    const catalog = await connection.client.listTools();
    assert.deepEqual(catalog.tools.map((tool) => tool.name), [
      "orgbrain_context_enrich",
      "orgbrain_domain_context"
    ]);
    await assert.rejects(connection.client.callTool({
      name: "orgbrain_memories_propose",
      arguments: { item: { content: "must not be accepted" } }
    }));
    const enriched = await connection.client.callTool({
      name: "orgbrain_context_enrich",
      arguments: { tenant_id: "default", project_id: "answer-ux", query: "reviewers and read-only smoke" }
    });
    const text = enriched.content[0].text;
    const payload = JSON.parse(text);
    assert.doesNotMatch(text, /memory_id|usage_id|recall_id|candidate_id|\/domain-recalls\//u);
    assert.doesNotMatch(text, /internal raw memory body/u);
    assert.equal(payload.evidence_bundle.evidence[0].summary, "Two reviewers are required before the read-only smoke check.");
    assert.equal(payload.evidence_bundle.evidence[0].source_ref, "RUNBOOK-SAFE");
  } finally {
    if (connection) await close(connection);
    await ctx.cleanup();
  }
});
