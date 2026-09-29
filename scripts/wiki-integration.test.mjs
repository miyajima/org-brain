import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { handleLocalMcpRequest } from "../packages/orgbrain-cli/src/local-mcp.mjs";
import {
  setWikiFeature,
  WikiService,
  countWikiTokens,
} from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
import { callWikiTool } from "../packages/orgbrain-cli/src/lib/wiki-mcp.mjs";

test("CLI feature status and disabled Wiki never create a memory or Wiki database", async () => {
  const home = await mkdtemp(join(tmpdir(), "wiki-cli-"));
  const env = {
    ...process.env,
    ORGBRAIN_FEATURES_FILE: join(home, "features.json"),
    ORGBRAIN_WIKI_ROOT: join(home, "wiki"),
    ORGBRAIN_LOCAL_DB: join(home, "memory.sqlite"),
  };
  const cli = "packages/orgbrain-cli/src/local-memory.mjs";
  const status = JSON.parse(
    execFileSync(process.execPath, [cli, "feature", "llm-wiki", "status"], {
      env,
      encoding: "utf8",
    }),
  );
  assert.equal(status.enabled, false);
  assert.throws(
    () =>
      execFileSync(process.execPath, [cli, "wiki", "search", "test"], {
        env,
        stdio: "pipe",
      }),
    /feature_disabled/,
  );
  assert.deepEqual(await readdir(home), []);
});

test("MCP Wiki tools are hidden off, available on, and stale calls fail after disabling", async () => {
  const home = await mkdtemp(join(tmpdir(), "wiki-mcp-"));
  const previous = process.env.ORGBRAIN_FEATURES_FILE;
  process.env.ORGBRAIN_FEATURES_FILE = join(home, "features.json");
  try {
    const store = new LocalMemoryStore(join(home, "memory.sqlite"));
    const list = () => handleLocalMcpRequest(store, { method: "tools/list" });
    assert.equal(
      (await list()).tools.some((x) => x.name.startsWith("orgbrain_wiki_")),
      false,
    );
    await setWikiFeature(process.env.ORGBRAIN_FEATURES_FILE, true);
    assert.ok(
      (await list()).tools.some((x) => x.name === "orgbrain_wiki_read"),
    );
    await setWikiFeature(process.env.ORGBRAIN_FEATURES_FILE, false);
    const response = await handleLocalMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "orgbrain_wiki_put",
        arguments: { path: "x.md", content: "x" },
      },
    });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /feature_disabled/);
    assert.equal(
      (await list()).tools.some((x) => x.name === "orgbrain_context_enrich"),
      true,
    );
    await store.init();
    const context = await handleLocalMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "orgbrain_context_enrich",
        arguments: {
          tenant_id: "default",
          project_id: "wiki-test",
          task_id: "test",
          query: "knowledge",
          include_wiki: true,
          context_format: "compact",
        },
      },
    });
    assert.equal(context.isError, false);
    assert.equal(JSON.parse(context.content[0].text).wiki.status, "disabled");
  } finally {
    if (previous === undefined) delete process.env.ORGBRAIN_FEATURES_FILE;
    else process.env.ORGBRAIN_FEATURES_FILE = previous;
  }
});

test("OFF followed by ON cannot resume a suspended embedding update", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-cancel-")));
  const config = join(home, "features.json");
  await setWikiFeature(config, true);
  let release, entered;
  const gate = new Promise((r) => {
      release = r;
    }),
    ready = new Promise((r) => {
      entered = r;
    });
  class Controlled extends WikiService {
    embeddingProvider() {
      return {
        embedDocuments: async (items) => {
          entered();
          await gate;
          return items.map(() => [1, 0]);
        },
      };
    }
    async modelKey() {
      return "controlled";
    }
  }
  const service = new Controlled({ config, root: join(home, "wiki") });
  await service.request({ op: "init" });
  await service.request({ op: "put", path: "a.md", content: "# A\noriginal" });
  const job = service.reindexEmbeddings();
  await ready;
  await setWikiFeature(config, false);
  await setWikiFeature(config, true);
  release();
  await assert.rejects(job, /wiki_operation_cancelled/);
  assert.ok(
    (await service.request({ op: "embedding_pending", model: "controlled" }))
      .chunks.length > 0,
  );
});

