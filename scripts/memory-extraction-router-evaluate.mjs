#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MEMORY_EXTRACTION_ROUTER_MODEL_V2 } from "../packages/orgbrain-cli/src/lib/memory-extraction-router-model-v2.mjs";
import { MEMORY_EXTRACTION_ROUTER_MODEL_V3 } from "../packages/orgbrain-cli/src/lib/memory-extraction-router-model-v3.mjs";
import {
  buildLearningExtractionPacket,
  discoverLearningEpisodes,
} from "../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs";
import { sanitizeMemoryExtractionReviewCase } from "../packages/shared/src/memory-extraction-review-text-runtime.mjs";
import { SAFETY_FIXTURE_SHA256 } from "./memory-extraction-router-safety-v3.mjs";
import { validateRouterGoldRows } from "./memory-extraction-router-input.mjs";
import { verifyDiverseSafety } from "./memory-extraction-router-safety-v31.mjs";
import { DIVERSE_SAFETY_SHA256 } from "./memory-extraction-router-safety-fixture-v2.mjs";

export const ROUTER_EVALUATION_CONTRACT = "memory-extraction-router-shadow-evaluation/v3";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(6));
}

function metrics(rows, gold, predicted) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const row of rows) {
    const actual = Boolean(gold(row));
    const guess = Boolean(predicted(row));
    if (actual && guess) tp += 1;
    else if (!actual && guess) fp += 1;
    else if (actual && !guess) fn += 1;
    else tn += 1;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : ratio(2 * precision * recall, precision + recall);
  return { tp, fp, tn, fn, precision, recall, f1, support_positive: tp + fn, support_negative: tn + fp };
}

function parseJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function turnEvidence(caseItem) {
  const reviewCase = sanitizeMemoryExtractionReviewCase(caseItem);
  return {
    schema: "turn-evidence/v1",
    session_hash: caseItem.session_hash,
    turn_hash: caseItem.source_hash,
    project_id: caseItem.project_hash ? `hash:${caseItem.project_hash}` : null,
    provider: "shadow-local",
    model: "none",
    snippets: reviewCase.turns.map((turn) => ({ span_id: turn.id, role: turn.role, text: turn.content })),
    events: [],
    hard_exclusion_reason: null
  };
}

function overlaps(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(leftStart, rightStart) < Math.min(leftEnd, rightEnd);
}

function packetGrounding(caseItem, packet, goldSpans) {
  const reviewCase = sanitizeMemoryExtractionReviewCase(caseItem);
  const turns = new Map(reviewCase.turns.map((turn) => [turn.id, turn.content]));
  let exact = Boolean(packet?.snippets?.length);
  let overlap = false;
  const covered = new Map();
  for (const snippet of packet?.snippets ?? []) {
    const parentId = snippet.parent_span_id ?? String(snippet.span_id).split(".")[0];
    const parent = turns.get(parentId) ?? "";
    const starts = [];
    let start = Number.isInteger(snippet.start) ? snippet.start : parent.indexOf(snippet.text);
    if (Number.isInteger(snippet.start)) {
      if (parent.slice(snippet.start, snippet.end) !== snippet.text) { exact = false; continue; }
      starts.push(start);
      start = -1;
    }
    while (start >= 0) {
      starts.push(start);
      start = parent.indexOf(snippet.text, start + 1);
    }
    if (starts.length === 0) exact = false;
    if (!covered.has(parentId)) covered.set(parentId, []);
    // Legacy spans lack offsets: select one real occurrence, never credit all
    // repeated occurrences for one transmitted snippet.
    if (starts.length) covered.get(parentId).push([starts[0], starts[0] + snippet.text.length]);
    if (goldSpans.some((gold) => gold.turn_id === parentId
      && starts.some((position) => overlaps(position, position + snippet.text.length, gold.start, gold.end)))) overlap = true;
  }
  const union = (ranges) => {
    const result = [];
    for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
      const last = result.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else result.push([start, end]);
    }
    return result;
  };
  const goldByParent = new Map();
  for (const span of goldSpans) {
    if (!goldByParent.has(span.turn_id)) goldByParent.set(span.turn_id, []);
    goldByParent.get(span.turn_id).push([span.start, span.end]);
  }
  let goldUnits = 0; let coveredUnits = 0;
  for (const [id, ranges] of goldByParent) {
    const gold = union(ranges); const selected = union(covered.get(id) ?? []);
    goldUnits += gold.reduce((sum, [start, end]) => sum + end - start, 0);
    for (const [start, end] of gold) for (const [left, right] of selected) coveredUnits += Math.max(0, Math.min(end, right) - Math.max(start, left));
  }
  const full = goldSpans.filter((span) => union(covered.get(span.turn_id) ?? []).some(([start, end]) => start <= span.start && end >= span.end)).length;
  return { exact, overlap, packed_spans: packet?.snippets?.length ?? 0, full_gold_spans: full,
    gold_spans: goldSpans.length, gold_units: goldUnits, covered_units: coveredUnits };
}

