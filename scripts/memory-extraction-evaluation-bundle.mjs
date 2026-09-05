#!/usr/bin/env node

import crypto from "node:crypto";
import fs, { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { listCorpusSessions } from "./memory-learning-corpus.mjs";
import {
  buildTurnEvidenceV1,
  discoverLearningEpisodes
} from "../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs";
import { stripMemoryCitationBlocks } from "../packages/shared/src/memory-extraction-review-text-runtime.mjs";

export const EVALUATION_CONTRACT = "orgbrain-memory-extraction-evaluation/v1";
export const DEFAULT_CALIBRATION_QUOTAS = Object.freeze({ decision: 15, failure: 15, success: 15, non_durable: 30 });
export const DEFAULT_LOCKED_QUOTAS = Object.freeze({ decision: 75, failure: 75, success: 75, non_durable: 200 });

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TURN_BYTES = 8 * 1024 * 1024;
const REASONING_ROW = /"(?:agent_reasoning|reasoning)"/u;
const INTERESTING_ROW = /"(?:session_meta|turn_context|response_item|user_message|agent_message|mcp_tool_call_end|custom_tool_call|function_call|custom_tool_call_output|function_call_output)"/u;
const WEAK_DECISION_SIGNAL = /\b(?:decid(?:e|ed)|adopt(?:ed)?|choose|chose|selected|standardize|switch(?:ed)?\s+to|will use|must use|prefer)\b|(?:決定|採用|選択|方針|統一|切り替え|優先|標準)/iu;
const COHORT_ORDER = Object.freeze(["decision", "success", "failure", "non_durable"]);

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

function rowPayload(row) {
  return row?.payload && typeof row.payload === "object" ? row.payload : row;
}

function turnId(rows, index) {
  const context = rows.find((row) => {
    const payload = rowPayload(row);
    return row?.type === "turn_context" || payload?.type === "turn_context";
  });
  return String(rowPayload(context)?.turn_id ?? `turn-${index}`).trim() || `turn-${index}`;
}

function finalTimestamp(rows) {
  for (const row of [...rows].reverse()) {
    const payload = rowPayload(row);
    if (payload?.type === "agent_message" && payload?.phase === "final_answer") {
      const parsed = Date.parse(row.timestamp);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function hasFinalAnswer(rows) {
  return rows.some((row) => {
    const payload = rowPayload(row);
    return payload?.type === "agent_message" && payload?.phase === "final_answer" && typeof payload.message === "string";
  });
}

export async function readSessionTurnGroups(file, options = {}) {
  const before = fs.statSync(file);
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const groups = [];
  let current = [];
  let currentBytes = 0;
  let oversized = false;
  let index = 0;
  const flush = () => {
    if (options.include_incomplete && oversized) throw new Error("context_turn_oversized");
    if (current.length > 0 && !oversized && (hasFinalAnswer(current) || options.include_incomplete)) {
      index += 1;
      groups.push({ id: turnId(current, index), rows: current, occurred_at: finalTimestamp(current) });
    }
    current = [];
    currentBytes = 0;
    oversized = false;
  };
  for await (const line of lines) {
    if (!line || REASONING_ROW.test(line) || !INTERESTING_ROW.test(line)) continue;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_LINE_BYTES) {
      oversized = true;
      continue;
    }
    let row;
    try { row = JSON.parse(line); } catch (error) { if (options.include_incomplete) throw new Error("context_turn_invalid_json", { cause: error }); continue; }
    const payload = rowPayload(row);
    const isTurnContext = row?.type === "turn_context" || payload?.type === "turn_context";
    if (isTurnContext) flush();
    currentBytes += bytes;
    if (currentBytes > MAX_TURN_BYTES) {
      oversized = true;
      continue;
    }
    current.push(row);
  }
  flush();
  const after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("session_changed_during_scan");
  return groups;
}

function dedupeSessions(roots) {
  const byId = new Map();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const session of listCorpusSessions(root)) {
      const existing = byId.get(session.id);
      const size = fs.statSync(session.filePath).size;
      if (!existing || size > existing.size) byId.set(session.id, { ...session, size });
    }
  }
  return [...byId.values()].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
}

function eligibleCohorts(evidence, discovery) {
  const lessonTypes = [...new Set((discovery.review_drafts ?? []).map((item) => item?.observation?.lesson_type).filter(Boolean))];
  const result = lessonTypes.filter((item) => ["decision", "failure", "success"].includes(item));
  const weakDecision = (evidence.snippets ?? []).some((item) => WEAK_DECISION_SIGNAL.test(item.text));
  if (weakDecision && !result.includes("decision")) result.push("decision");
  if (result.length === 0) result.push("non_durable");
  return result;
}

function modelPrediction(discovery) {
  if (discovery.hard_exclusion_reason || (discovery.excluded ?? []).some((item) => item.disposition === "hard_excluded")) {
    return {
      outcome: "hard_excluded",
      lesson_types: [],
      exclusion_reason: discovery.hard_exclusion_reason ?? discovery.excluded?.[0]?.reason ?? "hard_excluded"
    };
  }
  const drafts = discovery.review_drafts ?? [];
  if (drafts.length === 0) return { outcome: "no_candidate", lesson_types: [], support_span_ids: [] };
  return {
    outcome: "candidate",
    lesson_types: [...new Set(drafts.map((item) => item.observation.lesson_type))],
    support_span_ids: [...new Set(drafts.flatMap((item) => item.support_span_ids ?? []))]
  };
}

export async function buildEvaluationPool(options = {}) {
  const sessions = dedupeSessions(options.sessionsRoots ?? []);
  const pool = [];
  const excluded = { no_safe_capsule: 0, no_completed_turn: 0, scan_error: 0 };
  for (const session of sessions) {
    let groups;
    try { groups = await readSessionTurnGroups(session.filePath); } catch { excluded.scan_error += 1; continue; }
    if (groups.length === 0) excluded.no_completed_turn += 1;
    const sessionHash = hash(session.id);
    const projectHash = hash(path.resolve(session.cwd));
    for (const [index, group] of groups.entries()) {
      const turnHash = hash(group.id);
      const evidence = await buildTurnEvidenceV1({
        rows: group.rows,
        session_hash: sessionHash,
        turn_hash: turnHash,
        project_id: `project-${projectHash.slice(0, 12)}`
      }, {
        workspace_root: session.cwd,
        sensitive_policy: { mode: "restricted_7d", allowed_principals: ["reviewer-local"] }
      });
      if (evidence.hard_exclusion_reason || !Array.isArray(evidence.snippets) || evidence.snippets.length === 0) {
        excluded.no_safe_capsule += 1;
        continue;
      }
      const discovery = await discoverLearningEpisodes(evidence, {
        workspace_root: session.cwd,
        sensitive_policy: { mode: "restricted_7d", allowed_principals: ["reviewer-local"] }
      });
      const turns = evidence.snippets.map((snippet) => ({
        id: snippet.span_id,
        role: snippet.role,
        content: snippet.text,
        ...(group.occurred_at ? { observed_at: new Date(group.occurred_at).toISOString() } : {})
      }));
      const retentionClass = turns.some((turn) => turn.content.includes("[REDACTED_")) ? "sensitive" : "standard";
      pool.push({
        id: `case-${hash(`${sessionHash}:${turnHash}:${index}`).slice(0, 24)}`,
        session_hash: sessionHash,
        project_hash: projectHash,
        source_hash: `sha256:${hash(stableJson(turns))}`,
        retention_class: retentionClass,
        occurred_at: group.occurred_at,
        turns,
        turn_aliases: evidence.snippet_aliases ?? {},
        eligible_cohorts: eligibleCohorts(evidence, discovery),
        model_prediction: modelPrediction(discovery)
      });
    }
  }
  return { pool, source: { session_count: sessions.length, excluded } };
}

function duplicateKey(turn) {
  return `${turn.role}\0${stripMemoryCitationBlocks(turn.content).replace(/\s+/gu, " ").trim()}`;
}

export function deduplicateEvaluationBundle(bundle, options = {}) {
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.cases)) throw new Error("invalid_evaluation_bundle");
  let removedTurns = 0;
  let casesChanged = 0;
  const cases = bundle.cases.map((item) => {
    const kept = [];
    const byKey = new Map();
    const aliases = { ...(item.turn_aliases ?? {}) };
    for (const turn of item.turns ?? []) {
      const content = stripMemoryCitationBlocks(turn.content).trim();
      if (!content) continue;
      const nextTurn = { ...turn, content };
      const key = duplicateKey(nextTurn);
      const existing = byKey.get(key);
      if (existing) {
        aliases[turn.id] = existing.id;
        removedTurns += 1;
        continue;
      }
      byKey.set(key, nextTurn);
      kept.push(nextTurn);
    }
    if (kept.length === 0) throw new Error(`evaluation_case_empty_after_deduplication:${item.id}`);
    if (kept.length !== item.turns.length || kept.some((turn, index) => turn.content !== item.turns[index]?.content)) casesChanged += 1;
    return {
      ...item,
      turns: kept,
      source_hash: `sha256:${hash(stableJson(kept))}`,
      ...(Object.keys(aliases).length ? { turn_aliases: aliases } : {})
    };
  });
  return {
    ...bundle,
    cases,
    deduplication: {
      contract: "orgbrain-memory-extraction-deduplication/v1",
      strategy: "role_plus_memory_citation_stripped_text",
      generated_at: options.generatedAt ?? new Date().toISOString(),
      cases_changed: casesChanged,
      removed_turns: removedTurns
    }
  };
}

