import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { installWikiSkill } from "../packages/orgbrain-cli/src/lib/wiki-skill-install.mjs";
test("Explicit Skill install changes only the selected client and preserves external Wiki/hooks", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-install-")));
  await mkdir(join(home, ".codex/skills/llm-wiki"), { recursive: true });
  await writeFile(join(home, ".codex/skills/llm-wiki/SKILL.md"), "independent");
  await writeFile(join(home, ".codex/hooks.json"), '{"existing":"untouched"}');
  await assert.rejects(installWikiSkill({ home }), /target_required/);
  const plan = await installWikiSkill({ home, target: "codex" });
  assert.equal(plan.applied, false);
  const applied = await installWikiSkill({
    home,
    target: "codex",
    execute: true,
  });
  assert.equal(applied.applied, true);
  assert.match(
    await readFile(applied.destination, "utf8"),
    /OrgBrain Knowledge Wiki/,
  );
  for (const topic of ["architecture", "comparison", "procedure"]) {
    const relative = `references/${topic}.md`;
    assert.deepEqual(
      await readFile(join(dirname(applied.destination), relative)),
      await readFile(
        new URL(`../skills/org-brain-wiki/${relative}`, import.meta.url),
      ),
    );
  }
  const topic = join(
    dirname(applied.destination),
    "references/architecture.md",
  );
  await writeFile(topic, "user-customized guide");
  await assert.rejects(
    installWikiSkill({ home, target: "codex", execute: true }),
    /skill_already_installed/,
  );
  assert.equal(await readFile(topic, "utf8"), "user-customized guide");
  assert.equal(
    await readFile(join(home, ".codex/skills/llm-wiki/SKILL.md"), "utf8"),
    "independent",
  );
  assert.equal(
    await readFile(join(home, ".codex/hooks.json"), "utf8"),
    '{"existing":"untouched"}',
  );
});
