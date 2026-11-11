import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { staleWorkspaceEntries } from "./workspace-stale-entries.mjs";

test("stale workspace entries are listed without changing the configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orgbrain-stale-workspaces-"));
  try {
    const present = path.join(directory, "present");
    await mkdir(present);
    const file = path.join(directory, "workspaces.json");
    const config = { version: 3, workspaces: {
      [present]: { tenant_id: "default", project_id: "present", memory_learning_mode: "eager" },
      // The fixture directory is itself under a temporary root, so the ordinary missing entry uses another path.
      "/nonexistent-orgbrain-fixture/removed": { tenant_id: "default", project_id: "removed", memory_learning_mode: "off" },
      "/private/tmp/orgbrain-e2e-run/app": { tenant_id: null, project_id: "app" }
    } };
    const text = JSON.stringify(config);
    await writeFile(file, text);
    const report = await staleWorkspaceEntries(file);
    assert.equal(report.total, 3);
    assert.deepEqual(report.stale.map((entry) => [entry.project_id, entry.temporary, entry.learning_mode]),
      [["app", true, "off"], ["removed", false, "off"]]);
    assert.equal(await (await import("node:fs/promises")).readFile(file, "utf8"), text, "the report never rewrites the file");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
