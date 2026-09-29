import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
test("Copied release runs outside the repository without node_modules and includes the native Wiki", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-release-")));
  const install = join(home, "install");
  await mkdir(join(install, "dist"), { recursive: true });
  await cp(resolve("dist/orgbrain.mjs"), join(install, "dist/orgbrain.mjs"));
  for (const path of ["bin", "assets/wiki", "skills/org-brain-wiki"])
    await cp(resolve(path), join(install, path), { recursive: true });
  const env = {
    ...process.env,
    ORGBRAIN_FEATURES_FILE: join(home, "features.json"),
    ORGBRAIN_WIKI_ROOT: join(home, "wiki"),
    ORGBRAIN_LOCAL_DB: join(home, "memory.sqlite"),
  };
  delete env.ORGBRAIN_WIKI_ENGINE;
  const run = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [join(install, "dist/orgbrain.mjs"), ...args],
        { env, cwd: home, encoding: "utf8" },
      ),
    );
  assert.equal(run("feature", "llm-wiki", "status").enabled, false);
  run("feature", "llm-wiki", "enable");
  assert.equal(run("wiki", "init").initialized, true);
  const p = run("wiki", "put", "test.md", "--content", "# Packaged\nEvidence");
  assert.equal(run("wiki", "read", "test.md").hash, p.hash);
  const skill = run(
    "wiki",
    "install-skill",
    "--target",
    "codex",
    "--home",
    home,
    "--execute",
  );
  assert.equal(skill.applied, true);
  assert.deepEqual(
    await readFile(
      join(home, ".codex/skills/org-brain-wiki/references/architecture.md"),
    ),
    await readFile(
      join(install, "skills/org-brain-wiki/references/architecture.md"),
    ),
  );
});
