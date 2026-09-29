import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WikiService,
  setWikiFeature,
  wikiStatus,
} from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";

test("Wiki defaults to off without creating a database or starting the engine", async () => {
  const home = await mkdtemp(join(tmpdir(), "wiki-off-"));
  const config = join(home, "features.json");
  const wiki = new WikiService({
    config,
    root: join(home, "wiki"),
    binary: "/nonexistent-engine",
  });
  assert.equal((await wikiStatus(config)).enabled, false);
  await assert.rejects(
    wiki.request({ op: "search", query: "test" }),
    /feature_disabled/,
  );
  assert.deepEqual(await readdir(home), []);
});

test("Feature switching preserves unrelated settings and external Wiki content", async () => {
  const home = await mkdtemp(join(tmpdir(), "wiki-feature-"));
  const config = join(home, "features.json");
  const external = join(home, "external.md");
  await writeFile(
    config,
    JSON.stringify({ features: { other: { enabled: true } }, custom: 17 }),
  );
  await writeFile(external, "original\r\n");
  await setWikiFeature(config, true);
  assert.equal((await wikiStatus(config)).enabled, true);
  const first = (await wikiStatus(config)).epoch;
  await setWikiFeature(config, false);
  await setWikiFeature(config, true);
  assert.ok((await wikiStatus(config)).epoch > first);
  const settings = JSON.parse(await readFile(config, "utf8"));
  assert.equal(settings.features.other.enabled, true);
  assert.equal(settings.custom, 17);
  assert.equal(await readFile(external, "utf8"), "original\r\n");
  await assert.rejects(
    readFile(join(home, "wiki", "knowledge.sqlite")),
    /ENOENT/,
  );
});

test("Malformed settings are an error, not silently treated as a disabled feature", async () => {
  const home = await mkdtemp(join(tmpdir(), "wiki-config-"));
  const config = join(home, "features.json");
  await writeFile(config, "{");
  await assert.rejects(wikiStatus(config), /invalid_feature_config/);
});
