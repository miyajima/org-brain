#!/usr/bin/env node
// Explicit, local-only snapshot. Existing runs are never overwritten.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function freezeRouterRun(destination) {
  const root = process.cwd();
  const output = path.resolve(destination);
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
    .split("\0").filter((file) => file && !file.startsWith("artifacts/")
      && /(?:memory-extraction|turn-evidence|hook-memory-bridge|(?:^|\/)package\.json$|pnpm-lock\.yaml$)/u.test(file));
  const entries = [];
  for (const file of [...new Set(files)].sort()) {
    const bytes = fs.readFileSync(path.join(root, file));
    const target = path.join(output, "source", file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    entries.push({ file, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = { contract: "router-revision-snapshot/v1", generated_at: new Date().toISOString(),
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), files: entries,
    default_router: "v2", network: false, labels_modified: false };
  fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { files: entries.length, output };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("snapshot_destination_required");
  console.log(JSON.stringify(freezeRouterRun(process.argv[2])));
}
