import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawn, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, lstat, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WikiService, setWikiFeature, wikiStatus } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";

import { waitForNativeLock as owned } from "./helpers/wiki-lock-fixture.mjs";
const binary = resolve(process.env.ORGBRAIN_WIKI_ENGINE || "packages/wiki-engine/target/debug/orgbrain-wiki-engine");
process.env.ORGBRAIN_WIKI_ENGINE = binary;

test("SIGKILL native owner: read/write/feature recover without deleting the lock", { skip: process.platform !== "linux" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-lock-recovery-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  let db, child;
  try {
    await setWikiFeature(config, true);
    const wiki = new WikiService({ config, root, binary });
    await wiki.request({ op: "init" });
    const page = await wiki.request({ op: "put", path: "a.md", content: "committed" });
    db = new DatabaseSync(join(root, "knowledge.sqlite"));
    db.exec("BEGIN IMMEDIATE"); // Native owns feature lock while blocked on this transaction.
    child = spawn(binary, [root, config, "1"], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise(r => child.once("close", (code, signal) => r({ code, signal })));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ op: "put", page_id: page.page_id, expected_hash: page.hash, content: "must roll back" }));
    await owned(child, config);
    assert.ok(child.kill("SIGKILL"));
    assert.equal((await closed).signal, "SIGKILL");
    db.exec("ROLLBACK"); db.close(); db = null;
    const results = [];
    for (const operation of [
      () => wiki.request({ op: "read", page_id: page.page_id }),
      () => wiki.request({ op: "put", path: "b.md", content: "recovered" }),
      () => setWikiFeature(config, true),
    ]) results.push((await Promise.allSettled([operation()]))[0]);
    console.log("post-SIGKILL read/write/feature:", results.map(r => r.status === "fulfilled" ? "ok" : r.reason.message));
    assert.deepEqual(results.map(r => r.status), ["fulfilled", "fulfilled", "fulfilled"]);
    assert.equal(results[0].value.hash, page.hash);
    assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
  } finally {
    child?.kill("SIGKILL"); db?.close();
    await rm(home, { recursive: true, force: true });
  }
});

for (const mode of ["timeout", "response-limit"]) test(`wrapper ${mode} kills the real lock owner and permits recovery`, { skip: process.platform !== "linux" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-wrapper-kill-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  let db, child, closed, trigger;
  const realSpawn = childProcess.spawn, realTimeout = globalThis.setTimeout;
  try {
    await setWikiFeature(config, true);
    const wiki = new WikiService({ config, root, binary });
    await wiki.request({ op: "init" });
    db = new DatabaseSync(join(root, "knowledge.sqlite")); db.exec("BEGIN IMMEDIATE");
    childProcess.spawn = (...args) => {
      child = realSpawn(...args);
      closed = new Promise(r => child.once("close", (code, signal) => r({ code, signal })));
      return child;
    };
    syncBuiltinESMExports();
    // Deterministically fire the real production timeout callback, without
    // adding a production override or reducing its 120-second configured limit.
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms === 120_000) { trigger = callback; return realTimeout(callback, ms, ...args); }
      return realTimeout(callback, ms, ...args);
    };
    const request = wiki.request({ op: "put", path: "killed.md", content: "not committed" });
    const rejected = assert.rejects(request, mode === "timeout" ? /wiki_engine_timeout/ : /wiki_response_too_large/);
    while (!child) await delay(1);
    await owned(child, config);
    if (mode === "timeout") { assert.equal(typeof trigger, "function"); trigger(); }
    else child.stdout.emit("data", Buffer.alloc(20_000_001, 120));
    await rejected;
    assert.equal((await closed).signal, "SIGTERM");
    childProcess.spawn = realSpawn; syncBuiltinESMExports(); globalThis.setTimeout = realTimeout;
    db.exec("ROLLBACK"); db.close(); db = null;
    await wiki.request({ op: "put", path: "recovered.md", content: "ok" });
    assert.equal((await wiki.request({ op: "pages" })).pages.length, 1);
    assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
    await setWikiFeature(config, false);
  } finally {
    childProcess.spawn = realSpawn; syncBuiltinESMExports(); globalThis.setTimeout = realTimeout;
    child?.kill("SIGKILL"); if (closed) await closed;
    db?.close(); await rm(home, { recursive: true, force: true });
  }
});

test("live native owner is not stolen: storage and Node feature updates return bounded busy", { skip: process.platform !== "linux" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-live-lock-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  let child, db, closed;
  try {
    await setWikiFeature(config, true);
    const wiki = new WikiService({ config, root, binary }); await wiki.request({ op: "init" });
    db = new DatabaseSync(join(root, "knowledge.sqlite")); db.exec("BEGIN IMMEDIATE");
    child = spawn(binary, [root, config, "1"], { stdio: ["pipe", "ignore", "ignore"] });
    closed = once(child, "close"); child.stdin.end(JSON.stringify({ op: "put", path: "held.md", content: "held" }));
    await owned(child, config); child.kill("SIGSTOP");
    const started = performance.now();
    await Promise.all([
      assert.rejects(wiki.request({ op: "pages" }), /wiki_busy/),
      assert.rejects(setWikiFeature(config, false), /wiki_busy/),
    ]);
    assert.ok(performance.now() - started >= 4500 && performance.now() - started < 9000);
    assert.equal((await wikiStatus(config)).enabled, true);
    child.kill("SIGKILL"); await closed;
    db.exec("ROLLBACK"); db.close(); db = null;
    await setWikiFeature(config, false);
  } finally { child?.kill("SIGKILL"); if (closed) await closed; db?.close(); await rm(home, { recursive: true, force: true }); }
});

