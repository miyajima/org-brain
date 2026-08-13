#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureItemPayload,
  prepareMemoryRecordsV2
} from "../packages/orgbrain-cli/src/hook-memory-bridge.mjs";

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function usage() {
  console.log(`Codex session Stop-hook replay

Usage:
  node scripts/codex-session-hook-replay.mjs --project <id> --output <private.json> [options]

Options:
  --sessions-root <path>      Codex session root (default: ~/.codex/sessions)
  --tenant <id>              Tenant ID (default: default)
  --project <id>             Exact repository directory name to replay
  --limit-sessions <n>       Most recent matching sessions (default: 20)
  --exclude-session <id>     Exclude a session; repeatable
  --output <path>            Mode-0600 private candidate report
  --apply                    Send batches to /v1/memories/capture-rationale
  --expected-plan-hash <sha> Required with --apply
  --allow-remote             Permit an API URL other than loopback
  --help                     Show this help

Apply reads ORGBRAIN_API_URL and ORGBRAIN_API_KEY from the environment. Raw
transcripts are never written; only screened v2 candidates are persisted.
`);
}

export function parseArgs(argv) {
  const options = {
    sessionsRoot: DEFAULT_SESSIONS_ROOT,
    tenantId: "default",
    projectId: null,
    limitSessions: 20,
    excludedSessions: new Set(),
    outputPath: null,
    apply: false,
    expectedPlanHash: null,
    allowRemote: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg}_value_required`);
      index += 1;
      return next;
    };
    if (arg === "--help") return { ...options, help: true };
    if (arg === "--sessions-root") options.sessionsRoot = path.resolve(value());
    else if (arg === "--tenant") options.tenantId = value().trim();
    else if (arg === "--project") options.projectId = value().trim();
    else if (arg === "--limit-sessions") options.limitSessions = Number.parseInt(value(), 10);
    else if (arg === "--exclude-session") options.excludedSessions.add(value().trim());
    else if (arg === "--output") options.outputPath = path.resolve(value());
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--expected-plan-hash") options.expectedPlanHash = value().trim();
    else if (arg === "--allow-remote") options.allowRemote = true;
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (!options.projectId) throw new Error("project_required");
  if (!options.outputPath) throw new Error("output_required");
  if (!Number.isInteger(options.limitSessions) || options.limitSessions < 1 || options.limitSessions > 200) {
    throw new Error("limit_sessions_must_be_1_to_200");
  }
  if (options.apply && !options.expectedPlanHash) throw new Error("expected_plan_hash_required_for_apply");
  return options;
}

function listJsonlFiles(root) {
  if (!fs.existsSync(root)) throw new Error("sessions_root_not_found");
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

export function readCodexSession(filePath) {
  let meta = null;
  const finals = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    if (!line) continue;
    const isSessionMeta = /"type"\s*:\s*"session_meta"/u.test(line);
    const isFinalAnswer = /"type"\s*:\s*"agent_message"/u.test(line) &&
      /"phase"\s*:\s*"final_answer"/u.test(line);
    // Do not parse reasoning, tool, subagent, or automation payloads. The
    // historical baseline needs only session metadata and final-answer rows.
    if (!isSessionMeta && !isFinalAnswer) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type === "session_meta" && row.payload && typeof row.payload === "object") {
      meta = {
        id: String(row.payload.id ?? "").trim(),
        cwd: String(row.payload.cwd ?? "").trim(),
        startedAt: Date.parse(row.timestamp),
        threadSource: String(row.payload.thread_source ?? "").trim()
      };
      continue;
    }
    if (
      row?.type === "event_msg" &&
      row.payload?.type === "agent_message" &&
      row.payload?.phase === "final_answer"
    ) {
      const text = typeof row.payload.message === "string" ? row.payload.message.trim() : "";
      const occurredAt = Date.parse(row.timestamp);
      if (text && Number.isFinite(occurredAt)) finals.push({ text, occurredAt });
    }
  }
  if (!meta?.id || !meta.cwd || !Number.isFinite(meta.startedAt)) return null;
  return { ...meta, filePath, finals };
}

function isMatchingProject(cwd, projectId) {
  return path.basename(path.resolve(cwd)) === projectId;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function safeApiUrl(raw, allowRemote) {
  if (!raw?.trim()) throw new Error("ORGBRAIN_API_URL_required_for_apply");
  const url = new URL(raw);
  if (!allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) throw new Error("remote_api_requires_allow_remote");
  return url.toString().replace(/\/+$/u, "");
}

export async function buildPlan(options) {
  const sessions = listJsonlFiles(options.sessionsRoot)
    .map(readCodexSession)
    .filter(Boolean)
    .filter((session) => session.threadSource === "user")
    .filter((session) => isMatchingProject(session.cwd, options.projectId))
    .filter((session) => !options.excludedSessions.has(session.id))
    .filter((session) => session.finals.length > 0)
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(-options.limitSessions);

  const batches = [];
  const excludedReasonCounts = {};
  for (const session of sessions) {
    for (let index = 0; index < session.finals.length; index += 1) {
      const final = session.finals[index];
      const eventKey = `codex:session:${session.id}:stop:${index + 1}`;
      const extraction = await prepareMemoryRecordsV2({
        sourceName: "codex",
        externalKey: eventKey,
        createdAt: final.occurredAt,
        cwd: session.cwd,
        projectId: options.projectId,
        projectIdExplicit: true,
        businessCategoryId: null,
        workType: "other",
        assistantText: final.text,
        eventType: "Stop",
        metadata: { sessionId: session.id }
      }, {
        tenantId: options.tenantId,
        projectId: options.projectId,
        workspaceRoot: session.cwd,
        businessCategoryId: null,
        workType: "other",
        sensitiveMemory: { mode: "deny", allowed_principals: [] }
      }, options.tenantId);
      for (const reason of extraction.report.excluded_reasons) {
        excludedReasonCounts[reason] = (excludedReasonCounts[reason] ?? 0) + 1;
      }
      if (extraction.records.length === 0) continue;
      batches.push({
        session_id: session.id,
        turn: index + 1,
        occurred_at: final.occurredAt,
        event_key: eventKey,
        candidate_hashes: extraction.report.candidate_hashes,
        items: extraction.records.map(captureItemPayload)
      });
    }
  }
  const planCore = {
    version: 1,
    tenant_id: options.tenantId,
    project_id: options.projectId,
    source: "codex",
    session_ids: sessions.map((session) => session.id),
    batches
  };
  const planHash = sha256(JSON.stringify(planCore));
  const kindCounts = {};
  for (const batch of batches) {
    for (const item of batch.items) kindCounts[item.kind] = (kindCounts[item.kind] ?? 0) + 1;
  }
  return {
    planHash,
    planCore,
    summary: {
      sessions_scanned: sessions.length,
      completed_turns_scanned: sessions.reduce((sum, session) => sum + session.finals.length, 0),
      batches_with_candidates: batches.length,
      candidate_count: batches.reduce((sum, batch) => sum + batch.items.length, 0),
      kind_counts: kindCounts,
      excluded_reason_counts: excludedReasonCounts
    }
  };
}

async function applyPlan(plan, options) {
  if (plan.planHash !== options.expectedPlanHash) throw new Error("plan_hash_mismatch");
  const apiUrl = safeApiUrl(process.env.ORGBRAIN_API_URL, options.allowRemote);
  const apiKey = process.env.ORGBRAIN_API_KEY?.trim();
  if (!apiKey) throw new Error("ORGBRAIN_API_KEY_required_for_apply");
  const results = [];
  for (const batch of plan.planCore.batches) {
    const response = await fetch(`${apiUrl}/v1/memories/capture-rationale`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        tenant_id: options.tenantId,
        source: "codex",
        items: batch.items
      })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const code = payload?.error?.code ?? `http_${response.status}`;
      throw new Error(`capture_failed:${code}`);
    }
    results.push({
      event_key_hash: sha256(batch.event_key),
      statuses: (payload.data?.results ?? []).map((item) => ({
        status: item.status,
        reason_code: item.reason_code ?? null,
        memory_id: item.memory_id ?? null,
        rationale_id: item.rationale_id ?? null,
        decision_id: item.decision_memory_id ?? item.decision_id ?? null
      }))
    });
  }
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return;
  }
  const plan = await buildPlan(options);
  const report = {
    generated_at: Date.now(),
    mode: options.apply ? "apply" : "dry-run",
    plan_hash: plan.planHash,
    summary: plan.summary,
    plan: plan.planCore,
    results: []
  };
  writePrivateJson(options.outputPath, report);
  if (options.apply) {
    report.results = await applyPlan(plan, options);
    writePrivateJson(options.outputPath, report);
  }
  console.log(JSON.stringify({
    ok: true,
    mode: report.mode,
    plan_hash: report.plan_hash,
    summary: report.summary,
    output: options.outputPath
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