function deterministicOrder(items, seed, phase, cohort) {
  return [...items].sort((left, right) =>
    hash(`${seed}:${phase}:${cohort}:${left.id}`).localeCompare(hash(`${seed}:${phase}:${cohort}:${right.id}`)));
}

function cohortCounts(pool) {
  return Object.fromEntries(COHORT_ORDER.map((cohort) => [
    cohort,
    pool.filter((item) => item.eligible_cohorts.includes(cohort)).length
  ]));
}

function selectPhase(pool, phase, quotas, seed) {
  const eligibleCounts = {};
  for (const cohort of COHORT_ORDER) {
    const eligible = pool.filter((item) => item.eligible_cohorts.includes(cohort));
    eligibleCounts[cohort] = eligible.length;
    const required = Number(quotas[cohort] ?? 0);
    if (eligible.length < required) throw new Error(`evaluation_quota_insufficient:${phase}:${cohort}:${eligible.length}/${required}`);
  }

  // Cases have only four possible cohort labels, so aggregate the at-most 15
  // eligibility signatures and solve a tiny max-flow graph. This preserves an
  // exact joint assignment without the quadratic slot-by-slot matcher.
  const signatureGroups = new Map();
  for (const item of pool) {
    const signature = COHORT_ORDER
      .filter((cohort) => Number(quotas[cohort] ?? 0) > 0 && item.eligible_cohorts.includes(cohort))
      .join("+");
    if (!signature) continue;
    const group = signatureGroups.get(signature) ?? [];
    group.push(item);
    signatureGroups.set(signature, group);
  }
  const graph = new Map();
  const addEdge = (from, to, capacity) => {
    const forward = { to, capacity, initial: capacity, reverse: null };
    const reverse = { to: from, capacity: 0, initial: 0, reverse: forward };
    forward.reverse = reverse;
    const fromEdges = graph.get(from) ?? [];
    const toEdges = graph.get(to) ?? [];
    fromEdges.push(forward);
    toEdges.push(reverse);
    graph.set(from, fromEdges);
    graph.set(to, toEdges);
    return forward;
  };
  const source = "source";
  const sink = "sink";
  const signatureEdges = new Map();
  const orderedSignatures = [...signatureGroups.keys()].sort((left, right) =>
    hash(`${seed}:${phase}:signature:${left}`).localeCompare(hash(`${seed}:${phase}:signature:${right}`)));
  for (const signature of orderedSignatures) {
    const signatureNode = `signature:${signature}`;
    addEdge(source, signatureNode, signatureGroups.get(signature).length);
    const cohortEdges = new Map();
    for (const cohort of signature.split("+")) {
      cohortEdges.set(cohort, addEdge(signatureNode, `cohort:${cohort}`, signatureGroups.get(signature).length));
    }
    signatureEdges.set(signature, cohortEdges);
  }
  const cohortSinkEdges = new Map();
  for (const cohort of COHORT_ORDER) {
    cohortSinkEdges.set(cohort, addEdge(`cohort:${cohort}`, sink, Number(quotas[cohort] ?? 0)));
  }

  let flow = 0;
  while (true) {
    const queue = [source];
    const parent = new Map([[source, null]]);
    for (let cursor = 0; cursor < queue.length && !parent.has(sink); cursor += 1) {
      const node = queue[cursor];
      for (const edge of graph.get(node) ?? []) {
        if (edge.capacity <= 0 || parent.has(edge.to)) continue;
        parent.set(edge.to, { node, edge });
        queue.push(edge.to);
        if (edge.to === sink) break;
      }
    }
    if (!parent.has(sink)) break;
    let amount = Number.POSITIVE_INFINITY;
    for (let node = sink; node !== source;) {
      const step = parent.get(node);
      amount = Math.min(amount, step.edge.capacity);
      node = step.node;
    }
    for (let node = sink; node !== source;) {
      const step = parent.get(node);
      step.edge.capacity -= amount;
      step.edge.reverse.capacity += amount;
      node = step.node;
    }
    flow += amount;
  }

  const requiredTotal = COHORT_ORDER.reduce((sum, cohort) => sum + Number(quotas[cohort] ?? 0), 0);
  if (flow !== requiredTotal) {
    const unfilledCohort = COHORT_ORDER.find((cohort) => cohortSinkEdges.get(cohort).capacity > 0) ?? "joint_assignment";
    const required = Number(quotas[unfilledCohort] ?? 0);
    throw new Error(`evaluation_quota_insufficient:${phase}:${unfilledCohort}:${eligibleCounts[unfilledCohort] ?? 0}/${required}`);
  }

  const selected = [];
  for (const signature of orderedSignatures) {
    const orderedCases = deterministicOrder(signatureGroups.get(signature), seed, phase, signature);
    let cursor = 0;
    for (const cohort of COHORT_ORDER) {
      const edge = signatureEdges.get(signature).get(cohort);
      if (!edge) continue;
      const assigned = edge.initial - edge.capacity;
      for (const item of orderedCases.slice(cursor, cursor + assigned)) selected.push({ ...item, phase, cohort });
      cursor += assigned;
    }
  }
  return { selected, eligibleCounts };
}

