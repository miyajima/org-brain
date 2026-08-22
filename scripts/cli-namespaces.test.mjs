import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;

test("Cloudflare-backed workspace scripts use explicit Cloudflare or local namespaces", () => {
  const cloudflareCommands = [
    "cf:memory:rationale-backfill",
    "cf:memory:maintain",
    "cf:memory:cleanup",
    "cf:memory:quality-backfill",
    "cf:memory:backfill-classification",
    "cf:memory:repair",
    "cf:memory:repair-batch",
    "cf:memory:audit",
    "cf:memory:project-snapshot",
    "cf:docs:seed",
    "cf:metrics:report",
    "cf:metrics:replay",
    "cf:metrics:rollup",
    "cf:usage:status",
    "cf:measurement:report"
  ];
  for (const command of cloudflareCommands) assert.equal(typeof scripts[command], "string", command);

  assert.match(scripts["local:memory:repair"], /--entrypoint-location=local\b/u);
  assert.match(scripts["cf:memory:repair"], /--entrypoint-location=remote\b/u);
  assert.match(scripts["cf:docs:seed"], /seed-knowledge-docs\.mjs/u);
  assert.match(scripts["local:metrics:memory-impact"], /local-memory\.mjs/u);

  const removedNames = [
    "memories:maintain",
    "memories:repair",
    "memories:repair-batch",
    "memories:audit",
    "memories:cleanup",
    "memories:quality-backfill",
    "memories:backfill-classification",
    "memories:backfill-rationales",
    "memories:project-snapshot",
    "usage:status",
    "metrics:report",
    "metrics:replay",
    "metrics:rollup",
    "metrics:memory-impact",
    "measurement:report",
    "migrations:remote-validate",
    "docs:seed"
  ];
  for (const command of removedNames) assert.equal(scripts[command], undefined, command);
});
