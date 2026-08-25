import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const CLI = resolve("packages/orgbrain-cli/src/local-memory.mjs");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-mcp-protocol-"));
  await chmod(directory, 0o700);
  return {
    dbPath: join(directory, "memory.sqlite"),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function connect(dbPath, { legacy = false } = {}) {
  const args = [CLI, "mcp"];
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