function partitionEvaluationSessions(pool, calibrationQuotas, lockedQuotas, seed) {
  // Prove that the full pool can satisfy the locked phase before allocating any
  // session to calibration. Later, every addition preserves this invariant.
  selectPhase(pool, "locked", lockedQuotas, seed);
  const bySession = new Map();
  for (const item of pool) {
    const group = bySession.get(item.session_hash) ?? [];
    group.push(item);
    bySession.set(item.session_hash, group);
  }
  const totalCounts = cohortCounts(pool);
  const calibrationSessions = new Set();
  const rejectedSessions = new Set();

  while (calibrationSessions.size <= bySession.size) {
    const calibrationPool = pool.filter((item) => calibrationSessions.has(item.session_hash));
    try {
      const calibration = selectPhase(calibrationPool, "calibration", calibrationQuotas, seed);
      const lockedPool = pool.filter((item) => !calibrationSessions.has(item.session_hash));
      const locked = selectPhase(lockedPool, "locked", lockedQuotas, seed);
      return { calibration, locked, calibrationSessions };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("evaluation_quota_insufficient:calibration:")) throw error;
    }

    const currentCounts = cohortCounts(calibrationPool);
    const candidates = [...bySession.entries()]
      .filter(([sessionHash]) => !calibrationSessions.has(sessionHash) && !rejectedSessions.has(sessionHash))
      .map(([sessionHash, items]) => {
        const counts = cohortCounts(items);
        const gain = COHORT_ORDER.reduce((sum, cohort) => {
          const remaining = Math.max(0, Number(calibrationQuotas[cohort] ?? 0) - currentCounts[cohort]);
          return sum + Math.min(remaining, counts[cohort]);
        }, 0);
        const fallbackCoverage = COHORT_ORDER.reduce((sum, cohort) =>
          sum + Math.min(Number(calibrationQuotas[cohort] ?? 0), counts[cohort]), 0);
        const lockedPressure = COHORT_ORDER.reduce((sum, cohort) => {
          const slack = Math.max(1, totalCounts[cohort] - Number(lockedQuotas[cohort] ?? 0));
          return sum + counts[cohort] / slack;
        }, 0);
        const score = (gain * 1_000 + fallbackCoverage * 10) / (1 + items.length + lockedPressure * 50);
        return { sessionHash, score, tie: hash(`${seed}:session-partition:${sessionHash}`) };
      })
      .sort((left, right) => right.score - left.score || left.tie.localeCompare(right.tie));

    let added = false;
    for (const candidate of candidates) {
      const proposed = new Set(calibrationSessions).add(candidate.sessionHash);
      const lockedPool = pool.filter((item) => !proposed.has(item.session_hash));
      const rawLockedCounts = cohortCounts(lockedPool);
      const rawFeasible = COHORT_ORDER.every((cohort) =>
        rawLockedCounts[cohort] >= Number(lockedQuotas[cohort] ?? 0));
      if (!rawFeasible) {
        rejectedSessions.add(candidate.sessionHash);
        continue;
      }
      try {
        selectPhase(lockedPool, "locked", lockedQuotas, seed);
        calibrationSessions.add(candidate.sessionHash);
        added = true;
        break;
      } catch {
        rejectedSessions.add(candidate.sessionHash);
      }
    }
    if (!added) {
      const calibrationCounts = cohortCounts(calibrationPool);
      const unmet = COHORT_ORDER.find((cohort) =>
        calibrationCounts[cohort] < Number(calibrationQuotas[cohort] ?? 0)) ?? "joint_assignment";
      throw new Error(`evaluation_quota_insufficient:calibration:${unmet}:${calibrationCounts[unmet] ?? 0}/${calibrationQuotas[unmet] ?? 0}`);
    }
  }
  throw new Error("evaluation_session_partition_failed");
}

