import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WikiService, setWikiFeature } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
import { waitForNativeLock } from "./helpers/wiki-lock-fixture.mjs";

test("Killing a native transaction retains history and recovers without lock removal", { skip: process.platform !== "linux" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-interruption-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  let child, db;
  try {
    await setWikiFeature(config, true);
    const binary = resolve(process.env.ORGBRAIN_WIKI_ENGINE || "packages/wiki-engine/target/debug/orgbrain-wiki-engine");
    const wiki = new WikiService({ config, root, binary });
    await wiki.request({ op: "init" });
    const before = await wiki.request({ op: "put", path: "a.md", content: "# A\ncommitted" });
    db = new DatabaseSync(join(root, "knowledge.sqlite"));
    child = spawn(binary, [root, config, "1"], { stdio: ["pipe", "ignore", "ignore"] });
    const closed = new Promise(r => child.once("close", (code, signal) => r({ code, signal })));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ op: "put", page_id: before.page_id, expected_hash: before.hash,
      content: Array.from({ length: 1500 }, (_, n) => `## Section ${n}\n${"large transaction evidence ".repeat(40)}\n`).join("") }));
    await waitForNativeLock(child, config);
    let transaction = false;
    for (let n = 0; n < 1000; n++) {
      try { db.exec("BEGIN IMMEDIATE; ROLLBACK"); }
      catch (error) { assert.match(error.message, /locked/); transaction = true; break; }
      assert.equal(child.exitCode, null, "write finished before interruption");
      await delay(1);
    }
    assert.ok(transaction, "native must own SQLite write transaction before kill");
    assert.ok(child.kill("SIGKILL")); assert.equal((await closed).signal, "SIGKILL");
    db.close(); db = null;
    // Never remove the feature lock: crash recovery is part of the assertion.
    assert.equal((await wiki.request({ op: "read", page_id: before.page_id })).hash, before.hash);
    assert.equal((await wiki.request({ op: "history", page_id: before.page_id })).revisions.length, 1);
    assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
    await wiki.request({ op: "put", path: "recovered.md", content: "write after crash" });
    await setWikiFeature(config, false);
  } finally { child?.kill("SIGKILL"); db?.close(); await rm(home, { recursive: true, force: true }); }
});
