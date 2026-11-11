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

test("Wiki maintenance guidance can be omitted when the transcript already carries it since the last compaction", async () => {
  const { writeFile } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "wiki-maintenance-once-"));
  const config = join(home, "features.json");
  const service = { config, request() { throw new Error("must_not_start_engine"); } };
  await setWikiFeature(config, true, { autoMaintenance: true });
  const guidance = (await wikiMaintenanceContext(service)).context;
  const transcript = join(home, "session.jsonl");
  const developer = { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: `other context\n\n${guidance}` }] } };
  const user = { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: guidance }] } };
  const write = (rows) => writeFile(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const prompt = { hook_event_name: "UserPromptSubmit", transcript_path: transcript };
  const once = { ORGBRAIN_HOOK_STATIC_INSTRUCTIONS: "once" };

  await write([developer]);
  assert.equal((await wikiMaintenanceContext(service, prompt, {})).context, guidance, "the default repeats the guidance");
  assert.deepEqual(await wikiMaintenanceContext(service, prompt, once), { context: "", reason: "already_delivered" });
  assert.equal((await wikiMaintenanceContext(service, { ...prompt, hook_event_name: "SessionStart" }, once)).context, guidance);
  assert.equal((await wikiMaintenanceContext(service, { hook_event_name: "UserPromptSubmit" }, once)).context, guidance, "no transcript, no evidence");
  await write([developer, { type: "compacted", payload: {} }]);
  assert.equal((await wikiMaintenanceContext(service, prompt, once)).context, guidance, "compaction removes the earlier delivery");
  await write([user]);
  assert.equal((await wikiMaintenanceContext(service, prompt, once)).context, guidance, "quoted user text is not delivery");
  assert.equal((await wikiMaintenanceContext(service, { ...prompt, mode: "plan" }, once)).context, "");
});
