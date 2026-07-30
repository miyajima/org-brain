#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

function parseArgs(argv) {
  const options = {
    adapter: "",
    revision: "",
    dataset: "",
    inputs: [],
    outputDirectory: "",
    expected: 500,
    executionProfile: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => (arg.includes("=") ? arg.split("=", 2)[1] : argv[++index]);
    if (arg === "--adapter" || arg.startsWith("--adapter=")) options.adapter = value();
    else if (arg === "--revision" || arg.startsWith("--revision=")) options.revision = value();
    else if (arg === "--dataset" || arg.startsWith("--dataset=")) options.dataset = resolve(value());
    else if (arg === "--input" || arg.startsWith("--input=")) options.inputs.push(resolve(value()));
    else if (arg === "--output-dir" || arg.startsWith("--output-dir=")) {
      options.outputDirectory = resolve(value());
    } else if (arg === "--expected" || arg.startsWith("--expected=")) {
      options.expected = Number(value());
    } else if (arg === "--execution-profile" || arg.startsWith("--execution-profile=")) {
      options.executionProfile = value();
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/summarize-competitor-longmemeval.mjs \\
  --adapter <name> --revision <sha> --dataset <json> \\
  --input <rows.jsonl> [--input <rows.jsonl> ...] \\
  --output-dir <directory> [--expected 500] \\
  [--execution-profile <description>]`);
      process.exit(0);
    }
  }
  if (!options.adapter || !options.revision || !options.dataset) {
    throw new Error("--adapter, --revision, and --dataset are required");
  }
  if (options.inputs.length === 0 || !options.outputDirectory) {
    throw new Error("at least one --input and --output-dir are required");
  }
  if (!Number.isInteger(options.expected) || options.expected < 1) {
    throw new Error("--expected must be a positive integer");
  }
  return options;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function normalizeRow(row, sourceFile) {
  const metrics = row?.retrieval_results?.metrics?.session;
  const memPalaceHit = Number(metrics?.["recall_any@5"]);
  const hit = typeof row.hit_at_k === "boolean"
    ? row.hit_at_k
    : Number.isFinite(memPalaceHit)
      ? memPalaceHit > 0
      : null;
  if (typeof row.question_id !== "string" || typeof row.question_type !== "string") {
    throw new Error(`${sourceFile} contains a row without question_id/question_type`);
  }
  if (hit === null) {
    throw new Error(`${sourceFile} row ${row.question_id} has no recognized R@5 metric`);
  }
  return {
    question_id: row.question_id,
    question_type: row.question_type,
    hit_at_5: hit,
    latency_ms: Number.isFinite(Number(row.latency_ms)) ? Number(row.latency_ms) : null,
    error: row.error ? String(row.error) : null,
    source_file: basename(sourceFile),
    raw: row
  };
}

export async function summarizeCompetitorLongMemEval(options) {
  const rows = [];
  for (const input of options.inputs) {
    const source = await readFile(input, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        rows.push(normalizeRow(JSON.parse(line), input));
      } catch (error) {
        throw new Error(
          `${input}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  const byId = new Map();
  for (const row of rows) {
    if (byId.has(row.question_id)) {
      throw new Error(`duplicate question_id: ${row.question_id}`);
    }
    byId.set(row.question_id, row);
  }
  if (rows.length !== options.expected) {
    throw new Error(`expected ${options.expected} rows, found ${rows.length}`);
  }

  const datasetBytes = await readFile(options.dataset);
  const datasetSha256 = createHash("sha256").update(datasetBytes).digest("hex");
  const hits = rows.filter((row) => row.hit_at_5).length;
  const latencies = rows
    .map((row) => row.latency_ms)
    .filter((value) => Number.isFinite(value));
  const categories = {};
  for (const row of rows) {
    const bucket = categories[row.question_type] ??= { questions: 0, hits: 0, recall_at_5: 0 };
    bucket.questions += 1;
    if (row.hit_at_5) bucket.hits += 1;
  }
  for (const bucket of Object.values(categories)) {
    bucket.recall_at_5 = Number((bucket.hits / bucket.questions * 100).toFixed(2));
  }

  const summary = {
    benchmark: "LongMemEval-S",
    adapter: options.adapter,
    revision: options.revision,
    dataset_sha256: datasetSha256,
    questions: rows.length,
    top_k: 5,
    hits,
    recall_at_5: Number((hits / rows.length * 100).toFixed(2)),
    errors: rows.filter((row) => row.error !== null).length,
    latency_ms: {
      samples: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95)
    },
    categories,
    failure_question_ids: rows.filter((row) => !row.hit_at_5).map((row) => row.question_id),
    inputs: options.inputs.map((input) => basename(input))
  };
  if (options.executionProfile) {
    summary.execution_profile = options.executionProfile;
  }

  await mkdir(options.outputDirectory, { recursive: true });
  await writeFile(
    resolve(options.outputDirectory, "rows.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
  );
  await writeFile(
    resolve(options.outputDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  return summary;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const summary = await summarizeCompetitorLongMemEval(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
