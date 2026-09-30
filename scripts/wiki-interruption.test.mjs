import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WikiService,
  setWikiFeature,
} from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
test(
  "Killing a temporary native write retains a consistent committed Wiki",
  { skip: process.platform === "win32" },
  async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "wiki-interruption-")),
    );
    const config = join(home, "features.json"),
      root = join(home, "wiki");
    await setWikiFeature(config, true);
    const binary = resolve(
      `packages/orgbrain-cli/bin/${process.platform}-${process.arch}/orgbrain-wiki-engine`,
    );
    const wiki = new WikiService({ config, root, binary });
    await wiki.request({ op: "init" });
    const before = await wiki.request({
      op: "put",
      path: "a.md",
      content: "# A\ncommitted",
    });
    const child = spawn(binary, [root, config, "1"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const closed = new Promise((r) => child.once("close", r));
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        op: "put",
        page_id: before.page_id,
        expected_hash: before.hash,
        content: Array.from(
          { length: 1500 },
          (_, n) =>
            `## Section ${n}\n${"large transaction evidence ".repeat(40)}\n`,
        ).join(""),
      }),
    );
    for (let n = 0; n < 1000 && !existsSync(`${config}.lock`); n++)
      await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(child.kill("SIGKILL"));
    await closed;
    // The process is confirmed dead; remove only this fixture's empty stale lock.
    if (existsSync(`${config}.lock`)) await rmdir(`${config}.lock`);
    assert.equal(
      (await wiki.request({ op: "read", page_id: before.page_id })).hash,
      before.hash,
    );
    assert.equal(
      (await wiki.request({ op: "history", page_id: before.page_id })).revisions
        .length,
      1,
    );
    assert.equal((await wiki.request({ op: "diagnose" })).integrity, "ok");
  },
);
