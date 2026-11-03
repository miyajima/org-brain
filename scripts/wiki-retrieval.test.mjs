import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { WikiService, countWikiTokens, setWikiFeature } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
import { callWikiTool } from "../packages/orgbrain-cli/src/lib/wiki-mcp.mjs";

test("CLI filters and targeted original reads reach matching sections through public arguments", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-retrieval-cli-")));
  const env = { ...process.env, ORGBRAIN_FEATURES_FILE: join(home, "features.json"), ORGBRAIN_WIKI_ROOT: join(home, "wiki"), ORGBRAIN_WIKI_ENGINE: resolve("packages/wiki-engine/target/debug/orgbrain-wiki-engine") };
  const wiki = new WikiService({ config: env.ORGBRAIN_FEATURES_FILE, root: env.ORGBRAIN_WIKI_ROOT, binary: env.ORGBRAIN_WIKI_ENGINE });
  const run = (...args) => JSON.parse(execFileSync(process.execPath, ["packages/orgbrain-cli/src/local-memory.mjs", "wiki", ...args], { env, encoding: "utf8", stdio: "pipe" }));
  try {
    await setWikiFeature(wiki.config, true);
    await wiki.request({ op: "init" });
    const source = await wiki.request({ op: "ingest", name: "results.md", text: `# Background\n${"filler\n".repeat(1000)}## Result\n採用未確認の提案を32件保存。\n` });
    const page = await wiki.request({ op: "put", path: "topic/a.md", project_id: "test", content: `# Test\n原本を読んで再利用。\n[e](source:${source.source_id}@1)` });
    const hits = run("search", "原本 再利用", "--match-mode", "all", "--path-prefix", "topic/", "--project-id", "test");
    assert.equal(hits.hits[0].owner_id, page.page_id);
    const read = run("source-read", "--source-id", source.source_id, "--version", "1", "--query", "採用未確認", "--max-chars", "128");
    assert.match(read.text, /採用未確認/);
    assert.ok(read.matched_line > 1000);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("MCP source-read pagination keeps the query-centered offset under a token budget", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-retrieval-mcp-")));
  const wiki = new WikiService({ config: join(home, "features.json"), root: join(home, "wiki"), binary: resolve("packages/wiki-engine/target/debug/orgbrain-wiki-engine") });
  try {
    await setWikiFeature(wiki.config, true);
    await wiki.request({ op: "init" });
    const before = Array.from({ length: 700 }, (_, i) => `前文${i} `).join("");
    const after = Array.from({ length: 700 }, (_, i) => `後文${i} `).join("");
    const text = `# Intro\n${before}採用未確認、32件保存。${after}`;
    const source = await wiki.request({ op: "ingest", name: "long.md", text });
    const input = { source_id: source.source_id, version: 1, query: "採用未確認", max_chars: 6000, token_budget: 800 };
    const first = await callWikiTool({}, "orgbrain_wiki_source_read", input, { wiki });
    assert.ok(countWikiTokens(first) <= 800);
    assert.match(first.text, /採用未確認/);
    assert.ok(first.char_offset > 0);
    const second = await callWikiTool({}, "orgbrain_wiki_source_read", { ...input, char_offset: first.next_char_offset }, { wiki });
    const originalRange = text.split("\n").slice(first.range_start_line - 1, first.range_end_line).join("\n");
    assert.equal([...originalRange].slice(first.char_offset, first.char_offset + [...first.text].length).join(""), first.text);
    assert.equal([...originalRange].slice(first.next_char_offset, first.next_char_offset + [...second.text].length).join(""), second.text);
  } finally { await rm(home, { recursive: true, force: true }); }
});
