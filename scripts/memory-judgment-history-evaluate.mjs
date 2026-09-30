#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readdir, stat, mkdir, writeFile, open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createMemoryJudge, createOpenRouterMemoryTransport, redactJudgmentValue } from "../packages/shared/src/memory-judgment-runtime.mjs";
import { memoryJudgmentCandidate } from "../packages/orgbrain-cli/src/lib/local-memory-judge.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const MAX_TEXT = 2 * 1024 * 1024;

function literalSearchRequest(call) {
  if (!call) return null;
  if (/orgbrain_(?:context_enrich|memory_(?:search|retrieve_context))/u.test(call.name ?? "")) {
    try {
      const args = JSON.parse(call.arguments);
      if (typeof args.query === "string") return { query: args.query, project_id: args.project_id,
        diagnostic: ["audit", "diagnostic", "test"].includes(args.usage_purpose), source: "original_mcp_arguments" };
    } catch { return null; }
  }
  // Read JSON string literals in code-mode calls; never evaluate historical JS.
  const input = call.input ?? call.arguments;
  if (typeof input !== "string") return null;
  const literal = /(?:\bcmd|"cmd")\s*:\s*("(?:\\.|[^"\\])*")/u.exec(input);
  if (!literal) return null;
  let cmd; try { cmd = JSON.parse(literal[1]); } catch { return null; }
  if (/\/artifacts\/product-ux-evaluation\/|mcp-fixtures\.sqlite|const fixtures\s*=|UX audit first memory|deterministic fixture for UX evaluation/u.test(cmd)) {
    return { diagnostic: true, source: "isolated_test_database" };
  }
  const matches = [...cmd.matchAll(/\bmemory\s+search\s+("(?:\\.|[^"\\])*"|'[^']*'|[^\s;]+)/gu)];
  if (matches.length !== 1) return null;
  const text = matches[0][1];
  if (text.startsWith("--") || text.includes("$") || text.includes("`")) return null;
  let query;
  try { query = text.startsWith('"') ? JSON.parse(text) : text.startsWith("'") ? text.slice(1, -1) : text; }
  catch { return null; }
  const project = /--project-id\s+([A-Za-z0-9_-]+)/u.exec(cmd)?.[1];
  return { query, project_id: project, diagnostic: false,
    source: "original_cli_search_literal" };
}

// Recover code-mode and nested MCP envelopes, without eval or parsing reasoning.
export function readEmbeddedObjects(value, depth = 0) {
  if (depth > 12) return [];
  if (Array.isArray(value)) return value.flatMap(v => readEmbeddedObjects(v, depth + 1));
  if (value && typeof value === "object") return [value, ...Object.entries(value)
    .filter(([key]) => !["reasoning", "analysis"].includes(key))
    .flatMap(([, v]) => readEmbeddedObjects(v, depth + 1))];
  if (typeof value !== "string" || value.length > MAX_TEXT) return [];
  const found = [];
  let start = -1, nesting = 0, quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (start === -1) { if (c === "{") { start = i; nesting = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === "{") nesting++;
    else if (c === "}" && --nesting === 0) {
      try { found.push(...readEmbeddedObjects(JSON.parse(value.slice(start, i + 1)), depth + 1)); } catch { /* Not evidence. */ }
      start = -1;
    }
  }
  return found;
}

export function collectHistoricalRetrievals(rows, { projectId } = {}) {
  const result = { retrieval_count: 0, empty_retrieval_count: 0, incomplete_result_count: 0,
    missing_context_count: 0, duplicate_receipts: 0, diagnostic_retrieval_count: 0, cases: [] };
  const seen = new Set(), calls = new Map();
  for (const row of rows) {
    if (row.type !== "response_item") continue;
    const p = row.payload ?? {};
    if (["function_call", "custom_tool_call"].includes(p.type)) calls.set(p.call_id, p);
    if (!["custom_tool_call_output", "function_call_output"].includes(p.type)) continue;
    for (const object of readEmbeddedObjects(p.output)) {
      if (!Array.isArray(object.results) || typeof object.meta?.usage_id !== "string") continue;
      if (seen.has(object.meta.usage_id)) { result.duplicate_receipts++; continue; }
      seen.add(object.meta.usage_id); result.retrieval_count++;
      if (!object.results.length) { result.empty_retrieval_count++; continue; }
      const request = literalSearchRequest(calls.get(p.call_id));
      if (request?.diagnostic) { result.diagnostic_retrieval_count++; continue; }
      // A surrounding user task is not the historical search query. Do not
      // silently replace dynamic/unsupported arguments with that task.
      if (!request || typeof request.query !== "string") { result.missing_context_count++; continue; }
      const originalQuery = request.query;
      if (!originalQuery || originalQuery.length > 60_000 || /^(?:続き|続けて|OK|はい)[。.!\s]*$/iu.test(originalQuery)) {
        result.missing_context_count++; continue;
      }
      const memories = object.results.map(r => r.memory);
      if (memories.some(m => !m || typeof m.id !== "string" || typeof m.content !== "string")
        || new Set(memories.map(m => m.id)).size !== memories.length) { result.incomplete_result_count++; continue; }
      result.cases.push({ id: `historical-${digest(object.meta.usage_id).slice(0, 24)}`,
        usage_hash: digest(object.meta.usage_id), occurred_at: row.timestamp ?? null,
        context: { project_id: request?.project_id ?? projectId, query: originalQuery },
        query_source: request.source,
        candidates: memories.map(m => memoryJudgmentCandidate(m)),
        evidence_gaps: ["original_task_acceptance_criteria", "verified_counterfactual_task_outcome", "whole_task_cost",
          "complete_workspace_start_snapshot", "independent_required_memory_labels"] });
    }
  }
  return result;
}

