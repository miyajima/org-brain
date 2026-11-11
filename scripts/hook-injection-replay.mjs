#!/usr/bin/env node
// Replays real Codex prompt events against isolated database copies and
// compares what each CLI bundle would inject. No model is called. Only counts
// are written: prompts, memory text and hook output never leave memory.
//
// Usage:
//   node scripts/hook-injection-replay.mjs --config variants.json [--out results.json]
//     [--sessions ~/.codex/sessions] [--months 2026/11,2026/10] [--max-prompts 300] [--per-session 30]
//
// variants.json: { "projects": ["org-brain"], "variants": [{ "name": "old", "bundle": "/path/orgbrain.mjs", "env": "/path/old.env" }] }
// Each env file must point ORGBRAIN_LOCAL_DB at its own copy of the database;
// the replay refuses a variant that would write to the live default database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const MAX_SESSION_BYTES = 80 * 1024 * 1024;
const LIVE_DATABASE = path.join(os.homedir(), ".org-brain", "memory.sqlite");

const message = (role, text) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
const messageText = (item) => typeof item.content === "string" ? item.content : (item.content ?? []).map((part) => part?.text ?? "").join("\n");

/** Session identity plus its prompts and compactions in file order. */
export function parseSession(buffer) {
  let meta = null, pending = null, lastTurnId = null, offset = 0;
  const events = [];
  while (offset < buffer.length) {
    let end = buffer.indexOf(0x0a, offset);
    if (end < 0) end = buffer.length;
    const head = buffer.subarray(offset, Math.min(end, offset + 400)).toString("utf8");
    if (head.includes('"session_meta"') || head.includes('"turn_context"') || head.includes('"task_started"')
      || head.includes('"compacted"') || (head.includes('"response_item"') && head.includes('"role":"user"'))) {
      let row = null;
      try { row = JSON.parse(buffer.subarray(offset, end).toString("utf8")); } catch { /* a partial line is not an event */ }
      const item = row?.payload ?? {};
      if (row?.type === "session_meta") meta = { id: item.id, cwd: item.cwd, subagent: Boolean(item.parent_thread_id) };
      else if (row?.type === "compacted") events.push({ compacted: true });
      else if (row?.type === "event_msg" && item.type === "task_started") lastTurnId = item.turn_id ?? item.id ?? lastTurnId;
      else if (row?.type === "turn_context") pending = { turnId: item.turn_id ?? lastTurnId };
      else if (row?.type === "response_item" && item.type === "message" && item.role === "user" && pending) {
        const prompt = messageText(item).trim();
        // Harness-injected user rows start with a tag; the first real prompt of the turn does not.
        if (prompt && !prompt.startsWith("<")) events.push({ prompt: prompt.slice(0, 4000), turnId: pending.turnId ?? `replay-${offset}` });
        pending = null;
      }
    }
    offset = end + 1;
  }
  return { meta, events, prompts: events.filter((event) => !event.compacted).length };
}

/** A compaction removes earlier developer messages from what the model still holds. */
export function historyAfterCompaction(history) {
  return [...history.filter((row) => row.payload?.role !== "developer"), { type: "compacted", payload: {} }];
}

/** The transcript a variant would see: its own earlier output, then the current turn. */
export function transcriptRows(history, cwd, turnId, prompt) {
  return [...history, { type: "turn_context", payload: { turn_id: turnId, cwd } }, message("user", prompt)];
}

export function emptyTotals() {
  return { starts: 0, start_tokens: 0, start_previews: 0, prompts: 0, errors: 0, chars: 0, tokens: 0, previews: 0,
    repeated_previews: 0, prompts_with_previews: 0, prompts_with_contract: 0, prompts_with_eager: 0,
    prompts_with_observe_hint: 0, prompts_with_wiki_guidance: 0, prompts_without_context: 0, elapsed_ms: 0 };
}

