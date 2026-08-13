#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readCodexSession } from "./codex-session-hook-replay.mjs";

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function filesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
    }
  };
  visit(root);
  return files;
}

export function listCorpusSessions(sessionsRoot) {
  return filesUnder(sessionsRoot)
    .map(readCodexSession)
    .filter(Boolean)
    .filter((session) => session.threadSource === "user" && session.finals.length > 0)
    .sort((left, right) => left.startedAt - right.startedAt);
}

export function buildPrivateCorpusManifest(sessionsRoot) {
  const sessions = listCorpusSessions(sessionsRoot);
  const developmentEnd = Math.floor(sessions.length * 0.6);
  const validationEnd = Math.floor(sessions.length * 0.8);
  const entries = sessions.map((session, index) => ({
    session_hash: hash(session.id),
    source_path_hash: hash(path.resolve(session.filePath)),
    project_hash: hash(path.basename(path.resolve(session.cwd))),
    started_at: session.startedAt,
    final_answer_count: session.finals.length,
    split: index < developmentEnd ? "development" : index < validationEnd ? "validation" : "locked_test",
    annotation_state: "pending"
  }));
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    privacy: {
      raw_transcript_copied: false,
      reasoning_read: false,
      subagent_or_automation_included: false,
      text_persisted: false
    },
    counts: {
      sessions: entries.length,
      final_answers: entries.reduce((sum, entry) => sum + entry.final_answer_count, 0),
      projects: new Set(entries.map((entry) => entry.project_hash)).size,
      by_split: Object.fromEntries(["development", "validation", "locked_test"].map((split) => [
        split,
        entries.filter((entry) => entry.split === split).length
      ]))
    },
    sessions: entries
  };
}

export function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf("--sessions-root");
  const outputIndex = argv.indexOf("--output");
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.join(os.homedir(), ".codex", "sessions"));
  if (outputIndex < 0 || !argv[outputIndex + 1]) throw new Error("--output is required");
  const output = path.resolve(argv[outputIndex + 1]);
  const manifest = buildPrivateCorpusManifest(root);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(output, 0o600);
  process.stdout.write(`${JSON.stringify({ ok: true, output, counts: manifest.counts })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