test("parallel native writers preserve hash conflicts, history and integrity", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-parallel-writers-")));
  try {
    const config = join(home, "features.json"), wiki = new WikiService({ config, root: join(home, "wiki"), binary });
    await setWikiFeature(config, true); await wiki.request({ op: "init" });
    const page = await wiki.request({ op: "put", path: "same.md", content: "before" });
    const edits = await Promise.allSettled(["one", "two"].map(content => wiki.request({ op: "put", page_id: page.page_id, expected_hash: page.hash, content })));
    assert.equal(edits.filter(x => x.status === "fulfilled").length, 1);
    assert.match(edits.find(x => x.status === "rejected").reason.message, /conflict/);
    assert.equal((await wiki.request({ op: "history", page_id: page.page_id })).revisions.length, 2);
    await Promise.all(Array.from({ length: 8 }, (_, n) => wiki.request({ op: "put", path: `parallel-${n}.md`, content: `writer ${n}` })));
    assert.equal((await wiki.request({ op: "pages" })).pages.length, 9);
    assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("native write excludes disable, and no old-epoch commit follows completed disable", { skip: process.platform !== "linux" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-disable-lock-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  let db, child, closed;
  try {
    await setWikiFeature(config, true); const wiki = new WikiService({ config, root, binary }); await wiki.request({ op: "init" });
    db = new DatabaseSync(join(root, "knowledge.sqlite")); db.exec("BEGIN IMMEDIATE");
    child = spawn(binary, [root, config, "1"], { stdio: ["pipe", "pipe", "pipe"] }); closed = once(child, "close");
    child.stdin.end(JSON.stringify({ op: "put", path: "before-off.md", content: "commits before disable" }));
    await owned(child, config);
    let disabled = false; const disable = setWikiFeature(config, false).then(value => { disabled = true; return value; });
    await delay(100); assert.equal(disabled, false); assert.equal((await wikiStatus(config)).enabled, true);
    db.exec("ROLLBACK"); db.close(); db = null;
    assert.equal((await closed)[0], 0); assert.equal((await disable).epoch, 2);
    const stale = spawn(binary, [root, config, "1"], { stdio: ["pipe", "pipe", "pipe"] });
    const staleOut = []; stale.stdout.on("data", b => staleOut.push(b)); const staleClose = once(stale, "close");
    stale.stdin.end(JSON.stringify({ op: "put", path: "after-off.md", content: "must not commit" }));
    assert.equal((await staleClose)[0], 1); assert.match(Buffer.concat(staleOut).toString(), /feature_disabled/);
    await setWikiFeature(config, true);
    assert.equal((await wiki.request({ op: "pages" })).pages.length, 1);
    assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
  } finally { child?.kill("SIGKILL"); if (closed) await closed; db?.close(); await rm(home, { recursive: true, force: true }); }
});

test("legacy directory and old Node mkdir clients fail closed against the new protocol", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-legacy-")));
  const config = join(home, "features.json");
  try {
    await mkdir(`${config}.lock`);
    await assert.rejects(setWikiFeature(config, true), /wiki_busy: legacy directory lock/);
    assert.ok((await lstat(`${config}.lock`)).isDirectory());
    // Fixture-only migration, after no clients have been started.
    await rm(`${config}.lock`, { recursive: true }); await setWikiFeature(config, true);
    await assert.rejects(mkdir(`${config}.lock`), { code: "EEXIST" });
    const before = await lstat(`${config}.lock`); await setWikiFeature(config, false);
    assert.equal((await lstat(`${config}.lock`)).ino, before.ino);
    assert.ok((await lstat(`${config}.lock`)).isFile());
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Node parent death does not drop its live native child's lock before commit", { skip: process.platform !== "linux" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-parent-death-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  let db, parent, nativePid;
  try {
    await setWikiFeature(config, true); const wiki = new WikiService({ config, root, binary }); await wiki.request({ op: "init" });
    db = new DatabaseSync(join(root, "knowledge.sqlite")); db.exec("BEGIN IMMEDIATE");
    parent = spawn(process.execPath, [resolve("scripts/helpers/wiki-request-parent.mjs"), config, root], { stdio: ["ignore", "pipe", "pipe"] });
    const parentClosed = once(parent, "close");
    nativePid = Number((await once(parent.stdout, "data"))[0].toString().trim()); assert.ok(nativePid > 0);
    await owned({ pid: nativePid, exitCode: null }, config);
    parent.kill("SIGKILL"); await parentClosed;
    let disabled = false; const disable = setWikiFeature(config, false).then(value => { disabled = true; return value; });
    await delay(100); assert.equal(disabled, false);
    db.exec("ROLLBACK"); db.close(); db = null;
    await disable; await setWikiFeature(config, true);
    assert.equal((await wiki.request({ op: "read", path: "orphan.md" })).content, "parent died");
    assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
  } finally {
    parent?.kill("SIGKILL");
    if (nativePid) { try { process.kill(nativePid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    db?.close(); await rm(home, { recursive: true, force: true });
  }
});

for (const death of ["child", "parent"]) test(`Node feature-set ${death} termination cannot strand exclusion or corrupt config`, { skip: process.platform !== "linux" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-feature-death-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  let db, holder, holderClosed, parent, nativePid;
  try {
    await setWikiFeature(config, true); const wiki = new WikiService({ config, root, binary }); await wiki.request({ op: "init" });
    db = new DatabaseSync(join(root, "knowledge.sqlite")); db.exec("BEGIN IMMEDIATE");
    holder = spawn(binary, [root, config, "1"], { stdio: ["pipe", "ignore", "ignore"] }); holderClosed = once(holder, "close");
    holder.stdin.end(JSON.stringify({ op: "put", path: "blocked.md", content: "no" })); await owned(holder, config);
    parent = spawn(process.execPath, [resolve("scripts/helpers/wiki-request-parent.mjs"), config, root, "feature"], { stdio: ["ignore", "pipe", "pipe"] });
    const parentClosed = once(parent, "close");
    nativePid = Number((await once(parent.stdout, "data"))[0].toString().trim()); assert.ok(nativePid > 0);
    // The native feature child waits on the same live storage Guard, not a JS lock.
    if (death === "child") process.kill(nativePid, "SIGKILL"); else parent.kill("SIGKILL");
    await parentClosed;
    assert.equal((await wikiStatus(config)).epoch, 1);
    holder.kill("SIGKILL"); await holderClosed; db.exec("ROLLBACK"); db.close(); db = null;
    if (death === "parent") {
      for (let n = 0; n < 500 && (await wikiStatus(config)).enabled; n++) await delay(10);
      assert.equal((await wikiStatus(config)).enabled, false);
      assert.equal((await wikiStatus(config)).epoch, 2);
    }
    await setWikiFeature(config, true);
    assert.ok((await lstat(`${config}.lock`)).isFile());
    await wiki.request({ op: "put", path: "after.md", content: "recovered" });
    assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
  } finally {
    holder?.kill("SIGKILL"); if (holderClosed) await holderClosed;
    parent?.kill("SIGKILL");
    if (nativePid) { try { process.kill(nativePid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    db?.close(); await rm(home, { recursive: true, force: true });
  }
});

test("new Node rejects an old native feature protocol without mkdir fallback", { skip: process.platform === "win32" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-old-engine-")));
  const previous = process.env.ORGBRAIN_WIKI_ENGINE;
  try {
    const old = join(home, "old-engine");
    await writeFile(old, `#!${process.execPath}\nconsole.log(JSON.stringify({error:"expected root, features file and epoch"})); process.exitCode=1;\n`, { mode: 0o700 });
    process.env.ORGBRAIN_WIKI_ENGINE = old;
    await assert.rejects(setWikiFeature(join(home, "features.json"), true), /wiki_engine_feature_set_unsupported/);
    await assert.rejects(lstat(join(home, "features.json.lock")), { code: "ENOENT" });
    await assert.rejects(lstat(join(home, "features.json")), { code: "ENOENT" });
  } finally { process.env.ORGBRAIN_WIKI_ENGINE = previous; await rm(home, { recursive: true, force: true }); }
});

test("fixture CLI enable/init/put/read/search/disable uses matching native", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-cli-lock-")));
  try {
    const env = { ...process.env, ORGBRAIN_FEATURES_FILE: join(home, "features.json"), ORGBRAIN_WIKI_ROOT: join(home, "wiki"), ORGBRAIN_LOCAL_DB: join(home, "memory.sqlite"), ORGBRAIN_WIKI_ENGINE: binary };
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, ["packages/orgbrain-cli/src/local-memory.mjs", ...args], { env, encoding: "utf8" }));
    assert.equal(cli("feature", "llm-wiki", "enable").epoch, 1);
    assert.equal(cli("wiki", "init").initialized, true);
    const page = cli("wiki", "put", "smoke.md", "--content", "# Smoke\nlocal lock evidence");
    assert.equal(cli("wiki", "read", "smoke.md").hash, page.hash);
    assert.ok(cli("wiki", "search", "evidence").hits.length > 0);
    assert.equal(cli("wiki", "diagnose").integrity, "ok");
    assert.equal(cli("feature", "llm-wiki", "disable").enabled, false);
    await assert.rejects(lstat(join(home, "memory.sqlite")), { code: "ENOENT" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
