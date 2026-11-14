import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Linux-only observation, not synchronization used by the product. The legacy
// directory branch keeps the regression runnable against its unfixed base.
export async function waitForNativeLock(child, config) {
  for (let n = 0; n < 500; n++) {
    assert.equal(child.exitCode, null, "native exited before acquiring its lock");
    try {
      if ((await lstat(`${config}.lock`)).isDirectory()) return;
      const locks = await readFile("/proc/locks", "utf8");
      if (locks.split("\n").some(line => / FLOCK .* WRITE /.test(line) && line.split(/\s+/)[4] === String(child.pid))) return;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error("native did not acquire fixture lock");
}