export function selectEvaluationCases(pool, options = {}) {
  const seed = options.seed ?? "orgbrain-memory-extraction-local-v1";
  const calibrationQuotas = options.calibrationQuotas ?? DEFAULT_CALIBRATION_QUOTAS;
  const lockedQuotas = options.lockedQuotas ?? DEFAULT_LOCKED_QUOTAS;
  const { calibration, locked, calibrationSessions } = partitionEvaluationSessions(
    pool,
    calibrationQuotas,
    lockedQuotas,
    seed
  );
  const selectedIds = new Set([...calibration.selected, ...locked.selected].map((item) => item.id));
  if (selectedIds.size !== calibration.selected.length + locked.selected.length) throw new Error("duplicate_evaluation_case");
  return {
    cases: [...calibration.selected, ...locked.selected],
    sampling: {
      seed_hash: `sha256:${hash(seed)}`,
      calibration_quotas: calibrationQuotas,
      locked_quotas: lockedQuotas,
      eligible_by_phase: { calibration: calibration.eligibleCounts, locked: locked.eligibleCounts },
      calibration_session_count: calibrationSessions.size,
      session_overlap: 0,
      inclusion_probability_state: "unverified_grouped_deterministic_sampling"
    }
  };
}

export function buildEvaluationBundle(selection, options = {}) {
  const frozenAt = options.frozenAt ?? new Date().toISOString();
  const frozenMs = Date.parse(frozenAt);
  const cases = selection.cases.map(({ eligible_cohorts: _eligible, occurred_at: _occurredAt, ...item }) => ({
    ...item,
    expires_at: new Date(frozenMs + (item.retention_class === "sensitive" ? 7 : 180) * 24 * 60 * 60 * 1_000).toISOString()
  }));
  return {
    contract: EVALUATION_CONTRACT,
    set_id: options.setId ?? `local-${frozenAt.slice(0, 10)}`,
    frozen_at: frozenAt,
    guideline_version: options.guidelineVersion ?? "memory-extraction-evaluation-guideline/2026-09-03",
    sampling: selection.sampling,
    privacy: {
      source: "local_codex_sessions",
      raw_transcript_persisted: false,
      reasoning_read: false,
      absolute_paths_included: false,
      external_network: false
    },
    cases
  };
}