export function historicalReplayReport(cases, judgments) {
  const unpriced = judgments.filter(j => j.request_count > 0 && j.provider_cost == null);
  const knownCost = judgments.reduce((sum, j) => sum + (j.provider_cost ?? 0), 0);
  const decisions = judgments.flatMap(j => j.decisions ?? []);
  return { schema: "memory-judgment-history-replay/v1", status: "inconclusive",
    scope: "historical_selection_predictions_only", activation_qualified: false,
    independent_conversations: new Set(cases.map(c => c.conversation_hash)).size,
    replay_cases: cases.length, judged_cases: judgments.filter(j => j.status === "judged").length,
    proposed_omissions: decisions.filter(d => d.action === "omit").length,
    reviews: decisions.filter(d => d.action === "review").length,
    retains: decisions.filter(d => d.action === "retain").length,
    provider_requests: judgments.reduce((n, j) => n + j.request_count, 0),
    cache_hits: judgments.reduce((n, j) => n + (j.cache_hits ?? 0), 0),
    known_provider_cost_usd: knownCost, provider_cost_usd: unpriced.length ? null : knownCost,
    unpriced_requests: unpriced.reduce((n, j) => n + j.request_count, 0),
    task_success: null, required_memory_missing: null, false_application: null,
    total_task_cost_usd: null, cost_savings_usd: null, added_latency_p95_ms: null,
    reasons: ["historical_logs_are_not_verified_paired_task_outcomes", "start_snapshots_and_acceptance_criteria_not_bound",
      "whole_task_cost_not_measured", "independent_required_memory_labels_not_available"] };
}

async function* sessionRows(file, evidence) {
  const source = createReadStream(file);
  const sourceHash = createHash("sha256");
  source.on("data", bytes => sourceHash.update(bytes));
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length > MAX_TEXT || !line.includes('"response_item"') || /"type"\s*:\s*"reasoning"/u.test(line)) continue;
    // Keep original tool arguments and retrieval envelopes, never a full transcript.
    if (!line.includes("usage_id") && !/"type"\s*:\s*"(?:function_call|custom_tool_call)"/u.test(line)) continue;
    try {
      const row = JSON.parse(line), p = row.payload;
      if (row.type === "response_item" && (["function_call", "custom_tool_call"].includes(p?.type) ||
        (["function_call_output", "custom_tool_call_output"].includes(p?.type) && line.includes("usage_id")))) yield row;
    } catch { /* Report only recoverable records. */ }
  }
  evidence.source_hash = sourceHash.digest("hex");
}
async function discoverSessions(root, files = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) await discoverSessions(file, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
  }
  return files;
}
async function sessionMetadata(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString().split("\n")[0];
    const row = JSON.parse(first); return row.type === "session_meta" ? { ...row.payload, timestamp: row.timestamp } : null;
  } catch { return null; } finally { await handle.close(); }
}

