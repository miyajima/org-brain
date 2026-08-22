#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goldenPath = join(root, "artifacts", "feature-surface", "recall-baseline.json");
const args = new Set(process.argv.slice(2));

function filesUnder(path, predicate = () => true) {
  const absolute = join(root, path);
  const result = [];
  for (const entry of readdirSync(absolute)) {
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) result.push(...filesUnder(relative(root, child), predicate));
    else if (predicate(child)) result.push(child);
  }
  return result;
}

function sorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function matches(text, regex, group = 1) {
  return [...text.matchAll(regex)].map((match) => match[group]).filter(Boolean);
}

function sourceFiles(path) {
  return filesUnder(path, (file) => [".ts", ".mts", ".mjs", ".astro"].includes(extname(file)));
}

function readMany(files) {
  return files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

function collectSurface() {
  const apiSources = readMany(sourceFiles("apps/api-gateway/src"));
  const localSources = readMany(sourceFiles("packages/orgbrain-cli/src"));
  const packageSources = readMany([
    ...sourceFiles("packages/contracts/src"),
    ...sourceFiles("packages/core/src")
  ]);
  const cli = readFileSync(join(root, "packages/orgbrain-cli/src/local-memory.mjs"), "utf8");
  const consolePages = filesUnder("apps/console/src/pages", (file) => extname(file) === ".astro");
  const migrations = readMany(filesUnder("migrations", (file) => extname(file) === ".sql"));
  const allSources = [...apiSources, ...localSources, ...packageSources];

  const apiRoutes = apiSources.flatMap(({ text }) =>
    [...text.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gu)]
      .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
  );
  const mcpTools = [...apiSources, ...localSources].flatMap(({ text }) =>
    matches(text, /["'`](orgbrain_[a-z0-9_]+)["'`]/gu)
  );
  const cliCommands = matches(cli, /^\s{2}(orgbrain [^\n\[]+)/gmu)
    .map((line) => line.trim().replace(/\s+$/u, ""));
  const consoleRoutes = consolePages.map((file) => {
    const path = relative(join(root, "apps/console/src/pages"), file).replace(/\.astro$/u, "");
    return `/${path.replace(/\/index$/u, "").replace(/^index$/u, "")}`.replace(/\/$/u, "/");
  });
  const capabilities = [
    ...allSources.flatMap(({ text }) => matches(text, /\bcapability\s*:\s*["'`]([a-z0-9_.:-]+)["'`]/gu)),
    ...migrations.flatMap(({ text }) => matches(text, /["']([a-z][a-z0-9_.:-]+)["']/gu))
      .filter((value) => value.includes("memory") || value.includes("context") || value.includes("domain"))
  ];
  const featureFlags = allSources.flatMap(({ text }) => [
    ...matches(text, /\benv\.([A-Z][A-Z0-9_]*(?:MODE|ENABLED|REQUIRED|FLAG))\b/gu),
    ...matches(text, /["'`]([A-Z][A-Z0-9_]*(?:MODE|ENABLED|REQUIRED|FLAG))["'`]/gu)
  ]);
  const packageExports = packageSources.flatMap(({ file, text }) => [
    ...matches(text, /^export\s+(?:type\s+)?(?:\*|\{[^}]+\})\s+from\s+["'`]([^"'`]+)["'`]/gmu)
      .map((target) => `${relative(root, file)} -> ${target}`),
    ...matches(text, /^export\s+(?:const|function|class|type|interface)\s+([A-Za-z0-9_]+)/gmu)
      .map((name) => `${relative(root, file)}#${name}`)
  ]);

  return {
    schema_version: 1,
    api_routes: sorted(apiRoutes),
    mcp_tools: sorted(mcpTools),
    cli_commands: sorted(cliCommands),
    console_routes: sorted(consoleRoutes),
    capabilities: sorted(capabilities),
    feature_flags: sorted(featureFlags),
    package_exports: sorted(packageExports)
  };
}

const surface = collectSurface();
if (args.has("--write")) {
  writeFileSync(goldenPath, `${JSON.stringify(surface, null, 2)}\n`);
  console.log(`wrote ${relative(root, goldenPath)}`);
  process.exit(0);
}

if (!args.has("--check")) {
  console.log(JSON.stringify(surface, null, 2));
  process.exit(0);
}

const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
const missing = {};
const unexpected = {};
for (const key of ["api_routes", "mcp_tools", "cli_commands", "console_routes", "capabilities", "feature_flags", "package_exports"]) {
  const current = new Set(surface[key]);
  const removed = golden[key].filter((value) => !current.has(value));
  if (removed.length > 0) missing[key] = removed;
  if (key === "api_routes") {
    const baseline = new Set(golden[key]);
    const added = surface[key].filter((value) => !baseline.has(value));
    if (added.length > 0) unexpected[key] = added;
  }
}
if (Object.keys(missing).length > 0 || Object.keys(unexpected).length > 0) {
  console.error(JSON.stringify({ error: "feature_surface_regression", missing, unexpected }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, baseline_preserved: true, api_routes_exact: true }, null, 2));
