import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("root Vitest runs exclude tests inside nested agent worktrees", async () => {
  const worktreesRoot = join(root, ".agent-worktrees");
  await mkdir(worktreesRoot, { recursive: true });
  const nestedWorktree = await mkdtemp(join(worktreesRoot, "vitest-exclude-probe-"));
  try {
    const nestedScripts = join(nestedWorktree, "scripts");
    await mkdir(nestedScripts, { recursive: true });
    await writeFile(
      join(nestedScripts, "memory-rationale-backfill.test.mjs"),
      'throw new Error("nested agent worktree test must not be collected");\n',
      "utf8"
    );

    const result = await execFileAsync(
      process.execPath,
      [
        join(root, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "./scripts/memory-rationale-backfill.test.mjs",
        "--reporter=basic"
      ],
      { cwd: root, env: { ...process.env, CI: "1" } }
    );
    assert.doesNotMatch(result.stdout + result.stderr, /nested agent worktree test must not be collected/u);
  } finally {
    await rm(nestedWorktree, { recursive: true, force: true });
  }
});
