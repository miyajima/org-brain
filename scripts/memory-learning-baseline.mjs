#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareMemoryRecordsV2 } from "../packages/orgbrain-cli/src/hook-memory-bridge.mjs";
import { listCorpusSessions } from "./memory-learning-corpus.mjs";

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export async function evaluateStrictBaseline(sessionsRoot, tenantId = "default") {
  const sessions = listCorpusSessions(sessionsRoot);
  const reasonCounts = new Map();
  const projectCounts = new Map();
  let finalAnswers = 0;
  let candidateCount = 0;
  let turnsWithCandidates = 0;
  for (const session of sessions) {
    const projectId = path.basename(path.resolve(session.cwd));
    const projectHash = hash(projectId);
    const project = projectCounts.get(projectHash) ?? { sessions: 0, final_answers: 0, candidate_count: 0 };
    project.sessions += 1;
    for (const [index, final] of session.finals.entries()) {
      finalAnswers += 1;
      project.final_answers += 1;
      const result = await prepareMemoryRecordsV2({
        sourceName: "codex",
        externalKey: `baseline:${hash(session.id)}:${index + 1}`,
        createdAt: final.occurredAt,
        cwd: session.cwd,
        projectId,
        projectIdExplicit: true,
        businessCategoryId: null,
        workType: "other",
        assistantText: final.text,
        eventType: "BaselineReplay",
        metadata: { sessionHash: hash(session.id) }
      }, {
        tenantId,
        projectId,
        businessCategoryId: null,
        workType: "other",
        workspaceRoot: session.cwd,
        sensitiveMemory: { mode: "deny", allowed_principals: [] }
      }, tenantId);
      candidateCount += result.records.length;
      project.candidate_count += result.records.length;
      if (result.records.length > 0) turnsWithCandidates += 1;
      for (const reason of result.report.excluded_reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
    projectCounts.set(projectHash, project);
  }
  return {
    schema_version: 1,
    extractor_profile: "strict-gold-v1",
    privacy: {
      raw_transcript_copied: false,
      text_persisted: false,
      candidate_content_persisted: false,
      reasoning_read: false
    },
    counts: {
      sessions: sessions.length,
      final_answers: finalAnswers,
      projects: projectCounts.size,
      turns_with_candidates: turnsWithCandidates,
      candidate_count: candidateCount
    },
    excluded_reason_counts: Object.fromEntries([...reasonCounts.entries()].sort()),
    projects: Object.fromEntries([...projectCounts.entries()].sort())
  };
}

export async function main(argv = process.argv.slice(2)) {
  const sessionsRoot = path.resolve(option(argv, "--sessions-root", path.join(os.homedir(), ".codex", "sessions")));
  const outputValue = option(argv, "--output");
  if (!outputValue) throw new Error("--output is required");
  const output = path.resolve(outputValue);
  const report = await evaluateStrictBaseline(sessionsRoot, option(argv, "--tenant", "default"));
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(output, 0o600);
  process.stdout.write(`${JSON.stringify({ ok: true, output, counts: report.counts })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
