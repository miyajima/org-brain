#!/usr/bin/env node

import fs, { createReadStream } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { buildTurnEvidenceV1, routeTurnEvidenceV3 } from "../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs";
import {
  sanitizeMemoryExtractionReviewCase,
  sanitizeMemoryExtractionReviewText,
  stripMemoryCitationBlocks
} from "../packages/shared/src/memory-extraction-review-text-runtime.mjs";
import { readSessionTurnGroups } from "./memory-extraction-evaluation-bundle.mjs";
import { filesUnder } from "./memory-learning-corpus.mjs";

export const CONTEXT_SUPPLEMENT_CONTRACT = "memory-extraction-context-supplement/v1";
const reconstructed = new WeakSet();

function hash(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function dedupeTurns(turns) {
  const seen = new Set();
  return turns.flatMap((turn) => {
    const content = stripMemoryCitationBlocks(turn.content).trim();
    if (!content) return [];
    const key = `${turn.role}\0${content.replace(/\s+/gu, " ").trim()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...turn, content }];
  });
}

export function contextWindowSourceHash(turns) {
  return `sha256:${hash(stableJson(dedupeTurns(turns)))}`;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(6));
}

function metrics(rows, gold, predicted) {
  let tp = 0; let fp = 0; let fn = 0;
  for (const row of rows) {
    const actual = gold(row);
    const guess = predicted(row);
    if (actual && guess) tp += 1;
    else if (!actual && guess) fp += 1;
    else if (actual) fn += 1;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return { precision, recall, f1: precision === null || recall === null || precision + recall === 0 ? 0 : ratio(2 * precision * recall, precision + recall) };
}

function validateSupplement(bundle, supplement) {
  if (supplement?.contract !== CONTEXT_SUPPLEMENT_CONTRACT || !supplement.cases || typeof supplement.cases !== "object") {
    throw new Error("context_experiment_unavailable:invalid_context_supplement");
  }
  for (const item of bundle.cases) {
    const context = supplement.cases[item.id];
    if (!context || context.source_hash !== item.source_hash || context.session_hash !== item.session_hash) {
      throw new Error(`context_experiment_unavailable:source_hash_mismatch:${item.id}`);
    }
    if (!Array.isArray(context.context_windows) || context.context_windows.length > 2
      || context.context_windows.some((window) => !Array.isArray(window.turns))) {
      throw new Error(`context_experiment_unavailable:context_window:${item.id}`);
    }
    if (context.context_windows.some((window) => window.source_hash !== contextWindowSourceHash(window.turns))) {
      throw new Error(`context_experiment_unavailable:prior_source_hash_mismatch:${item.id}`);
    }
  }
  if (!reconstructed.has(supplement)) throw new Error("context_experiment_unavailable:source_provenance_unverified");
}

export function compareThreeTurnContext(bundle, goldRows, supplement, model) {
  validateSupplement(bundle, supplement);
  const goldByCase = new Map(goldRows.map((row) => [row.case_id, row.gold]));
  const rows = bundle.cases.map((item) => {
    const gold = goldByCase.get(item.id);
    if (!gold) throw new Error(`context_experiment_unavailable:missing_gold:${item.id}`);
    const current = sanitizeMemoryExtractionReviewCase(item).turns.map((turn) => ({ span_id: turn.id, role: turn.role, text: turn.content }));
    const context = supplement.cases[item.id].context_windows.flatMap((window, windowIndex) =>
      window.turns.map((turn, turnIndex) => ({
        span_id: `ctx${windowIndex + 1}-${turnIndex + 1}`,
        role: turn.role,
        text: sanitizeMemoryExtractionReviewText(turn.content),
        context_only: true
      })));
    const baseline = routeTurnEvidenceV3({ snippets: current, events: [], hard_exclusion_reason: null }, { model });
    const contextual = routeTurnEvidenceV3({ snippets: current, context_snippets: context, events: [], hard_exclusion_reason: null }, { model });
    if (contextual.support_span_ids.some((id) => String(id).startsWith("ctx"))) {
      throw new Error(`context_experiment_invalid:context_used_as_support:${item.id}`);
    }
    return { case_id: item.id, phase: item.phase, gold, baseline, contextual };
  });
  const summarize = (selected, field) => ({
    durable: metrics(selected, (row) => row.gold.usefulness === "durable_memory", (row) => row[field].primary_route === "llm_candidate"),
    operational_history: metrics(selected, (row) => row.gold.usefulness === "operational_history_only", (row) => row[field].primary_route === "operational_history"),
    llm_call_rate: ratio(selected.filter((row) => row[field].llm_recommended).length, selected.length)
  });
  const locked = rows.filter((row) => row.phase === "locked" && row.gold.usefulness !== "excluded");
  return {
    contract: "memory-extraction-router-context-comparison/v1",
    context_window: 3,
    current_turn_only_support: true,
    locked: { baseline: summarize(locked, "baseline"), contextual: summarize(locked, "contextual") },
    rows
  };
}

export async function reconstructContextSupplement(bundle, options = {}) {
  const targetSessionHashes = new Set(bundle.cases.map((item) => item.session_hash));
  const roots = options.sessions_roots ?? [
    path.join(os.homedir(), ".codex", "sessions"),
    path.join(os.homedir(), ".codex", "archived_sessions")
  ];
  const sessionsByHash = new Map();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const filePath of filesUnder(root)) {
      const input = createReadStream(filePath, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      let session = null;
      for await (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row?.type !== "session_meta") continue;
        const payload = row.payload && typeof row.payload === "object" ? row.payload : row;
        if (typeof payload.id === "string" && typeof payload.cwd === "string") {
          session = { id: payload.id, cwd: payload.cwd, filePath };
        }
        break;
      }
      lines.close();
      input.destroy();
      if (!session) continue;
      const sessionHash = hash(session.id);
      if (!targetSessionHashes.has(sessionHash)) continue;
      const size = fs.statSync(session.filePath).size;
      const existing = sessionsByHash.get(sessionHash);
      if (!existing || size > existing.size) sessionsByHash.set(sessionHash, { ...session, size });
    }
  }
  const cases = {};
  for (const [sessionHash, session] of sessionsByHash) {
    const groups = await readSessionTurnGroups(session.filePath, { include_incomplete: true });
    const projected = [];
    for (const group of groups) {
      const evidence = await buildTurnEvidenceV1({
        rows: group.rows,
        session_hash: sessionHash,
        project_id: "context-reconstruction"
      }, {
        workspace_root: session.cwd,
        sensitive_policy: { mode: "restricted_7d", allowed_principals: ["reviewer-local"] }
      });
      if (evidence.hard_exclusion_reason || evidence.snippets.length === 0) {
        projected.push(null);
        continue;
      }
      const turns = dedupeTurns(evidence.snippets.map((snippet) => ({
        id: snippet.span_id,
        role: snippet.role,
        content: snippet.text,
        ...(group.occurred_at ? { observed_at: new Date(group.occurred_at).toISOString() } : {})
      })));
      projected.push({
        source_hash: contextWindowSourceHash(turns),
        turns
      });
    }
    for (const caseItem of bundle.cases.filter((item) => item.session_hash === sessionHash)) {
      const index = projected.findIndex((item) => item?.source_hash === caseItem.source_hash);
      if (index < 0) continue;
      if (projected.filter((item) => item?.source_hash === caseItem.source_hash).length !== 1) throw new Error("context_experiment_unavailable:ambiguous_source_order");
      if (projected.slice(Math.max(0, index - 2), index).some((item) => !item)) throw new Error("context_experiment_unavailable:prior_turn_unavailable");
      const contextWindows = projected.slice(Math.max(0, index - 2), index)
        .map((item) => ({ source_hash: item.source_hash, turns: item.turns }));
      cases[caseItem.id] = {
        session_hash: sessionHash,
        source_hash: caseItem.source_hash,
        context_windows: contextWindows
      };
    }
  }
  const missing = bundle.cases.filter((item) => !cases[item.id]).map((item) => item.id);
  if (missing.length > 0) {
    throw new Error(`context_experiment_unavailable:source_hash_unreproducible:${missing.length}`);
  }
  const supplement = { contract: CONTEXT_SUPPLEMENT_CONTRACT, cases };
  reconstructed.add(supplement);
  return supplement;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export async function main(argv = process.argv.slice(2)) {
  const bundlePath = option(argv, "--bundle");
  const goldPath = option(argv, "--runtime-cases");
  const supplementPath = option(argv, "--context-supplement");
  const modelPath = option(argv, "--router-model");
  if (!bundlePath || !goldPath || !modelPath) throw new Error("context_experiment_unavailable:bundle_gold_model_required");
  const bundle = JSON.parse(fs.readFileSync(path.resolve(bundlePath), "utf8"));
  const gold = fs.readFileSync(path.resolve(goldPath), "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  const roots = argv.flatMap((arg, index) => arg === "--sessions-root" && argv[index + 1] ? [path.resolve(argv[index + 1])] : []);
  const supplement = supplementPath
    ? JSON.parse(fs.readFileSync(path.resolve(supplementPath), "utf8"))
    : await reconstructContextSupplement(bundle, roots.length ? { sessions_roots: roots } : {});
  const modelDocument = JSON.parse(fs.readFileSync(path.resolve(modelPath), "utf8"));
  const result = compareThreeTurnContext(bundle, gold, supplement, modelDocument.model ?? modelDocument);
  const outputPath = option(argv, "--output");
  if (outputPath) {
    const target = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ contract: result.contract, locked: result.locked, output: outputPath ? path.resolve(outputPath) : null })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