test("Project memory context can include independent personal Wiki knowledge", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-context-")));
  const previousConfig = process.env.ORGBRAIN_FEATURES_FILE;
  const previousRoot = process.env.ORGBRAIN_WIKI_ROOT;
  process.env.ORGBRAIN_FEATURES_FILE = join(home, "features.json");
  process.env.ORGBRAIN_WIKI_ROOT = join(home, "wiki");
  try {
    await setWikiFeature(process.env.ORGBRAIN_FEATURES_FILE, true);
    const wiki = new WikiService();
    await wiki.request({ op: "init" });
    const page = await wiki.request({
      op: "put",
      path: "shared.md",
      content:
        "# Knowledge\nReusable knowledge independent of memory projects.",
    });
    const store = new LocalMemoryStore(join(home, "memory.sqlite"));
    await store.init();
    const context = await handleLocalMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "orgbrain_context_enrich",
        arguments: {
          tenant_id: "default",
          project_id: "wiki-test",
          task_id: "test",
          query: "knowledge",
          include_wiki: true,
          token_budget: 6000,
        },
      },
    });
    assert.equal(context.isError, false);
    const response = JSON.parse(context.content[0].text);
    assert.equal(response.wiki.status, "enabled");
    assert.ok(
      response.wiki.evidence.hits.some((hit) => hit.owner_id === page.page_id),
    );
  } finally {
    if (previousConfig === undefined) delete process.env.ORGBRAIN_FEATURES_FILE;
    else process.env.ORGBRAIN_FEATURES_FILE = previousConfig;
    if (previousRoot === undefined) delete process.env.ORGBRAIN_WIKI_ROOT;
    else process.env.ORGBRAIN_WIKI_ROOT = previousRoot;
  }
});

test("MCP reads and searches remain bounded, and UI/CLI/MCP update conflicts are explicit", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-bounds-")));
  const before = {
    features: process.env.ORGBRAIN_FEATURES_FILE,
    root: process.env.ORGBRAIN_WIKI_ROOT,
  };
  process.env.ORGBRAIN_FEATURES_FILE = join(home, "features.json");
  process.env.ORGBRAIN_WIKI_ROOT = join(home, "wiki");
  try {
    await setWikiFeature(process.env.ORGBRAIN_FEATURES_FILE, true);
    const wiki = new WikiService();
    await wiki.request({ op: "init" });
    const store = new LocalMemoryStore(join(home, "memory.sqlite"));
    const p = await wiki.request({
      op: "put",
      path: "long.md",
      content: "# Japanese\n" + "日本語の全文検索 ".repeat(2000),
    });
    const read = await callWikiTool(store, "orgbrain_wiki_read", {
      page_id: p.page_id,
      token_budget: 1000,
    });
    assert.ok(countWikiTokens(read) <= 1000);
    assert.equal(read.hash, p.hash);
    assert.ok(read.next_char_offset > 0);
    const search = await wiki.search({ query: "検索", token_budget: 1000 });
    assert.ok(countWikiTokens(search) <= 1000);
    const results = await Promise.allSettled([
      wiki.request({
        op: "put",
        page_id: p.page_id,
        expected_hash: p.hash,
        content: "UI update",
      }),
      callWikiTool(store, "orgbrain_wiki_put", {
        page_id: p.page_id,
        expected_hash: p.hash,
        content: "MCP update",
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(
      results.find((r) => r.status === "rejected").reason.message,
      /page_conflict/,
    );
  } finally {
    for (const [name, value] of [
      ["ORGBRAIN_FEATURES_FILE", before.features],
      ["ORGBRAIN_WIKI_ROOT", before.root],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
