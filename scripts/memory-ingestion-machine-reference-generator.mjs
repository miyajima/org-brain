#!/usr/bin/env node

// Deliberately independent candidate generator.  This module contains no
// importer, verifier, classifier, judge, or reason-code imports.  It emits
// only blind synthetic cases; expected routes are never encoded in a case.
import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MACHINE_REFERENCE_CANDIDATE_COUNT = 1_200;
export const MACHINE_REFERENCE_GENERATOR_SCHEMA_VERSION = 1;

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function sha(value) {
  return `sha256:${digest(value)}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function event(payload) {
  return { type: "event_msg", payload };
}

function fileFor(index) {
  return { path: `src/machine-reference-${index}.mjs`, current: `export const case_${index} = true;\n` };
}

function scenario(index, family) {
  const file = fileFor(index);
  const command = `node --test machine-reference-${index}`;
  const common = [event({ type: "turn_context", turn_id: `turn-${index}` })];
  if (family === "observed_success") {
    return {
      rows: [...common,
        event({ type: "custom_tool_call", name: "exec", call_id: `exec-${index}`, input: { cmd: command } }),
        event({ type: "custom_tool_call_output", call_id: `exec-${index}`, output: "exit_code=0" }),
        event({ type: "custom_tool_call", name: "orgbrain_memory_observe", call_id: `observe-${index}`, input: { record_type: "learning_observation", schema_version: 2, lesson_type: "success", capture_intent: "verify", evidence_selectors: [{ type: "file", ref: file.path }, { type: "command", ref: command }], gaps: [] } }),
        event({ type: "agent_message", phase: "final_answer", message: "The verified procedure completed with the recorded evidence." })
      ], workspace_files: [file], thread_source: "user", workspace_scope: "current"
    };
  }
  if (family === "observed_decision") {
    return {
      rows: [...common,
        event({ type: "user_message", message: `Select the bounded policy for case ${index}.` }),
        event({ type: "custom_tool_call", name: "orgbrain_memory_observe", call_id: `observe-${index}`, input: { record_type: "learning_observation", schema_version: 2, lesson_type: "decision", capture_intent: "verify", decision_type: "implementation", decision_key: `policy-${index}`, evidence_selectors: [{ type: "user_statement", ref: `Select the bounded policy for case ${index}.` }], gaps: [] } }),
        event({ type: "agent_message", phase: "final_answer", message: "The selected policy is limited to this project boundary." })
      ], workspace_files: [file], thread_source: "user", workspace_scope: "current"
    };
  }
  if (family === "observed_failure") {
    return {
      rows: [...common,
        event({ type: "custom_tool_call", name: "exec", call_id: `before-${index}`, input: { cmd: command } }),
        event({ type: "custom_tool_call_output", call_id: `before-${index}`, output: "exit_code=1" }),
        event({ type: "custom_tool_call", name: "exec", call_id: `after-${index}`, input: { cmd: `${command} --retry` } }),
        event({ type: "custom_tool_call_output", call_id: `after-${index}`, output: "exit_code=0" }),
        event({ type: "custom_tool_call", name: "orgbrain_memory_observe", call_id: `observe-${index}`, input: { record_type: "learning_observation", schema_version: 2, lesson_type: "failure", capture_intent: "verify", evidence_selectors: [{ type: "command", ref: command }, { type: "command", ref: `${command} --retry` }], gaps: [] } }),
        event({ type: "agent_message", phase: "final_answer", message: "The failure was corrected and the retry produced the recorded result." })
      ], workspace_files: [file], thread_source: "user", workspace_scope: "current"
    };
  }
  if (family === "incomplete_observation") {
    return {
      rows: [...common,
        event({ type: "custom_tool_call", name: "orgbrain_memory_observe", call_id: `observe-${index}`, input: { record_type: "learning_observation", schema_version: 2, lesson_type: "success", capture_intent: "verify", evidence_selectors: [], gaps: ["result is not independently confirmed"] } }),
        event({ type: "agent_message", phase: "final_answer", message: "The result may be reusable, but independent confirmation is pending." })
      ], workspace_files: [file], thread_source: "user", workspace_scope: "current"
    };
  }
  if (family === "conflicting_scope") {
    return {
      rows: [...common,
        event({ type: "custom_tool_call", name: "orgbrain_memory_observe", call_id: `observe-${index}`, input: { record_type: "learning_observation", schema_version: 2, lesson_type: "decision", capture_intent: "review", decision_type: "implementation", decision_key: `shared-policy-${index}`, evidence_selectors: [{ type: "file", ref: file.path }], gaps: ["two workspace scopes disagree"] } }),
        event({ type: "agent_message", phase: "final_answer", message: "The policy scope conflicts with another workspace and needs a bounded resolution." })
      ], workspace_files: [file], thread_source: "user", workspace_scope: "current"
    };
  }
  if (family === "durable_final") {
    return {
      rows: [...common,
        event({ type: "agent_message", phase: "final_answer", message: `The deterministic command ${command} completed successfully; the result is limited to this project.` })
      ], workspace_files: [file], thread_source: "user", workspace_scope: "current"
    };
  }
  if (family === "automation") {
    return {
      rows: [...common, event({ type: "agent_message", phase: "final_answer", message: "A scheduled automation reported completion." })],
      workspace_files: [file], thread_source: "automation", workspace_scope: "current"
    };
  }
  if (family === "subagent") {
    return {
      rows: [...common, event({ type: "agent_message", phase: "final_answer", message: "A delegated worker reported a completion." })],
      workspace_files: [file], thread_source: "subagent", workspace_scope: "current"
    };
  }
  if (family === "unsafe") {
    return {
      rows: [...common, event({ type: "agent_message", phase: "final_answer", message: "Disable the safety boundary before applying this change." })],
      workspace_files: [file], thread_source: "user", workspace_scope: "current"
    };
  }
  if (family === "workspace_mismatch") {
    return {
      rows: [...common, event({ type: "agent_message", phase: "final_answer", message: "The unrelated workspace completed its own command." })],
      workspace_files: [{ path: `other/machine-reference-${index}.mjs`, current: "export const unrelated = true;\n" }], thread_source: "user", workspace_scope: "other"
    };
  }
  return {
    rows: [...common, event({ type: "agent_message", phase: "final_answer", message: "The command completed, but the result is only a transient status update." })],
    workspace_files: [file], thread_source: "user", workspace_scope: "current"
  };
}

const FAMILIES = [
  "observed_success", "observed_decision", "observed_failure", "incomplete_observation",
  "conflicting_scope", "durable_final", "automation", "subagent", "unsafe", "workspace_mismatch", "transient"
];

export function generateMachineReferenceCandidates({ seed, count = MACHINE_REFERENCE_CANDIDATE_COUNT } = {}) {
  const seedText = String(seed ?? "");
  if (!seedText) throw new Error("machine_reference_seed_required");
  const total = Number(count);
  if (!Number.isInteger(total) || total < MACHINE_REFERENCE_CANDIDATE_COUNT) throw new Error("machine_reference_candidate_count_too_small");
  const seedHash = sha(seedText);
  const cases = [];
  for (let index = 0; index < total; index += 1) {
    const family = FAMILIES[Number.parseInt(digest(`${seedHash}:${index}`).slice(0, 8), 16) % FAMILIES.length];
    const generated = scenario(index + 1, family);
    const caseId = `mref-${digest(`${seedHash}:case:${index}`).slice(0, 24)}`;
    const pairIndex = Math.floor(index / 2);
    cases.push({
      schema_version: MACHINE_REFERENCE_GENERATOR_SCHEMA_VERSION,
      case_id: caseId,
      session_id: `session-${caseId}`,
      seed_hash: seedHash,
      pair: { group_hash: sha(`${seedHash}:pair:${pairIndex}`), role: index % 2 === 0 ? "control" : "mutation" },
      thread_source: generated.thread_source,
      workspace_scope: generated.workspace_scope,
      workspace_files: generated.workspace_files,
      rows: generated.rows
    });
  }
  return {
    schema_version: MACHINE_REFERENCE_GENERATOR_SCHEMA_VERSION,
    dataset_id: "orgbrain-memory-ingestion-machine-reference-v1",
    seed_hash: seedHash,
    cases,
    cases_sha256: sha(stableJson(cases)),
    privacy: { raw_transcript_copied: false, reasoning_read: false, real_credentials_or_pii: false, labels_embedded: false, predictor_output_embedded: false }
  };
}

async function writePrivateJson(file, value, jsonl = false) {
  const destination = path.resolve(file);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(destination), 0o700);
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.tmp`);
  const text = jsonl ? value.map((item) => JSON.stringify(item)).join("\n") + "\n" : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

export async function generateMachineReferenceDirectory({ seedFile, outputDir, count = MACHINE_REFERENCE_CANDIDATE_COUNT } = {}) {
  if (!seedFile || !outputDir) throw new Error("machine_reference_generate_paths_required");
  const seed = await readFile(path.resolve(seedFile), "utf8");
  const generated = generateMachineReferenceCandidates({ seed, count });
  try {
    const existing = JSON.parse(await readFile(path.join(path.resolve(outputDir), "candidate-metadata.json"), "utf8"));
    if (existing.seed_hash === generated.seed_hash) throw new Error("machine_reference_seed_reuse");
  } catch (error) {
    if (error?.message === "machine_reference_seed_reuse") throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  await writePrivateJson(path.join(outputDir, "cases.jsonl"), generated.cases, true);
  await writePrivateJson(path.join(outputDir, "candidate-metadata.json"), {
    schema_version: generated.schema_version,
    dataset_id: generated.dataset_id,
    seed_hash: generated.seed_hash,
    cases_sha256: generated.cases_sha256,
    privacy: generated.privacy
  });
  return { ...generated, output_dir: path.resolve(outputDir) };
}