async function evaluateModel(bundle, goldByCase, model) {
  const rows = [];
  for (const caseItem of bundle.cases) {
    const gold = goldByCase.get(caseItem.id);
    if (!gold) throw new Error(`router_evaluation_missing_gold:${caseItem.id}`);
    const evidence = turnEvidence(caseItem);
    let routing = null;
    try {
      const discovery = await discoverLearningEpisodes(evidence, { router_model: model });
      routing = discovery.routing;
      const packet = discovery.llm_recommended ? buildLearningExtractionPacket(evidence, discovery) : null;
      rows.push({
        case_id: caseItem.id,
        phase: caseItem.phase,
        session_hash: caseItem.session_hash,
        gold: gold.gold,
        route: discovery.routing,
        packet: packet ? {
          schema: packet.schema,
          snippets: packet.snippets,
          packet_hash: packet.packet_hash
        } : null,
        grounding: packetGrounding(caseItem, packet, gold.gold.evidence_spans ?? []),
        error: null
      });
    } catch (error) {
      rows.push({
        case_id: caseItem.id,
        phase: caseItem.phase,
        session_hash: caseItem.session_hash,
        gold: gold.gold,
        route: routing ?? { llm_recommended: false, primary_route: "error" },
        packet: null,
        grounding: packetGrounding(caseItem, null, gold.gold.evidence_spans ?? []),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return rows;
}

function summary(rows) {
  const evidenceRows = rows.filter((row) => (row.gold.evidence_spans ?? []).length > 0);
  const packets = rows.filter((row) => row.packet);
  const sum = (key) => rows.reduce((total, row) => total + (row.grounding[key] ?? 0), 0);
  return {
    cases: rows.length,
    durable: metrics(rows, (row) => row.gold.usefulness === "durable_memory", (row) => row.route.primary_route === "llm_candidate" || row.route.disposition === "llm_candidate"),
    operational_history: metrics(rows, (row) => row.gold.usefulness === "operational_history_only", (row) => row.route.primary_route
      ? row.route.primary_route === "operational_history" : row.route.decisions?.operational_history === true),
    llm_call_rate: ratio(rows.filter((row) => row.route.llm_recommended).length, rows.length),
    actual_llm_called_turn_rate: 0,
    joint_route_rate: ratio(rows.filter((row) => row.route.decisions?.durable_candidate && row.route.decisions?.operational_history).length, rows.length),
    packet_exact_source_rate: ratio(packets.filter((row) => row.grounding.exact).length, packets.length),
    packed_evidence_coverage: ratio(evidenceRows.filter((row) => row.grounding.overlap).length, evidenceRows.length),
    packed_evidence_support: evidenceRows.length,
    full_span_recall: ratio(sum("full_gold_spans"), rows.reduce((total, row) => total + (row.gold.evidence_spans ?? []).length, 0)),
    character_coverage: ratio(sum("covered_units"), sum("gold_units")),
    packed_spans: packets.reduce((sum, row) => sum + row.grounding.packed_spans, 0),
    errors: rows.filter((row) => row.error).length
  };
}

export async function evaluateRouterShadow(bundle, goldRows, options = {}) {
  const goldByCase = new Map(goldRows.map((row) => [row.case_id, row]));
  if (goldRows.length !== goldByCase.size) throw new Error("router_evaluation_duplicate_gold");
  validateRouterGoldRows(bundle, goldRows);
  if (goldByCase.size !== bundle.cases.length) throw new Error("router_evaluation_gold_count_mismatch");
  const v2Rows = await evaluateModel(bundle, goldByCase, options.v2_model ?? MEMORY_EXTRACTION_ROUTER_MODEL_V2);
  const v3Rows = await evaluateModel(bundle, goldByCase, options.v3_model ?? MEMORY_EXTRACTION_ROUTER_MODEL_V3);
  const summarizeSet = (rows, phase, semantic) => summary(rows.filter((row) => row.phase === phase && (!semantic || row.gold.usefulness !== "excluded")));
  const report = {
    contract: ROUTER_EVALUATION_CONTRACT,
    generated_at: options.generated_at ?? new Date().toISOString(),
    inputs: {
      bundle_sha256: sha256(stableJson(bundle)),
      gold_sha256: sha256(goldRows.map((row) => stableJson(row)).join("\n")),
      cases: bundle.cases.length,
      v2_model_sha256: sha256(stableJson(options.v2_model ?? MEMORY_EXTRACTION_ROUTER_MODEL_V2)),
      v3_model_sha256: sha256(stableJson(options.v3_model ?? MEMORY_EXTRACTION_ROUTER_MODEL_V3)),
      labels: "single-reviewer AI-assisted development/shadow labels"
    },
    v2: {
      all: { calibration: summarizeSet(v2Rows, "calibration", false), locked: summarizeSet(v2Rows, "locked", false) },
      semantic: { calibration: summarizeSet(v2Rows, "calibration", true), locked: summarizeSet(v2Rows, "locked", true) }
    },
    v3: {
      all: { calibration: summarizeSet(v3Rows, "calibration", false), locked: summarizeSet(v3Rows, "locked", false) },
      semantic: { calibration: summarizeSet(v3Rows, "calibration", true), locked: summarizeSet(v3Rows, "locked", true) }
    },
    policy: {
      calibration_only_training: true,
      locked_used_for_training_or_threshold_selection: false,
      sanitized_hard_exclusion_evaluable: false,
      external_network: false,
      persistence_performed: false,
      production_readiness_claimed: false,
      locked_evidence_kind: "previously_viewed_regression_only",
      metric_definitions: {
        packet_exact_source_rate: "Packed router evidence text is an exact substring of the current-turn source before any LLM call.",
        packed_evidence_coverage: "Gold evidence cases with at least one overlapping packed router span.",
        llm_output_exact_grounding: "Unavailable until an authorized same-input paired provider evaluation; historical draft rates are not comparable."
      }
    }
  };
  const locked = report.v3.semantic.locked;
  const baseline = report.v2.semantic.locked;
  report.local_gates = {
    durable_recall: { pass: locked.durable.recall >= 0.95, actual: locked.durable.recall, minimum: 0.95 },
    operational_f1: { pass: locked.operational_history.f1 >= 0.75, actual: locked.operational_history.f1, minimum: 0.75 },
    llm_call_rate: { pass: locked.llm_call_rate <= 0.5, actual: locked.llm_call_rate, maximum: 0.5 },
    packet_exact_source_not_worse_than_v2: { pass: locked.packet_exact_source_rate >= baseline.packet_exact_source_rate, actual: locked.packet_exact_source_rate, baseline: baseline.packet_exact_source_rate },
    packed_evidence_not_worse_than_v2: { pass: locked.packed_evidence_coverage >= baseline.packed_evidence_coverage, actual: locked.packed_evidence_coverage, baseline: baseline.packed_evidence_coverage },
    full_span_not_worse_than_v2: { pass: locked.full_span_recall >= baseline.full_span_recall, actual: locked.full_span_recall, baseline: baseline.full_span_recall },
    character_coverage_not_worse_than_v2: { pass: locked.character_coverage >= baseline.character_coverage, actual: locked.character_coverage, baseline: baseline.character_coverage },
    errors: { pass: v3Rows.every((row) => !row.error), actual: v3Rows.filter((row) => row.error).length, population: v3Rows.length, maximum: 0 }
  };
  for (const gate of Object.values(report.local_gates)) {
    if (!Number.isFinite(gate.actual) || "baseline" in gate && !Number.isFinite(gate.baseline)) gate.pass = false;
  }
  refreshLlmStageGate(report);
  if (options.safety_report) attachSafetyGate(report, options.safety_report);
  return { report, rows: { v2: v2Rows, v3: v3Rows } };
}

export function attachSafetyGate(report, safetyDocument) {
  let safety = safetyDocument?.report ?? safetyDocument;
  const diverse = safety?.fixture_sha256 === DIVERSE_SAFETY_SHA256;
  if (diverse) safety = verifyDiverseSafety(safetyDocument);
  const locked = safety?.phases?.locked;
  if (![SAFETY_FIXTURE_SHA256, DIVERSE_SAFETY_SHA256].includes(safety?.fixture_sha256) || !locked) {
    throw new Error("router_evaluation_invalid_safety_report");
  }
  report.inputs.safety_fixture_sha256 = safety.fixture_sha256;
  for (const router of [report.v2, report.v3]) {
    for (const group of [router?.all, router?.semantic]) {
      for (const phase of [group?.calibration, group?.locked]) {
        if (phase && phase.packet_exact_source_rate === undefined && phase.exact_grounding_rate !== undefined) {
          phase.packet_exact_source_rate = phase.exact_grounding_rate;
          delete phase.exact_grounding_rate;
        }
      }
    }
  }
  if (report.local_gates.exact_grounding_not_worse_than_v2) {
    report.local_gates.packet_exact_source_not_worse_than_v2 = report.local_gates.exact_grounding_not_worse_than_v2;
    delete report.local_gates.exact_grounding_not_worse_than_v2;
  }
  report.policy ??= {};
  report.policy.metric_definitions = {
    packet_exact_source_rate: "Packed router evidence text is an exact substring of the current-turn source before any LLM call.",
    packed_evidence_coverage: "Gold evidence cases with at least one overlapping packed router span.",
    llm_output_exact_grounding: "Requires authorized same-input paired provider evaluation; historical draft rates are not comparable."
  };
  delete report.local_gates.pass;
  report.local_gates.safety_locked = {
    pass: diverse && locked.unsafe_total === 80
      && locked.unsafe_excluded === 80
      && locked.benign_total === 80
      && locked.benign_false_excluded === 0
      && locked.gate_pass === true,
    unsafe_excluded: locked.unsafe_excluded,
    unsafe_total: locked.unsafe_total,
    benign_false_excluded: locked.benign_false_excluded,
    benign_total: locked.benign_total,
    fixture_sha256: safety.fixture_sha256
  };
  refreshLlmStageGate(report);
  return report;
}

function refreshLlmStageGate(report) {
  delete report.local_gates.pass;
  delete report.local_gates.llm_output_exact_grounding;
  const routerPrerequisites = [
    "durable_recall",
    "operational_f1",
    "llm_call_rate",
    "packed_evidence_not_worse_than_v2",
    "full_span_not_worse_than_v2",
    "character_coverage_not_worse_than_v2",
    "packet_exact_source_not_worse_than_v2",
    "errors",
    "safety_locked"
  ];
  const routerPass = routerPrerequisites.every((name) => report.local_gates[name]?.pass === true);
  // A caller-supplied boolean is never evidence of provider execution.
  report.local_gates.llm_output_exact_grounding = {
        pass: false,
        status: routerPass ? "unsupported_token_profile" : "not_run_router_gate_failed",
        actual: null,
        baseline: null
      };
  report.local_gates.pass = Object.values(report.local_gates).every((gate) => typeof gate !== "object" || gate.pass === true);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
}

export async function main(argv = process.argv.slice(2)) {
  const existingReportPath = option(argv, "--existing-report");
  const safetyPath = option(argv, "--safety-report");
  if (existingReportPath) {
    if (!safetyPath) throw new Error("usage: --existing-report FILE --safety-report FILE [--output FILE]");
    const report = JSON.parse(fs.readFileSync(path.resolve(existingReportPath), "utf8"));
    const safety = JSON.parse(fs.readFileSync(path.resolve(safetyPath), "utf8"));
    const output = path.resolve(option(argv, "--output") ?? existingReportPath);
    attachSafetyGate(report, safety);
    writePrivate(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ report: output, local_gates: report.local_gates })}\n`);
    return;
  }
  const bundlePath = option(argv, "--bundle");
  const goldPath = option(argv, "--runtime-cases");
  const outputDir = option(argv, "--output-dir");
  if (!bundlePath || !goldPath || !outputDir) throw new Error("usage: --bundle FILE --runtime-cases JSONL --output-dir DIR");
  const bundle = JSON.parse(fs.readFileSync(path.resolve(bundlePath), "utf8"));
  const goldRows = parseJsonl(path.resolve(goldPath));
  const safety = safetyPath ? JSON.parse(fs.readFileSync(path.resolve(safetyPath), "utf8")) : null;
  const modelPath = option(argv, "--v3-model");
  const modelDocument = modelPath ? JSON.parse(fs.readFileSync(path.resolve(modelPath), "utf8")) : null;
  const result = await evaluateRouterShadow(bundle, goldRows, { ...(safety ? { safety_report: safety } : {}),
    ...(modelDocument ? { v3_model: modelDocument.model ?? modelDocument } : {}) });
  const target = path.resolve(outputDir);
  writePrivate(path.join(target, "router-v3-shadow-report.json"), `${JSON.stringify(result.report, null, 2)}\n`);
  writePrivate(path.join(target, "router-v3-shadow-cases.jsonl"), `${result.rows.v3.map((row) => JSON.stringify(row)).join("\n")}\n`);
  process.stdout.write(`${JSON.stringify({ report: result.report, output_dir: target })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
