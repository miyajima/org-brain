import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalMemoryStore } from "./lib/local-memory-store.mjs";
import {
  installPersonalMaintenance,
  personalMaintenancePlan,
  personalMaintenanceStatus,
  runLocalMaintenance,
  uninstallPersonalMaintenance
} from "./personal-maintenance.mjs";

test("daily personal maintenance plan is local-only and contains no LLM or MCP command", () => {
  const plan = personalMaintenancePlan({
    home: "/tmp/orgbrain-maintenance-home",
    command: "/opt/orgbrain",
    dbPath: "/tmp/orgbrain.sqlite"
  });

  assert.equal(plan.schedule, "daily");
  assert.equal(plan.llm_calls, 0);
  assert.equal(plan.cloud_writes, 0);
  assert.deepEqual(plan.program_arguments.slice(0, 5), [
    "/opt/orgbrain",
    "maintenance",
    "run",
    "--apply",
    "--tenant-id"
  ]);
  assert.ok(plan.program_arguments.includes("/tmp/orgbrain.sqlite"));
  assert.doesNotMatch(plan.plist, /\bmcp\b|openai|anthropic|cloudflare/iu);
  assert.match(plan.plist, /<key>StartCalendarInterval<\/key>/u);
});

test("local maintenance suppresses old duplicates without deletion and is idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orgbrain-personal-maintenance-"));
  const store = new LocalMemoryStore(path.join(directory, "memory.sqlite"));
  const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
  for (const index of [0, 1]) {
    await store.capture({
      tenant_id: "default",
      project_id: "example",
      content: "Use the verified release checklist before deployment and confirm that every package test passed.",
      summary: "example | diagnosis | use the verified release checklist before deployment",
      tags: ["codex", "hook", "promoted", "success"],
      source: "codex",
      external_key: `codex:duplicate-${index}`,
      created_at: old + index
    });
  }
  await store.capture({
    tenant_id: "default",
    project_id: "example",
    content: "Use the verified release checklist before deployment and confirm that every package test passed.",
    summary: "example | diagnosis | use the verified release checklist before deployment",
    tags: ["manual", "success"],
    source: "manual",
    external_key: "manual:duplicate",
    created_at: old
  });

  const preview = await runLocalMaintenance(store, { tenantId: "default", now: Date.now() });
  assert.equal(preview.apply_requested, false);
  assert.equal(preview.planned.duplicate_compaction_count, 1);

  const applied = await runLocalMaintenance(store, { tenantId: "default", now: Date.now(), apply: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied_counts.suppressed, 1);
  const rows = [];
  for await (const memory of store.export("default", "example")) rows.push(memory);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((memory) => memory.lifecycle_state === "suppressed").length, 1);
  assert.equal(rows.find((memory) => memory.source === "manual").lifecycle_state, "active");

  const repeated = await runLocalMaintenance(store, { tenantId: "default", now: Date.now(), apply: true });
  assert.equal(repeated.applied_counts.suppressed, 0);
  assert.equal(repeated.planned.duplicate_compaction_count, 0);
});

test("local maintenance creates canonical memory once for distinct durable guidance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orgbrain-personal-canonical-"));
  const store = new LocalMemoryStore(path.join(directory, "memory.sqlite"));
  const old = Date.now() - 4 * 24 * 60 * 60 * 1000;
  const records = [
    ["Run `pnpm test` before publishing the package.", "package tests require pnpm test"],
    ["Run `npm pack --dry-run` to verify packaged files.", "package contents require npm pack dry run"]
  ];
  for (const [index, [content, summary]] of records.entries()) {
    await store.capture({
      tenant_id: "default",
      project_id: "example",
      content,
      summary,
      tags: ["codex", "hook", "promoted", "success"],
      source: "codex",
      external_key: `codex:canonical-${index}`,
      created_at: old + index
    });
  }

  const first = await runLocalMaintenance(store, { tenantId: "default", now: Date.now(), apply: true });
  assert.equal(first.planned.canonical_memory_count, 1);
  assert.equal(first.applied_counts.synthesized, 1);
  const second = await runLocalMaintenance(store, { tenantId: "default", now: Date.now(), apply: true });
  assert.equal(second.applied_counts.synthesized, 0);
});

test("LaunchAgent installation is private, loaded, idempotent, and recoverably removable", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "orgbrain-launch-agent-"));
  const plan = personalMaintenancePlan({ home, command: "/opt/orgbrain" });
  let loaded = false;
  const calls = [];
  const runner = async (_executable, args) => {
    calls.push(args);
    if (args[0] === "print") return { code: loaded ? 0 : 113, stdout: "", stderr: "" };
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
    return { code: 0, stdout: "", stderr: "" };
  };

  const first = await installPersonalMaintenance(plan, { platform: "darwin", uid: 501, runner });
  assert.equal(first.loaded, true);
  assert.equal(first.changed, true);
  assert.equal((await stat(plan.files.plist)).mode & 0o777, 0o600);
  assert.equal((await stat(plan.files.stdout)).mode & 0o777, 0o600);
  assert.equal((await stat(plan.files.stderr)).mode & 0o777, 0o600);
  assert.match(await readFile(plan.files.plist, "utf8"), /com\.orgbrain\.personal-maintenance/u);

  const bootstrapCount = calls.filter((args) => args[0] === "bootstrap").length;
  const repeated = await installPersonalMaintenance(plan, { platform: "darwin", uid: 501, runner });
  assert.equal(repeated.changed, false);
  assert.equal(calls.filter((args) => args[0] === "bootstrap").length, bootstrapCount);

  const status = await personalMaintenanceStatus(plan, { platform: "darwin", uid: 501, runner });
  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);

  const removed = await uninstallPersonalMaintenance(plan, { platform: "darwin", uid: 501, runner });
  assert.equal(removed.installed, false);
  assert.ok(removed.backup);
  await assert.rejects(readFile(plan.files.plist, "utf8"), { code: "ENOENT" });
  assert.match(await readFile(removed.backup, "utf8"), /com\.orgbrain\.personal-maintenance/u);
});
