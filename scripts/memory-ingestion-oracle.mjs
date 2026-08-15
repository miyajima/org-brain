#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  normalizeMemoryContractV2Event,
  observeMemoryContractV2Event
} from "../packages/shared/src/memory-contract-v2-runtime.mjs";
import { verifyLearningEvent } from "../packages/orgbrain-cli/src/lib/memory-learning-transcript.mjs";
import { createCodexSessionImportReport } from "../packages/orgbrain-cli/src/codex-session-import.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_ORACLE = path.join(
  ROOT,
  "packages/shared/test/fixtures/memory-ingestion-oracle-v1.json"
);
export const DEFAULT_ORACLE_LOCK = `${DEFAULT_ORACLE}.sha256`;

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function oracleDatasetHash(definition) {
  return `sha256:${hash(stableJson(definition))}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const output = target && typeof target === "object" && !Array.isArray(target) ? clone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete output[key];
    else output[key] = mergePatch(output[key], value);
  }
  return output;
}

function sorted(values) {
  return [...new Set(values.map(String))].sort();
}

function sameCodes(actual, expected) {
  return JSON.stringify(sorted(actual ?? [])) === JSON.stringify(sorted(expected ?? []));
}

function forbiddenFixtureText(definition) {
  const text = JSON.stringify(definition);
  return [
    /\/Users\/[A-Za-z0-9._-]+\//u,
    /\bsk-[A-Za-z0-9]{20,}\b/u,
    /\bAKIA[A-Z0-9]{16}\b/u,
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/u
  ].filter((pattern) => pattern.test(text)).map((pattern) => String(pattern));
}

export function validateMemoryIngestionOracleDefinition(definition, expectedHash = null) {
  const errors = [];
  if (definition?.schema_version !== 1) errors.push("schema_version_must_be_1");
  if (definition?.split !== "locked_test") errors.push("oracle_must_be_locked_test");
  if (definition?.label_policy?.labels_are_static !== true) errors.push("labels_must_be_static");
  if (definition?.label_policy?.labels_derived_from_runtime !== false) errors.push("runtime_derived_labels_forbidden");
  if (definition?.label_policy?.oracle_precedes_quality_measurement !== true) errors.push("oracle_must_precede_measurement");
  const layers = {
    contract: Array.isArray(definition?.contract_cases) ? definition.contract_cases : [],
    verification: Array.isArray(definition?.verification_cases) ? definition.verification_cases : [],
    routing: Array.isArray(definition?.routing_cases) ? definition.routing_cases : []
  };
  const allCases = Object.values(layers).flat();
  const ids = allCases.map((item) => String(item?.id ?? ""));
  if (ids.some((id) => !id)) errors.push("case_id_required");
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length) errors.push("duplicate_case_id");
  for (const item of allCases) {
    if (!item.expected || typeof item.expected !== "object") errors.push(`expected_required:${item.id}`);
  }
  for (const item of [...layers.contract, ...layers.verification]) {
    if (!definition?.event_catalog?.[item.event]) errors.push(`unknown_event:${item.id}`);
  }
  const idSet = new Set(ids);
  for (const pair of definition?.metamorphic_pairs ?? []) {
    if (!idSet.has(pair.control) || !idSet.has(pair.mutation)) errors.push(`metamorphic_reference_missing:${pair.id}`);
  }
  const leakageViolations = forbiddenFixtureText(definition);
  if (leakageViolations.length) errors.push("fixture_secret_or_home_path_detected");
  const actualHash = oracleDatasetHash(definition);
  if (expectedHash && actualHash !== expectedHash.trim()) errors.push("oracle_hash_mismatch");
  return {
    passed: errors.length === 0,
    errors: sorted(errors),
    dataset_sha256: actualHash,
    duplicate_ids: sorted(duplicateIds).length,
    leakage_violations: leakageViolations.length,
    layer_counts: Object.fromEntries(Object.entries(layers).map(([key, values]) => [key, values.length])),
    total_cases: allCases.length
  };
}

export async function loadMemoryIngestionOracle(options = {}) {
  const definitionPath = path.resolve(options.definitionPath ?? DEFAULT_ORACLE);
  const lockPath = path.resolve(options.lockPath ?? `${definitionPath}.sha256`);
  const definition = JSON.parse(await readFile(definitionPath, "utf8"));
  const expectedHash = (await readFile(lockPath, "utf8")).trim();
  return { definition, expectedHash, definitionPath, lockPath };
}

function row(payload, second = 0) {
  return {
    timestamp: `2026-08-14T02:00:${String(second).padStart(2, "0")}.000Z`,
    type: "event_msg",
    payload
  };
}

function commandRows(commands = [], offset = 1) {
  const rows = [];
  commands.forEach((command, index) => {
    const callId = `oracle-exec-${offset}-${index}`;
    rows.push(row({ type: "custom_tool_call", name: "exec", call_id: callId, input: { cmd: command.ref } }, offset + index * 2));
    rows.push(row({ type: "custom_tool_call_output", call_id: callId, output: `Script completed; exit_code=${command.exit_code}` }, offset + index * 2 + 1));
  });
  return rows;
}

function verificationRows(scenario = {}) {
  const rows = [row({ type: "turn_context", turn_id: "oracle-turn" }, 0)];
  if (scenario.user_text) rows.push(row({ type: "user_message", message: scenario.user_text }, 1));
  rows.push(...commandRows(scenario.commands ?? [], 2));
  return rows;
}

async function createOracleWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-ingestion-oracle-"));
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  const evidence = [
    "export const ORACLE_SUCCESS_PROCEDURE = true;",
    "export const LOCKED_IMPORT_POLICY = 'Choose review-first import policy';"
  ].join("\n");
  await writeFile(path.join(workspace, "src", "oracle-clean.mjs"), `${evidence}\n`, "utf8");
  await writeFile(path.join(workspace, "src", "oracle-dirty.mjs"), `${evidence}\n`, "utf8");
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "oracle@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Oracle Fixture"], { cwd: workspace });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "locked oracle base"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "src", "oracle-dirty.mjs"), `${evidence}\nexport const ORACLE_DIRTY_EVIDENCE = true;\n`, "utf8");
  return { root, workspace, otherWorkspace };
}

function localEnv(root) {
  return {
    ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
    ORGBRAIN_ENABLE_ORG_SHARING: "false",
    ORGBRAIN_TENANT_ID: "default",
    ORGBRAIN_LOCAL_DB: path.join(root, "oracle.sqlite"),
    ORGBRAIN_WORKSPACES_FILE: path.join(root, "missing-workspaces.json"),
    ORGBRAIN_HOOK_ENV_FILES: path.join(root, "missing-hooks.env")
  };
}

async function writeSession(sessionsRoot, item, cwd, rows) {
  await mkdir(sessionsRoot, { recursive: true });
  const meta = {
    timestamp: "2026-08-14T02:00:00.000Z",
    type: "session_meta",
    payload: {
      id: `oracle-${item.id}`,
      cwd,
      thread_source: item.thread_source ?? "user"
    }
  };
  await writeFile(path.join(sessionsRoot, `${item.id}.jsonl`), `${[meta, ...rows].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function durableFinalAnswer() {
  return [
    "## Conclusion",
    "Stop hookは既知のcapture toolを必ず一回だけ呼ぶ。",
    "",
    "## Rationale",
    "tool discoveryと複数送信を避けることで、停止処理の遅延と重複保存を防げるため。",
    "",
    "## Reuse",
    "新しいagent lifecycle hookでは候補を一つのbatch requestへまとめる。",
    "",
    "## Evidence",
    "packages/orgbrain-cli/src/hook-memory-bridge.mjs",
    "scripts/hook-memory-bridge.test.mjs"
  ].join("\n");
}

function defaultVerificationScenario(eventName) {
  if (eventName === "success") return { commands: [{ ref: "node --test oracle-success", exit_code: 0 }] };
  if (eventName === "decision") return { user_text: "Choose review-first import policy" };
  return {
    commands: [
      { ref: "node --test oracle-failure-before", exit_code: 1 },
      { ref: "node --test oracle-failure-after", exit_code: 0 }
    ]
  };
}

async function routingRows(item, definition, workspace) {
  if (item.scenario === "no_final") return [row({ type: "turn_context", turn_id: item.id }, 0)];
  if (item.scenario === "final") {
    return [
      row({ type: "turn_context", turn_id: item.id }, 0),
      row({ type: "agent_message", phase: "final_answer", message: item.text }, 1)
    ];
  }
  if (item.scenario === "durable_final") {
    return [
      row({ type: "turn_context", turn_id: item.id }, 0),
      row({ type: "agent_message", phase: "final_answer", message: durableFinalAnswer() }, 1)
    ];
  }
  const event = clone(definition.event_catalog[item.event]);
  if (item.scenario === "incomplete_observe") {
    return [
      row({ type: "turn_context", turn_id: item.id }, 0),
      row({ type: "custom_tool_call", name: "orgbrain_memory_observe", call_id: `observe-${item.id}`, input: event }, 1),
      row({ type: "agent_message", phase: "final_answer", message: "The observation was submitted without an accepted result." }, 2)
    ];
  }
  const rows = verificationRows(defaultVerificationScenario(item.event));
  rows[0] = row({ type: "turn_context", turn_id: item.id }, 0);
  const observed = await observeMemoryContractV2Event(event, { workspaceRoot: workspace });
  rows.push(row({
    type: "mcp_tool_call_end",
    invocation: { tool: "orgbrain_memory_observe", arguments: event },
    result: { Ok: { content: [{ type: "text", text: JSON.stringify(observed) }] } }
  }, 8));
  rows.push(row({ type: "agent_message", phase: "final_answer", message: "The locked observation was processed." }, 9));
  return rows;
}

function compareOutcome(layer, item, actual) {
  const errors = [];
  if (layer === "contract") {
    if (actual.accepted !== item.expected.accepted) errors.push("accepted_mismatch");
    if (!sameCodes(actual.reason_codes, item.expected.reason_codes)) errors.push("reason_codes_mismatch");
  } else if (layer === "verification") {
    if (actual.state !== item.expected.state) errors.push("state_mismatch");
    if (!sameCodes(actual.reason_codes, item.expected.reason_codes)) errors.push("reason_codes_mismatch");
  } else {
    if (actual.route !== item.expected.route) errors.push("route_mismatch");
    if (item.expected.lesson_type && actual.lesson_type !== item.expected.lesson_type) errors.push("lesson_type_mismatch");
    const expectedReasons = item.expected.reason_codes ?? [];
    if (expectedReasons.some((code) => !actual.reason_codes.includes(code))) errors.push("reason_codes_missing");
    if (item.expected.scan_reason && actual.scan_reason !== item.expected.scan_reason) errors.push("scan_reason_mismatch");
  }
  return errors;
}

export async function qualifyMemoryIngestionOracle(options = {}) {
  const loaded = options.definition
    ? { definition: options.definition, expectedHash: options.expectedHash ?? null }
    : await loadMemoryIngestionOracle(options);
  const structural = validateMemoryIngestionOracleDefinition(loaded.definition, loaded.expectedHash);
  const definition = loaded.definition;
  const workspaceState = await createOracleWorkspace();
  const outcomes = new Map();
  const mismatches = [];
  try {
    for (const item of definition.contract_cases) {
      const input = mergePatch(definition.event_catalog[item.event], item.patch ?? {});
      const normalized = await normalizeMemoryContractV2Event(input, { workspaceRoot: workspaceState.workspace });
      const actual = { accepted: normalized.accepted, reason_codes: normalized.reason_codes ?? [] };
      outcomes.set(`contract:${item.id}`, actual.accepted ? "accepted" : "rejected");
      const errors = compareOutcome("contract", item, actual);
      if (errors.length) mismatches.push({ layer: "contract", id: item.id, errors, actual });
    }
    for (const item of definition.verification_cases) {
      const input = mergePatch(definition.event_catalog[item.event], item.event_patch ?? {});
      const normalized = await normalizeMemoryContractV2Event(input, { workspaceRoot: workspaceState.workspace });
      if (!normalized.accepted) {
        mismatches.push({ layer: "verification", id: item.id, errors: ["oracle_event_rejected"], actual: normalized.reason_codes });
        outcomes.set(`verification:${item.id}`, "rejected");
        continue;
      }
      const rows = verificationRows(item.scenario);
      const verification = await verifyLearningEvent(normalized.event, {
        rows,
        userText: item.scenario?.user_text ?? "",
        toolResults: JSON.stringify(rows),
        workspaceRoot: workspaceState.workspace
      });
      const actual = { state: verification.verification_state, reason_codes: verification.reason_codes ?? [] };
      outcomes.set(`verification:${item.id}`, actual.state);
      const errors = compareOutcome("verification", item, actual);
      if (errors.length) mismatches.push({ layer: "verification", id: item.id, errors, actual });
    }
    for (const item of definition.routing_cases) {
      const sessionsRoot = path.join(workspaceState.root, "sessions", item.id);
      const cwd = item.workspace === "other" ? workspaceState.otherWorkspace : workspaceState.workspace;
      await writeSession(sessionsRoot, item, cwd, await routingRows(item, definition, workspaceState.workspace));
      const report = await createCodexSessionImportReport({
        workspaceRoot: workspaceState.workspace,
        sessionsRoot,
        env: localEnv(workspaceState.root)
      });
      const active = report.plan.batches.flatMap((batch) => batch.active);
      const review = report.plan.batches.flatMap((batch) => batch.review);
      const route = active.length ? "active" : review.length ? "review" : "excluded";
      const reasonCodes = sorted([
        ...report.plan.batches.flatMap((batch) => batch.excluded_reason_codes),
        ...review.flatMap((candidate) => candidate.reason_codes ?? [])
      ]);
      const scanReason = Object.keys(report.summary.scan_exclusion_counts).find((key) => report.summary.scan_exclusion_counts[key] > 0) ?? null;
      const actual = {
        route,
        lesson_type: active[0]?.learning?.lesson_type ?? null,
        reason_codes: reasonCodes,
        scan_reason: scanReason
      };
      outcomes.set(`routing:${item.id}`, route);
      const errors = compareOutcome("routing", item, actual);
      if (errors.length) mismatches.push({ layer: "routing", id: item.id, errors, actual });
    }
  } finally {
    await rm(workspaceState.root, { recursive: true, force: true });
  }

  const metamorphicViolations = [];
  for (const pair of definition.metamorphic_pairs ?? []) {
    const control = outcomes.get(`${pair.layer}:${pair.control}`);
    const mutation = outcomes.get(`${pair.layer}:${pair.mutation}`);
    const actualTransition = `${control}->${mutation}`;
    if (actualTransition !== pair.expected_transition) {
      metamorphicViolations.push({ id: pair.id, expected: pair.expected_transition, actual: actualTransition });
    }
  }
  const routeCounts = Object.fromEntries(["active", "review", "excluded"].map((route) => [
    route,
    [...outcomes.entries()].filter(([key, value]) => key.startsWith("routing:") && value === route).length
  ]));
  const passed = structural.passed && mismatches.length === 0 && metamorphicViolations.length === 0;
  return {
    schema_version: 1,
    dataset_id: definition.dataset_id,
    dataset_sha256: structural.dataset_sha256,
    locked: Boolean(loaded.expectedHash) && structural.dataset_sha256 === loaded.expectedHash?.trim(),
    passed,
    status: passed ? "qualified" : "not_qualified",
    total_cases: structural.total_cases,
    layer_counts: structural.layer_counts,
    route_counts: routeCounts,
    label_mismatches: mismatches,
    label_mismatch_count: mismatches.length,
    metamorphic_pair_count: definition.metamorphic_pairs?.length ?? 0,
    metamorphic_violations: metamorphicViolations,
    metamorphic_violation_count: metamorphicViolations.length,
    duplicate_ids: structural.duplicate_ids,
    leakage_violations: structural.leakage_violations,
    structural_errors: structural.errors,
    labels_static: definition.label_policy?.labels_are_static === true,
    labels_derived_from_runtime: definition.label_policy?.labels_derived_from_runtime !== false
  };
}

async function main(argv = process.argv.slice(2)) {
  const definitionIndex = argv.indexOf("--definition");
  const lockIndex = argv.indexOf("--lock");
  const outputIndex = argv.indexOf("--output");
  const result = await qualifyMemoryIngestionOracle({
    ...(definitionIndex >= 0 ? { definitionPath: argv[definitionIndex + 1] } : {}),
    ...(lockIndex >= 0 ? { lockPath: argv[lockIndex + 1] } : {})
  });
  if (outputIndex >= 0) {
    const outputValue = argv[outputIndex + 1];
    if (!outputValue || outputValue.startsWith("--")) throw new Error("--output requires a path");
    const outputPath = path.resolve(outputValue);
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(outputPath), 0o700);
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    await chmod(outputPath, 0o600);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
