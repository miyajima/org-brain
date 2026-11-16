import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawn, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { constants } from "node:fs";
import { mkdtemp, realpath, lstat, rm, mkdir, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WikiService, setWikiFeature } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";

const binary = resolve(process.env.ORGBRAIN_WIKI_ENGINE || "packages/wiki-engine/target/debug/orgbrain-wiki-engine");
process.env.ORGBRAIN_WIKI_ENGINE = binary;

async function openFifoWriter(path) {
  // ENXIO means the native process has not yet opened the FIFO for reading.
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      return await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code !== "ENXIO" || performance.now() >= deadline) throw error;
      await delay(10);
    }
  }
}

test("a write can finish while a real Wiki diagnosis is still running", { skip: process.platform === "win32" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-diagnose-concurrency-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  const wiki = new WikiService({ config, root, binary });
  const original = "diagnostic fixture";
  let writer, diagnosis;
  try {
    await setWikiFeature(config, true);
    await wiki.request({ op: "init" });
    const source = await wiki.request({ op: "ingest", name: "fixture.txt", text: original });
    const object = join(root, "objects", source.hash);
    await rm(object);
    execFileSync("mkfifo", [object]);
    diagnosis = wiki.request({ op: "diagnose" });
    diagnosis.catch(() => {});
    writer = await openFifoWriter(object);
    const page = await wiki.request({ op: "put", path: "during-diagnosis.md", content: "saved" });
    assert.equal((await wiki.request({ op: "read", path: "during-diagnosis.md" })).hash, page.hash);
    await writer.writeFile(original);
    await writer.close();
    writer = null;
    const result = await diagnosis;
    assert.equal(result.integrity, "ok");
    assert.ok(!result.findings.some(finding => finding.code === "source_corrupt"));
    assert.ok(!result.findings.some(finding => finding.details?.page_id === page.page_id));
  } finally {
    await writer?.close();
    await diagnosis?.catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

test("OFF stops new operations and an admitted native write can finish", { skip: process.platform === "win32" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-disable-concurrency-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  const wiki = new WikiService({ config, root, binary });
  const input = join(home, "before-off.txt");
  let writer, ingest;
  try {
    const { epoch } = await setWikiFeature(config, true);
    await wiki.request({ op: "init" });
    execFileSync("mkfifo", [input]);
    ingest = wiki.request({ op: "ingest", file: input });
    ingest.catch(() => {});
    writer = await openFifoWriter(input);
    assert.equal((await setWikiFeature(config, false)).enabled, false);
    await assert.rejects(wiki.request({ op: "put", path: "after-off.md", content: "rejected" }), /feature_disabled/);
    await writer.writeFile("received before OFF");
    await writer.close();
    writer = null;
    const source = await ingest;
    await setWikiFeature(config, true);
    const read = await wiki.request({ op: "source_read", source_id: source.source_id });
    assert.equal(read.text, "received before OFF");
    await assert.rejects(wiki.request({ op: "pages" }, epoch), /wiki_operation_cancelled/);
  } finally {
    await writer?.close();
    await ingest?.catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

function terminateNativeChild(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

for (const mode of ["timeout", "response-limit"]) test(`wrapper ${mode} kills a native write and permits recovery`, { skip: process.platform === "win32" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-wrapper-kill-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  const input = join(home, "blocked.txt");
  let writer, child, closed, trigger;
  const realSpawn = childProcess.spawn, realTimeout = globalThis.setTimeout;
  try {
    await setWikiFeature(config, true);
    const wiki = new WikiService({ config, root, binary });
    await wiki.request({ op: "init" });
    execFileSync("mkfifo", [input]);
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
    const request = wiki.request({ op: "ingest", file: input });
    const rejected = assert.rejects(request, mode === "timeout" ? /wiki_engine_timeout/ : /wiki_response_too_large/);
    writer = await openFifoWriter(input);
    if (mode === "timeout") { assert.equal(typeof trigger, "function"); trigger(); }
    else child.stdout.emit("data", Buffer.alloc(20_000_001, 120));
    await rejected;
    assert.equal((await closed).signal, "SIGTERM");
    childProcess.spawn = realSpawn; syncBuiltinESMExports(); globalThis.setTimeout = realTimeout;
    assert.equal((await wiki.request({ op: "sources" })).sources.length, 0);
    await wiki.request({ op: "put", path: "recovered.md", content: "ok" });
    assert.equal((await wiki.request({ op: "pages" })).pages.length, 1);
    assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
    await setWikiFeature(config, false);
  } finally {
    childProcess.spawn = realSpawn; syncBuiltinESMExports(); globalThis.setTimeout = realTimeout;
    child?.kill("SIGKILL"); if (closed) await closed;
    await writer?.close();
    await rm(home, { recursive: true, force: true });
  }
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

test("parallel initialization of fresh Wikis converges on a usable database", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-parallel-init-")));
  const config = join(home, "features.json");
  try {
    await setWikiFeature(config, true);
    for (let i = 0; i < 16; i++) {
      const wiki = new WikiService({ config, root: join(home, String(i)), binary });
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => wiki.request({ op: "init" })));
      for (const result of results) {
        assert.equal(result.status, "fulfilled", result.reason?.message);
        assert.equal(result.value.initialized, true);
      }
      assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("parallel backups and exports cannot share their output directory", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-parallel-output-")));
  const config = join(home, "features.json");
  const wiki = new WikiService({ config, root: join(home, "wiki"), binary });
  try {
    await setWikiFeature(config, true);
    await wiki.request({ op: "init" });
    const output = join(home, "nested", "output");
    const results = await Promise.allSettled(["backup", "export"].map(op => wiki.request({ op, output })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.match(results.find(result => result.status === "rejected").reason.message, /output_exists/);
    const artifact = results[0].status === "fulfilled" ? "manifest.json" : "wiki";
    await lstat(join(output, artifact));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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

test("an admitted native write can finish after its Node parent exits", { skip: process.platform === "win32" }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-parent-death-")));
  const config = join(home, "features.json"), root = join(home, "wiki");
  const input = join(home, "orphan.txt");
  let writer, parent, nativePid;
  try {
    await setWikiFeature(config, true);
    const wiki = new WikiService({ config, root, binary });
    await wiki.request({ op: "init" });
    execFileSync("mkfifo", [input]);
    parent = spawn(process.execPath, [resolve("scripts/helpers/wiki-request-parent.mjs"), config, root, input], { stdio: ["ignore", "pipe", "pipe"] });
    const parentClosed = once(parent, "close");
    nativePid = Number((await once(parent.stdout, "data"))[0].toString().trim());
    assert.ok(nativePid > 0);
    writer = await openFifoWriter(input);
    parent.kill("SIGKILL");
    await parentClosed;
    await setWikiFeature(config, false);
    await writer.writeFile("parent died");
    await writer.close();
    writer = null;
    await setWikiFeature(config, true);
    // This write waits for the orphaned native's SQLite write transaction.
    await wiki.request({ op: "put", path: "after.md", content: "recovered" });
    const { sources } = await wiki.request({ op: "sources" });
    assert.equal(sources.length, 1);
    assert.equal((await wiki.request({ op: "source_read", source_id: sources[0].source_id })).text, "parent died");
    assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
  } finally {
    parent?.kill("SIGKILL");
    terminateNativeChild(nativePid);
    await writer?.close();
    await rm(home, { recursive: true, force: true });
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
