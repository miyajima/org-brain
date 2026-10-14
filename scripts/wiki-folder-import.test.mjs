import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { WikiService, countWikiTokens } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
import { callWikiTool, WIKI_TOOLS } from "../packages/orgbrain-cli/src/lib/wiki-mcp.mjs";

test("folder CLI imports multiple batches and exposes bounded catalog through MCP", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-folder-cli-")));
  const env = {
    ...process.env,
    ORGBRAIN_FEATURES_FILE: join(home, "features.json"),
    ORGBRAIN_WIKI_ROOT: join(home, "wiki"),
    ORGBRAIN_LOCAL_DB: join(home, "memory.sqlite"),
  };
  const previous = Object.fromEntries(["ORGBRAIN_FEATURES_FILE", "ORGBRAIN_WIKI_ROOT"].map(name => [name, process.env[name]]));
  const run = (...args) => JSON.parse(execFileSync(process.execPath,
    [resolve("packages/orgbrain-cli/src/local-memory.mjs"), ...args], { env, encoding: "utf8", stdio: "pipe" }));
  try {
    assert.throws(() => run("wiki", "ingest-folder", join(home, "absent")), /feature_disabled/);
    assert.deepEqual(await readdir(home), []);
    run("feature", "llm-wiki", "enable");
    run("wiki", "init");
    const docs = join(home, "docs");
    await mkdir(docs);
    for (let n = 0; n < 55; n++) await writeFile(join(docs, `資料-${String(n).padStart(2, "0")}.md`), "# 日本語\r\n検索できる根拠\r\n");
    await writeFile(join(docs, "unsupported.pdf"), "%PDF");
    const dry = run("wiki", "ingest-folder", docs, "--dry-run");
    assert.equal(dry.would_import, 55);
    assert.equal(dry.skip_reasons.unsupported_format, 1);
    assert.equal(dry.preview_truncated, true);
    assert.equal(run("wiki", "sources").sources.length, 0);
    const first = run("wiki", "ingest-folder", docs);
    assert.equal(first.imported, 55);
    assert.equal(first.skipped, 1);
    const second = run("wiki", "ingest-folder", docs);
    assert.equal(second.unchanged, 55);
    assert.equal(second.imported, 0);
    const catalog = run("wiki", "catalog", "--folder-id", first.folder_id, "--limit", "100");
    assert.equal(catalog.entries.length, 56);
    assert.equal(catalog.entries.filter(e => e.searchable).length, 55);
    assert.equal(new Set(catalog.entries.filter(e => e.source_id).map(e => e.source_id)).size, 55);
    for (const name of Object.keys(previous)) process.env[name] = env[name];
    const store = { dbPath: env.ORGBRAIN_LOCAL_DB };
    const bounded = await callWikiTool(store, "orgbrain_wiki_catalog", { folder_id: first.folder_id, token_budget: 1500 });
    assert.ok(bounded.entries.length > 0);
    assert.ok(countWikiTokens(bounded) <= 1500);
    assert.equal(bounded.next_offset, bounded.entries.length);
    const next = await callWikiTool(store, "orgbrain_wiki_catalog", { folder_id: first.folder_id, offset: bounded.next_offset, token_budget: 1500 });
    assert.notEqual(next.entries[0].path, bounded.entries[0].path);
    assert.ok(!WIKI_TOOLS.some(t => t.name === "orgbrain_wiki_ingest_folder"));
    const wiki = new WikiService();
    assert.ok((await wiki.search({ query: "検索できる根拠", scope: "sources" })).hits.length > 0);
    const original = await readFile(join(docs, "資料-00.md"));
    assert.deepEqual(original, Buffer.from("# 日本語\r\n検索できる根拠\r\n"));
    assert.ok(!(await readdir(home)).includes("memory.sqlite"));
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("OFF and ON between folder batches cancels the original import epoch", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-folder-epoch-")));
  const config = join(home, "features.json");
  const { setWikiFeature } = await import("../packages/orgbrain-cli/src/lib/wiki-service.mjs");
  await setWikiFeature(config, true);
  class Interrupted extends WikiService {
    calls = 0;
    async request(input, epoch) {
      this.calls++;
      if (this.calls === 1) {
        await setWikiFeature(config, false);
        await setWikiFeature(config, true);
        return { entries: [], next_offset: 1, scan_id: "snapshot" };
      }
      return super.request(input, epoch);
    }
  }
  try {
    const wiki = new Interrupted({ config, root: join(home, "wiki"), binary: "/nonexistent" });
    await assert.rejects(wiki.ingestFolder({ folder: join(home, "absent") }), /wiki_operation_cancelled/);
    assert.equal(wiki.calls, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
