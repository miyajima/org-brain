#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AXES = ["semantic_completeness", "evidence_support", "rationale_quality", "future_reuse", "scope_specificity", "freshness_validity", "atomicity"];

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)].toFixed(3));
}

function latencySummary(values) {
  return {
    samples: values.length,
    min_ms: Number(Math.min(...values).toFixed(3)),
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    max_ms: Number(Math.max(...values).toFixed(3))
  };
}

function runHook(command, commandPrefix, payload, env) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, [...commandPrefix, "hook", "codex-context"], {
      cwd: payload.cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      const elapsedMs = performance.now() - started;
      if (code !== 0) return reject(new Error(`hook exited ${code}: ${stderr.slice(0, 240)}`));
      resolve({ elapsedMs, stdout: stdout.trim() });
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

async function writePrivate(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function runLocalNewSessionSmoke(options) {
  const workspace = path.resolve(options.workspace);
  const dbPath = path.resolve(options.dbPath);
  const output = path.resolve(options.output);
  const command = path.resolve(options.command);
  const commandPrefix = options.cliPath ? ["--no-warnings", path.resolve(options.cliPath)] : [];
  const evidenceRef = "scripts/connector-setup.test.mjs";
  const evidenceContent = await readFile(path.join(workspace, evidenceRef));
  const store = new LocalMemoryStore(dbPath);
  const externalKey = "quality-smoke:new-session-local:v1";
  const qualityDimensions = Object.fromEntries(AXES.map((axis) => [axis, 100]));
  const captured = await store.capture({
    tenant_id: "default",
    project_id: "org-brain",
    kind: "decision",
    content: "For the Zephyr bridge lifecycle smoke test, use exactly seven retries, then verify with the connector setup Node test. Reuse only for the controlled OrgBrain new-session smoke test.",
    summary: "Zephyr bridge smoke validation uses seven retries and the connector setup Node test.",
    tags: ["quality-smoke", "zephyr-bridge", "synthetic"],
    source: "quality-smoke",
    external_key: externalKey,
    capture_origin: "observed",
    capture_route: "manual",
    verification_state: "verified",
    verified_at: Date.now(),
    quality_dimensions: qualityDimensions,
    rationale: "The unique Zephyr term makes the retrieval expectation deterministic without matching unrelated prompts.",
    reuse_rule: "Use only for the controlled OrgBrain new-session smoke test.",
    learning: {
      schema_version: 2,
      lesson_type: "success",
      capture_intent: "verify",
      procedure: "Use seven retries and run the connector setup Node test.",
      why_it_worked: "A unique controlled term makes retrieval and abstention independently measurable.",
      observed_outcome: "The connector setup regression test completed successfully.",
      reuse_when: "Only during the controlled OrgBrain new-session smoke test."
    },
    evidence: [{ type: "file", ref: evidenceRef, content_hash: sha256(evidenceContent), summary: "Connector setup regression test" }]
  });
  const memoryId = captured.memory_id;
  const positiveQuery = "For the Zephyr bridge rollout, what retry budget and verification test should this project use?";
  const negativeQuery = "What is tomorrow's mountain weather forecast?";
  const directLatencies = [];
  let directFound = false;
  for (let index = 0; index < (options.directSamples ?? 50); index += 1) {
    const started = performance.now();
    const results = await store.search({ tenant_id: "default", project_id: "org-brain", query: positiveQuery, limit: 2, minimum_total_score: 0.02, search_mode: "hybrid_v4" });
    directLatencies.push(performance.now() - started);
    directFound ||= results.some((item) => item.memory.id === memoryId);
  }
  const hookEnv = {
    ORGBRAIN_HOOK_ENV_FILES: options.envFile,
    ORGBRAIN_LOCAL_DB: dbPath,
    ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
    ORGBRAIN_ENABLE_ORG_SHARING: "false",
    ORGBRAIN_LOCAL_CONTEXT_ENABLED: "true"
  };
  const positivePayload = { hook_event_name: "UserPromptSubmit", session_id: "quality-smoke-new-session", cwd: workspace, prompt: positiveQuery };
  const negativePayload = { hook_event_name: "UserPromptSubmit", session_id: "quality-smoke-negative-control", cwd: workspace, prompt: negativeQuery };
  const firstHook = await runHook(command, commandPrefix, positivePayload, hookEnv);
  const hookLatencies = [];
  let hookInjected = firstHook.stdout.includes(memoryId);
  for (let index = 0; index < (options.hookSamples ?? 15); index += 1) {
    const result = await runHook(command, commandPrefix, positivePayload, hookEnv);
    hookLatencies.push(result.elapsedMs);
    hookInjected &&= result.stdout.includes(memoryId);
  }
  const negativeHook = await runHook(command, commandPrefix, negativePayload, hookEnv);
  const negativeAbstained = !negativeHook.stdout.includes(memoryId);
  await store.suppress("default", memoryId, "completed controlled new-session smoke", { actor_type: "system", actor_id: "quality-smoke" });
  const cleanupHook = await runHook(command, commandPrefix, positivePayload, hookEnv);
  const cleanupAbstained = !cleanupHook.stdout.includes(memoryId);
  const passed = directFound && hookInjected && negativeAbstained && cleanupAbstained && percentile(hookLatencies, 0.95) < 3_000;
  const report = {
    schema_version: 1,
    run_id: path.basename(path.dirname(output)),
    status: passed ? "passed" : "failed",
    route: "local_only_user_prompt_submit",
    project_id: "org-brain",
    fixture: { external_key_hash: sha256(externalKey), memory_id: memoryId, lifecycle_after_run: "suppressed" },
    checks: { direct_search_found: directFound, hook_injected: hookInjected, unrelated_prompt_abstained: negativeAbstained, suppressed_memory_abstained: cleanupAbstained },
    latency: { direct_search: latencySummary(directLatencies), hook_process_cold_ms: Number(firstHook.elapsedMs.toFixed(3)), hook_process_warm: latencySummary(hookLatencies), negative_control_ms: Number(negativeHook.elapsedMs.toFixed(3)) },
    privacy: { raw_prompt_persisted: false, raw_context_persisted: false, reasoning_persisted: false, credential_value_persisted: false },
    generated_at: new Date().toISOString()
  };
  await writePrivate(output, report);
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const workspace = option(argv, "--workspace", ROOT);
  const dbPath = option(argv, "--db");
  const output = option(argv, "--output");
  const command = option(argv, "--command", "/Users/miyajimakazuhiro/.local/bin/node");
  const cliPath = option(argv, "--cli-path", null);
  const envFile = option(argv, "--env-file", path.join(process.env.HOME || "", ".config", "org-brain", "hooks.env"));
  if (!dbPath || !output) throw new Error("--db and --output are required");
  const report = await runLocalNewSessionSmoke({ workspace, dbPath, output, command, cliPath, envFile });
  process.stdout.write(`${JSON.stringify({ ok: report.status === "passed", report })}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
