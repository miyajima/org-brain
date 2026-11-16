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
import { countWikiTokens, setWikiFeature, WikiService } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
import { callWikiTool } from "../packages/orgbrain-cli/src/lib/wiki-mcp.mjs";

test("large Wiki diagnoses return a bounded prefix without re-encoding most findings for each omission", async () => {
  let encoded = 0;
  const findings = Array.from({ length: 800 }, (_, index) => ({
    code: "unpaged_source",
    details: {
      source_id: `original-${index}`,
      name: `検証原本 ${index} 診断手順と引用の確認`,
      original_path: `raw/過去の確認資料 ${index}.md`,
      version: 1,
    },
    toJSON() {
      encoded++;
      return { code: this.code, details: this.details };
    },
  }));
  const started = performance.now();
  const result = await callWikiTool(null, "orgbrain_wiki_diagnose", { wiki_id: "personal" }, {
    wiki: { request: async () => ({ integrity: "ok", findings: findings.slice() }) },
  });
  const work = encoded;
  assert.equal(result.integrity, "ok");
  assert.equal(result.truncated, true);
  assert.ok(result.findings.length > 0 && result.findings.length < findings.length);
  assert.deepEqual(result.findings, findings.slice(0, result.findings.length));
  assert.ok(countWikiTokens(result) <= 4000);
  assert.ok(countWikiTokens({
    integrity: result.integrity,
    findings: findings.slice(0, result.findings.length + 1),
    truncated: true,
  }) > 3960);
  assert.ok(work < findings.length * 20, `encoded ${work} findings in ${Math.round(performance.now() - started)} ms`);
});

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
