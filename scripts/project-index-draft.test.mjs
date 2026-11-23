import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { draftProjectIndex } from "../packages/orgbrain-cli/src/lib/project-index-draft.mjs";
import { parseAmpPage } from "../packages/shared/src/agent-memory-protocol.mjs";

test("drafts reviewable test and development procedures without executing scripts", async t => {
  const root = await mkdtemp(join(tmpdir(), "orgbrain-index-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "dangerous command", dev: "server", "test:unit": "tests", unrelated: "ignored" } }));
  await writeFile(join(root, "pnpm-lock.yaml"), "");
  const draft = await draftProjectIndex({ root, projectId: "example" });
  assert.deepEqual(draft.procedures.map(p => p.command), ["pnpm run dev", "pnpm run test", "pnpm run test:unit"]);
  assert.ok(draft.procedures.every(p => p.verification === "not_run" && p.source.path === "package.json"));
  assert.equal(draft.saved, false);
  assert.ok(!JSON.stringify(draft).includes("dangerous command"));
  assert.equal(parseAmpPage(draft.index_markdown).kind, "project_index");
  assert.equal(draft.memories.length, 3);
  assert.deepEqual(draft.memories[0].memory.procedure, ["pnpm run dev"]);
  assert.deepEqual(draft.entries.map(entry => entry.command), draft.procedures.map(entry => entry.command));
  assert.match(draft.entries[0].source, /^package\.json sha256 [a-f0-9]{64}$/);
});

test("does not follow a package file outside the project or guess commands", async t => {
  const root = await mkdtemp(join(tmpdir(), "orgbrain-index-root-"));
  const other = await mkdtemp(join(tmpdir(), "orgbrain-index-other-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]));
  await mkdir(join(root, "project"));
  await writeFile(join(other, "package.json"), '{"scripts":{"test":"secret"}}');
  await symlink(join(other, "package.json"), join(root, "project", "package.json"));
  const draft = await draftProjectIndex({ root: join(root, "project"), projectId: "example" });
  assert.deepEqual(draft.procedures, []);
  assert.ok(draft.gaps.includes("package_json_not_regular_file"));
});

test("the CLI exposes a project-scoped, unsaved onboarding preview", async t => {
  const root = await mkdtemp(join(tmpdir(), "orgbrain-index-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"echo test"}}');
  const cli = fileURLToPath(new URL("../packages/orgbrain-cli/src/local-memory.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "project-index", "draft", "--project-id", "example"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).procedures[0].command, "npm run test");
});

test("a null scripts field produces an explicit gap", async t => {
  const root = await mkdtemp(join(tmpdir(), "orgbrain-index-null-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), '{"scripts":null}');
  const draft = await draftProjectIndex({ root, projectId: "example" });
  assert.deepEqual(draft.procedures, []);
  assert.ok(draft.gaps.includes("no_supported_scripts"));
});