export function writePrivateJson(file, value) {
  const destination = path.resolve(file);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
  return destination;
}

function optionValues(argv, name) {
  return argv.flatMap((arg, index) => arg === name && argv[index + 1] ? [argv[index + 1]] : []);
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  const outputValue = option(argv, "--output");
  if (!outputValue) throw new Error("--output is required");
  const roots = optionValues(argv, "--sessions-root");
  const sessionsRoots = (roots.length ? roots : [path.join(os.homedir(), ".codex", "sessions"), path.join(os.homedir(), ".codex", "archived_sessions")])
    .map((item) => path.resolve(item));
  const output = path.resolve(outputValue);
  const reportPath = path.resolve(option(argv, "--report", `${output}.report.json`));
  const seed = option(argv, "--seed", "orgbrain-memory-extraction-local-v1");
  const { pool, source } = await buildEvaluationPool({ sessionsRoots });
  const selection = selectEvaluationCases(pool, { seed });
  const bundle = buildEvaluationBundle(selection, {
    setId: option(argv, "--set-id", `local-evaluation-${new Date().toISOString().slice(0, 10)}`)
  });
  writePrivateJson(output, bundle);
  const report = {
    schema_version: 1,
    output,
    bundle_hash: `sha256:${hash(stableJson(bundle))}`,
    counts: {
      source_sessions: source.session_count,
      eligible_cases: pool.length,
      selected_cases: bundle.cases.length,
      calibration: bundle.cases.filter((item) => item.phase === "calibration").length,
      locked: bundle.cases.filter((item) => item.phase === "locked").length,
      by_cohort: Object.fromEntries(COHORT_ORDER.map((cohort) => [cohort, bundle.cases.filter((item) => item.cohort === cohort).length])),
      sensitive: bundle.cases.filter((item) => item.retention_class === "sensitive").length
    },
    source_exclusions: source.excluded,
    sampling: bundle.sampling,
    privacy: bundle.privacy
  };
  writePrivateJson(reportPath, report);
  process.stdout.write(`${JSON.stringify({ ok: true, output, report: reportPath, counts: report.counts, privacy: report.privacy })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
