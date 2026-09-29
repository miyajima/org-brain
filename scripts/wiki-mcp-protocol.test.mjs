import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setWikiFeature } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
test("real MCP sessions hide Wiki tools immediately and return feature_disabled after OFF", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-sdk-")));
  const config = join(home, "features.json");
  await setWikiFeature(config, true);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("packages/orgbrain-cli/src/local-memory.mjs"), "mcp"],
    env: {
      ...getDefaultEnvironment(),
      ORGBRAIN_LOCAL_DB: join(home, "memory.sqlite"),
      ORGBRAIN_FEATURES_FILE: config,
      ORGBRAIN_WIKI_ROOT: join(home, "wiki"),
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "wiki-test", version: "1" },
    {
      versionNegotiation: {
        mode: { pin: "2026-07-28" },
        probe: { timeoutMs: 2000 },
      },
    },
  );
  try {
    await client.connect(transport);
    assert.ok(
      (await client.listTools()).tools.some(
        (t) => t.name === "orgbrain_wiki_read",
      ),
    );
    await setWikiFeature(config, false);
    await new Promise((r) => setTimeout(r, 1300));
    const response = await client.callTool({
      name: "orgbrain_wiki_read",
      arguments: { path: "a.md" },
    });
    assert.equal(response.isError, true);
    assert.equal(
      JSON.parse(response.content[0].text).error,
      "feature_disabled",
    );
    assert.equal(
      (await client.listTools()).tools.some((t) =>
        t.name.startsWith("orgbrain_wiki_"),
      ),
      false,
    );
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});
