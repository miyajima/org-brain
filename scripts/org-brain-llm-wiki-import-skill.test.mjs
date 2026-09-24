import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverWiki } from "../skills/org-brain-llm-wiki-import/scripts/discover-wiki.mjs";

test("optional LLM Wiki discovery is a successful no-op when configuration is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-wiki-absent-"));
  try {
    const result = await discoverWiki({ config: path.join(root, "missing.json") });
    assert.deepEqual(result, {
      ok: true,
      available: false,
      reason: "llm_wiki_not_configured",
      pages: []
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional LLM Wiki discovery skips disabled and unavailable vaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-wiki-disabled-"));
  try {
    const config = path.join(root, "integration.json");
    await writeFile(config, JSON.stringify({ schema_version: 1, enabled: false, vault: path.join(root, "vault") }));
    assert.equal((await discoverWiki({ config })).reason, "llm_wiki_disabled");
    await writeFile(config, JSON.stringify({ schema_version: 1, enabled: true, vault: path.join(root, "missing") }));
    assert.equal((await discoverWiki({ config })).reason, "llm_wiki_vault_unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional LLM Wiki discovery returns only bounded synthesized pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-wiki-pages-"));
  try {
    const vault = path.join(root, "vault");
    await mkdir(path.join(vault, "wiki", "topics"), { recursive: true });
    await mkdir(path.join(vault, "wiki", "comparisons"), { recursive: true });
    await mkdir(path.join(vault, "raw"), { recursive: true });
    await writeFile(path.join(vault, "wiki", "index.md"), "# Index\n");
    await writeFile(path.join(vault, "wiki", "log.md"), "# Log\nsecret history\n");
    await writeFile(path.join(vault, "wiki", "topics", "decision.md"), "# Confirmed decision\nUse bounded imports.\n");
    await writeFile(path.join(vault, "wiki", "comparisons", "options.md"), "# Options\nCompare A and B.\n");
    await writeFile(path.join(vault, "raw", "source.md"), "raw source\n");
    if (process.platform !== "win32") {
      await symlink(path.join(vault, "raw", "source.md"), path.join(vault, "wiki", "topics", "linked.md"));
    }
    const config = path.join(root, "integration.json");
    await writeFile(config, JSON.stringify({ schema_version: 1, enabled: true, vault }));

    const result = await discoverWiki({ config, limit: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.available, true);
    assert.equal(result.writes_performed, false);
    assert.equal(result.total_pages, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.pages.length, 1);
    assert.ok(result.pages[0].path.startsWith("wiki/"));
    assert.equal(result.pages[0].sha256.length, 64);
    assert.equal(result.index.path, "wiki/index.md");
    assert.doesNotMatch(JSON.stringify(result.pages), /raw\/|log\.md|linked\.md/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
