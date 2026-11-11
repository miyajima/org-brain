#!/usr/bin/env node
// Lists workspace mappings whose directory no longer exists. Read-only: it
// reports candidates for removal and never edits the configuration.
//
// Usage: node scripts/workspace-stale-entries.mjs [--file ~/.config/org-brain/workspaces.json] [--json]
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = path.join(os.homedir(), ".config", "org-brain", "workspaces.json");
const TEMPORARY_ROOT = /^\/(?:private\/)?(?:tmp|var\/folders)\//u;

export async function staleWorkspaceEntries(file = DEFAULT_FILE) {
  const workspaces = JSON.parse(await readFile(file, "utf8")).workspaces ?? {};
  const stale = [];
  for (const [root, entry] of Object.entries(workspaces)) {
    const exists = await access(root).then(() => true, () => false);
    if (exists) continue;
    stale.push({ path: root, project_id: entry?.project_id ?? null, temporary: TEMPORARY_ROOT.test(root),
      learning_mode: entry?.memory_learning_mode ?? "off" });
  }
  stale.sort((left, right) => Number(right.temporary) - Number(left.temporary) || left.path.localeCompare(right.path));
  return { file, total: Object.keys(workspaces).length, stale };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf("--file");
  staleWorkspaceEntries(fileIndex >= 0 ? path.resolve(args[fileIndex + 1] ?? "") : DEFAULT_FILE).then((report) => {
    if (args.includes("--json")) { process.stdout.write(`${JSON.stringify(report, null, 1)}\n`); return; }
    process.stdout.write(`${report.stale.length} of ${report.total} workspace entries point at a missing directory (${report.file})\n`);
    for (const entry of report.stale) {
      process.stdout.write(`${entry.temporary ? "temporary" : "missing  "}  ${entry.learning_mode.padEnd(7)} ${String(entry.project_id).padEnd(28)} ${entry.path}\n`);
    }
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