export async function evaluateHistoricalSessions({ roots, projectId, excludedSessions = [], limit = 20, out, live = false, transport } = {}) {
  if (!projectId || !out || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_history_options");
  await mkdir(out, { mode: 0o700 });
  const write = (name, value) => writeFile(join(out, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const inventory = new Map();
  const excluded = { project_or_source: 0, active_session: 0, duplicate_session: 0 };
  for (const root of roots) {
    let files; try { files = await discoverSessions(root); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const file of files) {
      const meta = await sessionMetadata(file);
      // exec can also be a batch-model invocation with copied Desktop metadata.
      // For this retrospective study, include native Desktop roots only.
      const userRoot = meta && !meta.parent_thread_id && !meta.agent_path && meta.source === "vscode";
      if (!userRoot || basename(meta.cwd ?? "") !== projectId) { excluded.project_or_source++; continue; }
      if (excludedSessions.includes(meta.id)) { excluded.active_session++; continue; }
      const info = await stat(file), previous = inventory.get(meta.id);
      if (previous) excluded.duplicate_session++;
      if (!previous || previous.bytes < info.size) inventory.set(meta.id, { meta, file, bytes: info.size });
    }
  }
  const selected = [...inventory.values()].sort((a, b) => b.meta.timestamp.localeCompare(a.meta.timestamp)).slice(0, limit);
  const sessions = [], cases = [], receipts = new Set();
  for (const session of selected) {
    const before = await stat(session.file);
    const evidence = {}, relevant = [];
    for await (const row of sessionRows(session.file, evidence)) relevant.push(row);
    const result = collectHistoricalRetrievals(relevant, { projectId });
    const after = await stat(session.file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("historical_session_changed_during_scan");
    const conversationHash = digest(session.meta.id);
    const { cases: recovered, ...counts } = result;
    sessions.push({ conversation_hash: conversationHash, started_at: session.meta.timestamp, bytes: session.bytes,
      source_hash: evidence.source_hash, git_commit: session.meta.git?.commit_hash ?? null, ...counts, recovered_cases: recovered.length,
      complete_workspace_start_snapshot: "not_established", verified_paired_outcomes: 0 });
    // Choose one original retrieval per independent conversation, before judging.
    const candidate = recovered.find(c => !receipts.has(c.usage_hash));
    if (candidate) { receipts.add(candidate.usage_hash); cases.push({ ...candidate, conversation_hash: conversationHash }); }
  }
  await write("manifest.json", { schema: "memory-judgment-history-manifest/v1", project_id: projectId,
    session_scope: "native_desktop_vscode_roots_only",
    threshold: .95, model: "typesafe/jev-1.13", resolved_model: "typesafe/jev-1.13-20260917",
    eligible_root_sessions: inventory.size, inspected_sessions: sessions.length, exclusions: excluded, sessions,
    cases_hash: digest(JSON.stringify(cases)), source: "original_tool_outputs_and_original_search_arguments",
    writes_to_live_memory: false, executes_historical_commands: false });
  await write("cases.private.json", cases);
  const judge = createMemoryJudge({ transport: transport ?? createOpenRouterMemoryTransport({ apiKey: process.env.OPENROUTER_API_KEY }) });
  const judgments = [];
  if (live || transport) for (const item of cases) {
    const result = await judge({ stage: "use", context: item.context, candidates: item.candidates,
      policy: { mode: "shadow", objective: "cost", threshold: .95, resolved_model: "typesafe/jev-1.13-20260917" } });
    const { review_bundle: _private, ...safe } = result;
    judgments.push({ ...safe, case_id: item.id });
  }
  const report = { ...historicalReplayReport(cases, judgments), eligible_root_sessions: inventory.size,
    inspected_sessions: sessions.length, retrieval_count: sessions.reduce((n, s) => n + s.retrieval_count, 0),
    empty_retrieval_count: sessions.reduce((n, s) => n + s.empty_retrieval_count, 0),
    diagnostic_retrieval_count: sessions.reduce((n, s) => n + s.diagnostic_retrieval_count, 0),
    missing_search_arguments_count: sessions.reduce((n, s) => n + s.missing_context_count, 0),
    cases_hash: digest(JSON.stringify(cases)), evaluated_live: live || Boolean(transport) };
  await write("judgments.json", redactJudgmentValue(judgments));
  await write("report.json", report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { roots: [], excludedSessions: [], limit: 20 };
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === "--live") options.live = true;
      else if (["--sessions-root", "--exclude-session", "--project", "--limit", "--out"].includes(arg) && process.argv[i + 1]) {
        const value = process.argv[++i];
        if (arg === "--sessions-root") options.roots.push(resolve(value));
        else if (arg === "--exclude-session") options.excludedSessions.push(value);
        else if (arg === "--project") options.projectId = value;
        else if (arg === "--limit") options.limit = Number(value);
        else options.out = resolve(value);
      } else throw new Error("usage: --project ID --out NEW_DIRECTORY [--limit 20] [--sessions-root ROOT] [--exclude-session ID] [--live]");
    }
    if (!options.roots.length) options.roots = [join(homedir(), ".codex", "sessions"), join(homedir(), ".codex", "archived_sessions")];
    console.log(JSON.stringify(await evaluateHistoricalSessions(options), null, 2));
  } catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
}
