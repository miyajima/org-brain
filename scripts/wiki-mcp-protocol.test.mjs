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
import { setWikiFeature, WikiService } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
test("real MCP sessions hide Wiki tools immediately and return feature_disabled after OFF", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-sdk-")));
  const config = join(home, "features.json");
  await setWikiFeature(config, true);
  await new WikiService({ config, root: join(home, "wiki") }).request({ op: "init" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("packages/orgbrain-cli/src/local-memory.mjs"), "mcp"],
    env: {
      ...getDefaultEnvironment(),
      ORGBRAIN_LOCAL_DB: join(home, "memory.sqlite"),
      ORGBRAIN_FEATURES_FILE: config,
      ORGBRAIN_WIKI_ROOT: join(home, "wiki"),
      ...(process.env.ORGBRAIN_WIKI_ENGINE ? { ORGBRAIN_WIKI_ENGINE: process.env.ORGBRAIN_WIKI_ENGINE } : {}),
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
    const put = await client.callTool({ name: "orgbrain_wiki_put", arguments: { path: "smoke.md", content: "# Smoke\nlock recovery evidence" } });
    assert.equal(put.isError, false);
    const page = JSON.parse(put.content[0].text);
    const read = await client.callTool({ name: "orgbrain_wiki_read", arguments: { path: "smoke.md" } });
    assert.equal(read.isError, false); assert.equal(JSON.parse(read.content[0].text).hash, page.hash);
    const search = await client.callTool({ name: "orgbrain_wiki_search", arguments: { query: "recovery", scope: "wiki" } });
    assert.equal(search.isError, false); assert.ok(JSON.parse(search.content[0].text).hits.length > 0);
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
        t.name.startsWith("orgbrain_wiki_") && t.name !== "orgbrain_wiki_assess",
      ),
      false,
    );
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});
