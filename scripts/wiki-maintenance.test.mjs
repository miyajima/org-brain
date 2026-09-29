import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wikiMaintenanceContext } from "../packages/orgbrain-cli/src/lib/wiki-maintenance.mjs";
import { setWikiFeature } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
test("Wiki maintenance injects bounded guidance only with both opt-ins and respects Plan/Ask", async () => {
  const home = await mkdtemp(join(tmpdir(), "wiki-maintenance-"));
  const config = join(home, "features.json");
  const service = {
    config,
    request() {
      throw new Error("must_not_start_engine");
    },
  };
  assert.equal((await wikiMaintenanceContext(service)).context, "");
  assert.deepEqual(await readdir(home), []);
  await setWikiFeature(config, true);
  assert.equal((await wikiMaintenanceContext(service)).context, "");
  await setWikiFeature(config, true, { autoMaintenance: true });
  assert.ok((await wikiMaintenanceContext(service)).context.length < 2000);
  for (const mode of ["Plan", "Ask", "read-only"])
    assert.equal((await wikiMaintenanceContext(service, { mode })).context, "");
  await setWikiFeature(config, false);
  assert.equal((await wikiMaintenanceContext(service)).context, "");
});