/** Counts for one hook output; `seen` holds versions already offered in this session. */
export function summarizeContext(context, seen, countTokens) {
  const ids = [...context.matchAll(/"memory_id":"([^"]+)"[^\n]*?"current_version":(\d+)/gu)].map((match) => `${match[1]}:${match[2]}`);
  const summary = { chars: context.length, tokens: context ? countTokens(context) : 0, previews: ids.length,
    repeated_previews: ids.filter((id) => seen.has(id)).length, prompts_with_previews: Number(ids.length > 0),
    prompts_with_contract: Number(context.includes("OrgBrain memory protocol v2")),
    prompts_with_eager: Number(context.includes("OrgBrain eager learning is enabled")),
    prompts_with_observe_hint: Number(context.includes("When a retrieved memory actually informs an action")),
    prompts_with_wiki_guidance: Number(context.includes("OrgBrain Knowledge Wiki (personal) maintenance is enabled")),
    prompts_without_context: Number(!context) };
  ids.forEach((id) => seen.add(id));
  return summary;
}

function parseArguments(argv) {
  const options = { sessions: path.join(os.homedir(), ".codex", "sessions"), months: null, maxPrompts: 300, perSession: 30, out: null, config: null };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (value === undefined) throw new Error(`${name} requires a value`);
    if (name === "--config") options.config = path.resolve(value);
    else if (name === "--out") options.out = path.resolve(value);
    else if (name === "--sessions") options.sessions = path.resolve(value);
    else if (name === "--months") options.months = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    else if (name === "--max-prompts") options.maxPrompts = Number(value);
    else if (name === "--per-session") options.perSession = Number(value);
    else throw new Error(`unknown option ${name}`);
  }
  if (!options.config) throw new Error("--config is required");
  if (!Number.isInteger(options.maxPrompts) || options.maxPrompts < 1 || !Number.isInteger(options.perSession) || options.perSession < 1) {
    throw new Error("--max-prompts and --per-session must be positive integers");
  }
  return options;
}

/** Refuses a variant whose env file would let the hook write to the live database. */
export function isolatedDatabase(envText, liveDatabase = LIVE_DATABASE) {
  const database = /^ORGBRAIN_LOCAL_DB=(.+)$/mu.exec(envText)?.[1]?.trim();
  return Boolean(database) && path.resolve(database) !== path.resolve(liveDatabase);
}

function sessionFiles(root, months) {
  const selected = months ?? fs.readdirSync(root).filter((year) => /^\d{4}$/u.test(year))
    .flatMap((year) => fs.readdirSync(path.join(root, year)).map((month) => `${year}/${month}`));
  const files = [];
  for (const month of selected) {
    const directory = path.join(root, month);
    if (!fs.existsSync(directory)) continue;
    for (const day of fs.readdirSync(directory)) {
      const dayDirectory = path.join(directory, day);
      if (!fs.statSync(dayDirectory).isDirectory()) continue;
      for (const name of fs.readdirSync(dayDirectory)) {
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        const file = path.join(dayDirectory, name), info = fs.statSync(file);
        if (info.size > 2_000 && info.size <= MAX_SESSION_BYTES) files.push({ file, modified: info.mtimeMs });
      }
    }
  }
  return files.sort((left, right) => right.modified - left.modified).map((entry) => entry.file);
}

