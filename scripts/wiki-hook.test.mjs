import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { setWikiFeature } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
test("Managed OrgBrain context hook injects Wiki guidance only after both opt-ins", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "wiki-owned-hook-")),
  );
  const config = join(home, "features.json");
  const env = {
    ...process.env,
    HOME: home,
    ORGBRAIN_FEATURES_FILE: config,
    ORGBRAIN_WIKI_ROOT: join(home, "wiki/personal"),
    ORGBRAIN_LOCAL_DB: join(home, "memory.sqlite"),
    ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
    ORGBRAIN_ENABLE_ORG_SHARING: "false",
  };
  const run = (mode) =>
    execFileSync(
      process.execPath,
      [
        resolve("packages/orgbrain-cli/src/local-memory.mjs"),
        "hook",
        "codex-context",
      ],
      {
        env,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          prompt: "Maintain source-backed architecture knowledge",
          mode,
        }),
        encoding: "utf8",
      },
    );
  assert.doesNotMatch(run(), /OrgBrain Knowledge Wiki/);
  await setWikiFeature(config, true, { autoMaintenance: true });
  assert.match(run(), /OrgBrain Knowledge Wiki/);
  assert.doesNotMatch(run("Plan"), /OrgBrain Knowledge Wiki/);
  await setWikiFeature(config, false);
  assert.doesNotMatch(run(), /OrgBrain Knowledge Wiki/);
  await assert.rejects(readFile(join(home, "wiki/personal/knowledge.sqlite")), {
    code: "ENOENT",
  });
});
