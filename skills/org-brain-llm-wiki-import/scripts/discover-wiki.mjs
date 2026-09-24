#!/usr/bin/env node

import crypto from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONFIG = path.join(os.homedir(), ".config", "llm-wiki", "integration.json");
const PAGE_DIRECTORIES = ["wiki/topics", "wiki/comparisons"];
const MAX_PAGE_BYTES = 1024 * 1024;

function parseArgs(argv) {
  const options = { config: DEFAULT_CONFIG, vault: null, limit: 200, changedSince: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--config", "--vault", "--limit", "--changed-since"].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--config") options.config = path.resolve(value);
    if (argument === "--vault") options.vault = path.resolve(value);
    if (argument === "--limit") options.limit = Number(value);
    if (argument === "--changed-since") options.changedSince = Date.parse(value);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new Error("--limit must be an integer from 1 to 500");
  }
  if (options.changedSince !== null && !Number.isFinite(options.changedSince)) {
    throw new Error("--changed-since must be a valid ISO-8601 date");
  }
  return options;
}

async function regularFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function directoryExists(directory) {
  try {
    return (await lstat(directory)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function titleFromMarkdown(bytes, fallback) {
  const firstHeading = bytes.toString("utf8").match(/^#\s+(.+)$/mu)?.[1]?.trim();
  return firstHeading || fallback.replace(/\.md$/iu, "");
}

async function pageMetadata(vault, relativePath, changedSince) {
  const absolutePath = path.join(vault, ...relativePath.split("/"));
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile()) return { excluded: "not_regular_file" };
  if (changedSince !== null && metadata.mtimeMs < changedSince) return { excluded: "older_than_changed_since" };
  if (metadata.size > MAX_PAGE_BYTES) return { excluded: "page_too_large" };
  const bytes = await readFile(absolutePath);
  return {
    page: {
      path: relativePath,
      title: titleFromMarkdown(bytes, path.basename(relativePath)),
      sha256: hash(bytes),
      bytes: bytes.length,
      modified_at: metadata.mtime.toISOString()
    }
  };
}

async function loadConfiguredVault(configPath) {
  let bytes;
  try {
    bytes = await readFile(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { available: false, reason: "llm_wiki_not_configured" };
    throw error;
  }
  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid LLM Wiki integration JSON");
  }
  if (config?.schema_version !== 1 || typeof config.vault !== "string" || !path.isAbsolute(config.vault)) {
    throw new Error("invalid LLM Wiki integration configuration");
  }
  if (config.enabled !== true) return { available: false, reason: "llm_wiki_disabled" };
  return {
    available: true,
    vault: config.vault,
    binary: typeof config.binary === "string" && path.isAbsolute(config.binary) ? config.binary : null,
    source: "configured"
  };
}

export async function discoverWiki(options = {}) {
  const resolved = {
    config: options.config ? path.resolve(options.config) : DEFAULT_CONFIG,
    vault: options.vault ? path.resolve(options.vault) : null,
    limit: options.limit ?? 200,
    changedSince: options.changedSince ?? null
  };
  let selection;
  if (resolved.vault) {
    selection = { available: true, vault: resolved.vault, binary: null, source: "explicit" };
  } else {
    selection = await loadConfiguredVault(resolved.config);
  }
  if (!selection.available) {
    return { ok: true, available: false, reason: selection.reason, pages: [] };
  }
  if (!await directoryExists(selection.vault) || !await directoryExists(path.join(selection.vault, "wiki"))) {
    return { ok: true, available: false, reason: "llm_wiki_vault_unavailable", pages: [] };
  }

  const pages = [];
  const excluded = [];
  for (const directory of PAGE_DIRECTORIES) {
    const absoluteDirectory = path.join(selection.vault, ...directory.split("/"));
    if (!await directoryExists(absoluteDirectory)) continue;
    for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
      const relativePath = `${directory}/${entry.name}`;
      const result = await pageMetadata(selection.vault, relativePath, resolved.changedSince);
      if (result.page) pages.push(result.page);
      else excluded.push({ path: relativePath, reason: result.excluded });
    }
  }
  pages.sort((left, right) => right.modified_at.localeCompare(left.modified_at) || left.path.localeCompare(right.path));
  const truncated = pages.length > resolved.limit;
  const selectedPages = pages.slice(0, resolved.limit);
  const indexPath = "wiki/index.md";
  const index = await regularFile(path.join(selection.vault, "wiki", "index.md"))
    ? (await pageMetadata(selection.vault, indexPath, null)).page
    : null;
  return {
    ok: true,
    available: true,
    source: selection.source,
    vault: selection.vault,
    binary: selection.binary && await regularFile(selection.binary) ? selection.binary : null,
    index,
    pages: selectedPages,
    excluded,
    total_pages: pages.length,
    truncated,
    writes_performed: false
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(await discoverWiki(options), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
