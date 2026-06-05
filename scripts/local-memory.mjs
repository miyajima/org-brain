#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_DB = join(homedir(), ".org-brain", "memory.sqlite");

function printHelp() {
  console.log(`Org Brain local SQLite memory

Usage:
  pnpm local:memory init
  pnpm local:memory upsert [--content <text>] [--summary <text>] [--project-id <id>] [--tag <tag>]
  pnpm local:memory search <query> [--limit <n>]
  pnpm local:memory list [--limit <n>]
  pnpm local:memory export-markdown [--limit <n>]

Environment:
  ORGBRAIN_LOCAL_DB  SQLite path (default: ~/.org-brain/memory.sqlite)

Notes:
  upsert also accepts JSON or plain text on stdin. JSON may include content, summary, project_id, tags, source, and external_key.
`);
}

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function parseArgs(argv) {
  const options = {
    command: argv[0] ?? "help",
    dbPath: process.env.ORGBRAIN_LOCAL_DB || DEFAULT_DB,
    limit: 20,
    content: "",
    summary: "",
    projectId: "",
    source: "local",
    externalKey: "",
    tags: []
  };
  const positional = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db" || arg.startsWith("--db=")) {
      options.dbPath = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      options.limit = Number.parseInt(arg.includes("=") ? arg.split("=", 2)[1] : argv[++index], 10);
    } else if (arg === "--content" || arg.startsWith("--content=")) {
      options.content = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    } else if (arg === "--summary" || arg.startsWith("--summary=")) {
      options.summary = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    } else if (arg === "--project-id" || arg.startsWith("--project-id=")) {
      options.projectId = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    } else if (arg === "--source" || arg.startsWith("--source=")) {
      options.source = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    } else if (arg === "--external-key" || arg.startsWith("--external-key=")) {
      options.externalKey = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    } else if (arg === "--tag" || arg.startsWith("--tag=")) {
      options.tags.push(arg.includes("=") ? arg.split("=", 2)[1] : argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
    } else {
      positional.push(arg);
    }
  }
  options.query = positional.join(" ");
  if (!Number.isFinite(options.limit) || options.limit <= 0) options.limit = 20;
  return options;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function runSql(dbPath, sql, args = []) {
  await mkdir(dirname(dbPath), { recursive: true });
  const { stdout } = await execFileAsync("sqlite3", args.concat([dbPath, sql]), {
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout;
}

async function initDb(dbPath) {
  await runSql(dbPath, `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  content TEXT NOT NULL,
  summary TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'local',
  external_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  content,
  summary,
  tokenize = 'unicode61'
);
CREATE UNIQUE INDEX IF NOT EXISTS memories_external_key_idx
  ON memories(source, external_key)
  WHERE external_key IS NOT NULL AND external_key != '';
`);
}

function parseInputPayload(stdinText, options) {
  if (stdinText.startsWith("{")) {
    const parsed = JSON.parse(stdinText);
    return {
      content: String(parsed.content ?? options.content ?? "").trim(),
      summary: String(parsed.summary ?? options.summary ?? "").trim(),
      projectId: String(parsed.project_id ?? parsed.projectId ?? options.projectId ?? "").trim(),
      source: String(parsed.source ?? options.source ?? "local").trim(),
      externalKey: String(parsed.external_key ?? parsed.externalKey ?? options.externalKey ?? "").trim(),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : options.tags
    };
  }
  return {
    content: String(options.content || stdinText || "").trim(),
    summary: String(options.summary ?? "").trim(),
    projectId: String(options.projectId ?? "").trim(),
    source: String(options.source ?? "local").trim(),
    externalKey: String(options.externalKey ?? "").trim(),
    tags: options.tags
  };
}

async function upsertMemory(options) {
  await initDb(options.dbPath);
  const payload = parseInputPayload(await readStdin(), options);
  if (!payload.content) throw new Error("upsert requires --content or stdin content");
  const id = randomUUID();
  const now = Date.now();
  const tagsJson = JSON.stringify([...new Set(payload.tags.filter(Boolean))]);
  const existingIdSql = payload.externalKey
    ? `(SELECT id FROM memories WHERE source = ${sqlString(payload.source)} AND external_key = ${sqlString(payload.externalKey)} LIMIT 1)`
    : "NULL";
  await runSql(options.dbPath, `
BEGIN;
DELETE FROM memories_fts WHERE id = COALESCE(${existingIdSql}, ${sqlString(id)});
INSERT INTO memories(id, project_id, content, summary, tags_json, source, external_key, created_at)
VALUES(
  COALESCE(${existingIdSql}, ${sqlString(id)}),
  ${payload.projectId ? sqlString(payload.projectId) : "NULL"},
  ${sqlString(payload.content)},
  ${payload.summary ? sqlString(payload.summary) : "NULL"},
  ${sqlString(tagsJson)},
  ${sqlString(payload.source || "local")},
  ${payload.externalKey ? sqlString(payload.externalKey) : "NULL"},
  ${now}
)
ON CONFLICT(id) DO UPDATE SET
  project_id = excluded.project_id,
  content = excluded.content,
  summary = excluded.summary,
  tags_json = excluded.tags_json,
  source = excluded.source,
  external_key = excluded.external_key;
INSERT INTO memories_fts(id, content, summary)
SELECT id, content, COALESCE(summary, '') FROM memories
WHERE id = COALESCE(${existingIdSql}, ${sqlString(id)});
COMMIT;
`);
  const writtenId = payload.externalKey ? await lookupId(options.dbPath, payload.source, payload.externalKey) : id;
  console.log(JSON.stringify({ ok: true, id: writtenId, db: options.dbPath }, null, 2));
}

async function lookupId(dbPath, source, externalKey) {
  const stdout = await runSql(dbPath, `SELECT id FROM memories WHERE source = ${sqlString(source)} AND external_key = ${sqlString(externalKey)} LIMIT 1;`, ["-json"]);
  const rows = JSON.parse(stdout || "[]");
  return rows[0]?.id ?? null;
}

function buildFtsQuery(query) {
  const tokens = String(query)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim().replace(/"/gu, ""))
    .filter((token) => token.length >= 2)
    .slice(0, 12);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token}"*`).join(" OR ");
}

async function searchMemories(options) {
  await initDb(options.dbPath);
  const ftsQuery = buildFtsQuery(options.query);
  if (!ftsQuery) throw new Error("search requires a query");
  const stdout = await runSql(options.dbPath, `
SELECT m.id, m.project_id, m.summary, substr(m.content, 1, 360) AS content_preview,
       m.tags_json, m.source, m.external_key, m.created_at, bm25(memories_fts) AS score
FROM memories_fts
JOIN memories m ON m.id = memories_fts.id
WHERE memories_fts MATCH ${sqlString(ftsQuery)}
ORDER BY score ASC, m.created_at DESC
LIMIT ${Number(options.limit)};
`, ["-json"]);
  console.log(stdout.trim() || "[]");
}

async function listMemories(options) {
  await initDb(options.dbPath);
  const stdout = await runSql(options.dbPath, `
SELECT id, project_id, summary, substr(content, 1, 360) AS content_preview,
       tags_json, source, external_key, created_at
FROM memories
ORDER BY created_at DESC
LIMIT ${Number(options.limit)};
`, ["-json"]);
  console.log(stdout.trim() || "[]");
}

async function exportMarkdown(options) {
  await initDb(options.dbPath);
  const stdout = await runSql(options.dbPath, `
SELECT id, project_id, summary, content, tags_json, source, created_at
FROM memories
ORDER BY created_at DESC
LIMIT ${Number(options.limit)};
`, ["-json"]);
  const rows = JSON.parse(stdout || "[]");
  for (const row of rows) {
    console.log(`## ${row.summary || row.id}`);
    console.log(`- id: ${row.id}`);
    if (row.project_id) console.log(`- project: ${row.project_id}`);
    console.log(`- source: ${row.source}`);
    console.log("");
    console.log(row.content);
    console.log("");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
  } else if (options.command === "init") {
    await initDb(options.dbPath);
    console.log(JSON.stringify({ ok: true, db: options.dbPath }, null, 2));
  } else if (options.command === "upsert") {
    await upsertMemory(options);
  } else if (options.command === "search") {
    await searchMemories(options);
  } else if (options.command === "list") {
    await listMemories(options);
  } else if (options.command === "export-markdown") {
    await exportMarkdown(options);
  } else {
    printHelp();
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
