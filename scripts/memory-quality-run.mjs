#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const markerName = "bundle-marker.json";
function option(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; }
function resolveRun(argv) {
  const runId = option(argv, "--run-id");
  if (!runId || !/^[a-zA-Z0-9._-]+$/u.test(runId)) throw new Error("a safe --run-id is required");
  const root = path.resolve(option(argv, "--quality-root") || path.join(process.cwd(), ".local", "memory-quality"));
  const target = path.resolve(root, runId);
  if (path.dirname(target) !== root || fs.lstatSync(target).isSymbolicLink()) throw new Error("quality run target escapes its root or is a symlink");
  const marker = JSON.parse(fs.readFileSync(path.join(target, markerName), "utf8"));
  if (marker.kind !== "orgbrain-memory-quality-private-run" || marker.run_id !== runId) throw new Error("quality run marker mismatch");
  return target;
}

export function viewQualityRun(argv) {
  const target = resolveRun(argv);
  return JSON.parse(fs.readFileSync(path.join(target, "report.json"), "utf8"));
}

export function disposeQualityRun(argv) {
  const target = resolveRun(argv);
  fs.rmSync(target, { recursive: true, force: false });
  return { disposed: true, recoverable: false, target };
}

export function main(argv = process.argv.slice(2)) {
  const result = argv.includes("--dispose") ? disposeQualityRun(argv) : viewQualityRun(argv);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
