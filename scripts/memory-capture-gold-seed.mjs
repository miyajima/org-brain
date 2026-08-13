#!/usr/bin/env node

import crypto from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureItemPayload,
  postMemoryViaMcp,
  prepareMemoryRecordsV2,
  resolveMcpConfig
} from "../packages/orgbrain-cli/src/hook-memory-bridge.mjs";
import { DEFAULT_GOLD_DATASET } from "./derive-memory-hook-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function usage() {
  console.log(`Gold memory capture seed

Usage:
  node scripts/memory-capture-gold-seed.mjs --output <private.json> [options]

Options:
  --fixture <path>       Gold dataset (default: memory-capture-gold-v1.json)
  --tenant <id>          Tenant ID (default: default)
  --project <id>         Project ID (default: org-brain-memory-fixtures)
  --example <id>         Seed one accepted example; repeatable
  --output <path>        Mode-0600 plan and result report
  --apply                Send the generated candidates through the capture API
  --allow-remote         Permit a non-loopback REST API; MCP remains preferred
  --help                 Show this help

Apply prefers a complete ORGBRAIN_MCP_* configuration. Without MCP it uses
ORGBRAIN_API_URL and ORGBRAIN_API_KEY; remote REST requires --allow-remote.
`);
}

export function parseArgs(argv) {
  const options = {
    fixture: DEFAULT_GOLD_DATASET,
    tenantId: "default",
    projectId: "org-brain-memory-fixtures",
    exampleIds: new Set(),
    output: null,
    apply: false,
    allowRemote: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg}_value_required`);
      index += 1;
      return next;
    };
    if (arg === "--fixture") options.fixture = path.resolve(value());
    else if (arg === "--tenant") options.tenantId = value().trim();
    else if (arg === "--project") options.projectId = value().trim();
    else if (arg === "--example") options.exampleIds.add(value().trim());
    else if (arg === "--output") options.output = path.resolve(value());
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--allow-remote") options.allowRemote = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (!options.help && !options.output) throw new Error("output_required");
  if (!options.tenantId) throw new Error("tenant_required");
  if (!options.projectId) throw new Error("project_required");
  return options;
}

function assertExpectedCandidate(record, expected, exampleId) {
  for (const field of ["kind", "content", "rationale", "reuse_rule"]) {
    const actual = field === "reuse_rule" ? record.reuseRule : record[field];
    if (actual !== expected[field]) throw new Error(`gold_candidate_mismatch:${exampleId}:${field}`);
  }
  if (record.qualityScore !== 100) throw new Error(`gold_candidate_quality_below_100:${exampleId}`);
  const actualEvidence = new Set(record.evidence.map((item) => `${item.type}:${item.ref}`));
  for (const item of expected.evidence) {
    if (!actualEvidence.has(`${item.type}:${item.ref}`)) {
      throw new Error(`gold_candidate_mismatch:${exampleId}:evidence`);
    }
  }
}

export async function buildGoldCapturePlan(options) {
  const dataset = JSON.parse(await readFile(options.fixture, "utf8"));
  const records = [];
  const acceptedExamples = dataset.examples.filter((item) =>
    item.expected.accept && (!options.exampleIds?.size || options.exampleIds.has(item.id))
  );
  if (acceptedExamples.length === 0) throw new Error("no_matching_accepted_gold_examples");
  for (const example of acceptedExamples) {
    const prepared = await prepareMemoryRecordsV2({
      sourceName: example.input.source,
      externalKey: `gold:${dataset.dataset_id}:${example.id}`,
      createdAt: example.input.occurred_at,
      cwd: ROOT,
      projectId: options.projectId,
      projectIdExplicit: true,
      businessCategoryId: null,
      workType: example.work_type ?? "other",
      assistantText: example.input.text,
      eventType: "GoldSeed",
      metadata: { goldDataset: dataset.dataset_id, goldExample: example.id }
    }, {
      tenantId: options.tenantId,
      projectId: options.projectId,
      businessCategoryId: null,
      workType: example.work_type ?? "other",
      workspaceRoot: ROOT,
      sensitiveMemory: { mode: "deny", allowed_principals: [] }
    }, options.tenantId);
    if (prepared.records.length !== example.expected.candidates.length) {
      throw new Error(`gold_candidate_count_mismatch:${example.id}`);
    }
    for (const [index, record] of prepared.records.entries()) {
      assertExpectedCandidate(record, example.expected.candidates[index], example.id);
      records.push({
        ...record,
        captureOrigin: "synthetic",
        verification: {
          state: "unverified",
          verified_at: null,
          attestation_ref: null
        },
        qualityDimensions: {
          atomicity: record.qualityScore,
          rationale_structure: record.qualityScore,
          evidence_structure: record.qualityScore
        }
      });
    }
  }
  const batches = [];
  for (let index = 0; index < records.length; index += 3) batches.push(records.slice(index, index + 3));
  const core = {
    schema_version: 1,
    dataset_id: dataset.dataset_id,
    example_ids: acceptedExamples.map((example) => example.id),
    profile_id: records[0]?.captureProfileId ?? null,
    tenant_id: options.tenantId,
    project_id: options.projectId,
    source: "codex",
    capture_origin: "synthetic",
    verification_state: "unverified",
    batches: batches.map((batch) => ({ items: batch.map(captureItemPayload) }))
  };
  return {
    plan_hash: sha256(JSON.stringify(core)),
    core,
    records,
    summary: {
      accepted_examples: acceptedExamples.length,
      candidate_count: records.length,
      batch_count: batches.length,
      quality_scores: records.map((record) => record.qualityScore),
      kinds: Object.fromEntries(records.map((record) => [record.kind, records.filter((item) => item.kind === record.kind).length]))
    }
  };
}

async function writePrivateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

function restConfig(env, allowRemote) {
  const raw = env.ORGBRAIN_API_URL?.trim();
  const apiKey = env.ORGBRAIN_API_KEY?.trim();
  if (!raw) throw new Error("ORGBRAIN_API_URL_required_for_apply");
  if (!apiKey) throw new Error("ORGBRAIN_API_KEY_required_for_apply");
  const url = new URL(raw);
  if (!allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) throw new Error("remote_rest_requires_allow_remote");
  return { url: url.toString().replace(/\/+$/u, ""), apiKey };
}

async function applyViaRest(config, tenantId, records) {
  const response = await fetch(`${config.url}/v1/memories/capture-rationale`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.apiKey },
    body: JSON.stringify({
      tenant_id: tenantId,
      source: "codex",
      actor_type: "system",
      actor_id: "gold-seed",
      items: records.map(captureItemPayload)
    }),
    signal: AbortSignal.timeout(5_000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(`gold_capture_failed:${payload?.error?.code ?? response.status}`);
  }
  return payload.data;
}

async function applyGoldPlan(plan, options, env = process.env) {
  const mcp = resolveMcpConfig(env);
  if (mcp.configured && !mcp.complete) {
    throw new Error(`incomplete_mcp_config:${mcp.missing.join(",")}`);
  }
  const results = [];
  for (let index = 0; index < plan.records.length; index += 3) {
    const batch = plan.records.slice(index, index + 3);
    const result = mcp.complete
      ? await postMemoryViaMcp(mcp, options.tenantId, "codex", batch)
      : await applyViaRest(restConfig(env, options.allowRemote), options.tenantId, batch);
    results.push(result);
  }
  return { transport: mcp.complete ? "mcp-2026-07-28" : "legacy-rest", batches: results };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return;
  }
  const plan = await buildGoldCapturePlan(options);
  const report = {
    generated_at: Date.now(),
    mode: options.apply ? "apply" : "dry-run",
    plan_hash: plan.plan_hash,
    summary: plan.summary,
    plan: plan.core,
    result: null
  };
  await writePrivateJson(options.output, report);
  if (options.apply) {
    report.result = await applyGoldPlan(plan, options);
    await writePrivateJson(options.output, report);
  }
  console.log(JSON.stringify({
    ok: true,
    mode: report.mode,
    plan_hash: report.plan_hash,
    summary: report.summary,
    output: options.output
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