function runHook(variant, payload) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, ["--no-warnings", variant.bundle, "hook", "codex-context"], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: os.homedir(), ORGBRAIN_HOOK_ENV_FILES: variant.env }
  });
  let context = "", error = result.status !== 0 || Boolean(result.error);
  try {
    if (result.stdout.trim()) context = JSON.parse(result.stdout).hookSpecificOutput?.additionalContext ?? "";
  } catch { error = true; }
  return { context, error, elapsed: Number(process.hrtime.bigint() - started) / 1e6 };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const config = JSON.parse(fs.readFileSync(options.config, "utf8"));
  if (!Array.isArray(config.variants) || config.variants.length === 0 || !Array.isArray(config.projects)) {
    throw new Error("config needs projects and at least one variant");
  }
  for (const variant of config.variants) {
    if (!isolatedDatabase(fs.readFileSync(variant.env, "utf8"))) {
      throw new Error(`variant ${variant.name} must set ORGBRAIN_LOCAL_DB to a copy, not the live database`);
    }
  }
  const workspacesFile = path.join(os.homedir(), ".config", "org-brain", "workspaces.json");
  const workspaces = JSON.parse(fs.readFileSync(workspacesFile, "utf8")).workspaces;
  const { getEncoding } = createRequire(new URL("../packages/orgbrain-cli/package.json", import.meta.url))("js-tiktoken");
  const encoder = getEncoding("o200k_base");
  const countTokens = (text) => encoder.encode(text).length;
  const names = config.variants.map((variant) => variant.name);
  const totals = Object.fromEntries(names.map((name) => [name, emptyTotals()]));
  const byProject = {}, sessions = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "orgbrain-hook-replay-"));
  fs.chmodSync(scratch, 0o700);
  let replayed = 0;
  try {
    for (const file of sessionFiles(options.sessions, options.months)) {
      if (replayed >= options.maxPrompts) break;
      let parsed;
      try { parsed = parseSession(fs.readFileSync(file)); } catch { continue; }
      const { meta, events, prompts } = parsed;
      if (!meta?.id || !meta.cwd || meta.subagent || prompts < 2) continue;
      let root = null;
      try { root = fs.realpathSync.native(meta.cwd); } catch { continue; }
      const entry = workspaces[root];
      if (!entry || !config.projects.includes(entry.project_id)) continue;
      const seen = Object.fromEntries(names.map((name) => [name, new Set()]));
      const history = Object.fromEntries(names.map((name) => [name, []]));
      const add = (name, values) => {
        for (const bucket of [totals[name], ((byProject[entry.project_id] ??= {})[name] ??= emptyTotals())]) {
          for (const [key, value] of Object.entries(values)) bucket[key] += value;
        }
      };
      for (const variant of config.variants) {
        const { context } = runHook(variant, { hook_event_name: "SessionStart", session_id: meta.id, cwd: root, usage_purpose: "test" });
        add(variant.name, { starts: 1, start_tokens: context ? countTokens(context) : 0, start_previews: (context.match(/"memory_id"/gu) ?? []).length });
        if (context) history[variant.name].push(message("developer", context));
      }
      let sessionPrompts = 0, compactions = 0;
      for (const event of events) {
        if (replayed >= options.maxPrompts || sessionPrompts >= options.perSession) break;
        if (event.compacted) {
          compactions += 1;
          for (const name of names) history[name] = historyAfterCompaction(history[name]);
          continue;
        }
        for (const variant of config.variants) {
          const transcript = path.join(scratch, `transcript-${variant.name}.jsonl`);
          const rows = transcriptRows(history[variant.name], root, event.turnId, event.prompt);
          fs.writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
          const { context, error, elapsed } = runHook(variant, { hook_event_name: "UserPromptSubmit", session_id: meta.id, turn_id: event.turnId,
            cwd: root, prompt: event.prompt, transcript_path: transcript, usage_purpose: "test" });
          add(variant.name, { prompts: 1, errors: Number(error), elapsed_ms: elapsed, ...summarizeContext(context, seen[variant.name], countTokens) });
          history[variant.name].push(message("user", event.prompt));
          if (context) history[variant.name].push(message("developer", context));
        }
        replayed += 1; sessionPrompts += 1;
      }
      sessions.push({ project: entry.project_id, prompts_in_session: prompts, replayed: sessionPrompts, compactions });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const output = { generated_at: new Date().toISOString(), projects: config.projects, variants: names, sessions: sessions.length,
    replayed_prompts: replayed, totals, by_project: byProject, session_shapes: sessions };
  if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(output, null, 1)}\n`, { mode: 0o600 });
  const row = (label, pick) => `${label.padEnd(30)} ${names.map((name) => String(pick(totals[name])).padStart(12)).join(" ")}`;
  process.stdout.write(`${[`sessions ${sessions.length}, replayed prompts ${replayed}`,
    `${"".padEnd(30)} ${names.map((name) => name.padStart(12)).join(" ")}`,
    row("session start tokens", (total) => total.start_tokens), row("context tokens", (total) => total.tokens),
    row("tokens per prompt", (total) => (total.tokens / Math.max(1, total.prompts)).toFixed(1)),
    row("memory previews", (total) => total.previews), row("repeated previews", (total) => total.repeated_previews),
    row("prompts with learning contract", (total) => total.prompts_with_contract),
    row("prompts with Wiki guidance", (total) => total.prompts_with_wiki_guidance),
    row("prompts without context", (total) => total.prompts_without_context), row("errors", (total) => total.errors),
    row("hook ms per prompt", (total) => (total.elapsed_ms / Math.max(1, total.prompts)).toFixed(0))].join("\n")}\n`);
  return output;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
