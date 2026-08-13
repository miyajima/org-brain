#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { evaluateRetrievalGold } from "../packages/shared/src/retrieval-gold-eval.mjs";

function parseArgs(argv) {
  const options = {
    apiUrl: process.env.ORGBRAIN_API_URL ?? process.env.ORGBRAIN_API_BASE ?? null,
    apiKey: process.env.ORGBRAIN_API_KEY ?? null,
    tenant: process.env.ORGBRAIN_TENANT_ID ?? "default",
    project: null,
    count: 100,
    p95LimitMs: 2_500,
    fixture: resolve("packages/shared/test/fixtures/memory-retrieval-gold-v4.json"),
    output: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const match = /^(--api-url|--api-key|--tenant|--project|--count|--p95-limit-ms|--fixture|--output)(?:=(.*))?$/u.exec(arg);
    if (!match) throw new Error(`unknown argument: ${arg}`);
    const value = match[2] ?? argv[++index];
    if (!value) throw new Error(`${match[1]} requires a value`);
    if (match[1] === "--api-url") options.apiUrl = value.replace(/\/$/u, "");
    if (match[1] === "--api-key") options.apiKey = value;
    if (match[1] === "--tenant") options.tenant = value;
    if (match[1] === "--project") options.project = value;
    if (match[1] === "--count") options.count = Number.parseInt(value, 10);
    if (match[1] === "--p95-limit-ms") options.p95LimitMs = Number.parseInt(value, 10);
    if (match[1] === "--fixture") options.fixture = resolve(value);
    if (match[1] === "--output") options.output = resolve(value);
  }
  if (!options.apiUrl || !options.apiKey) throw new Error("ORGBRAIN_API_URL and ORGBRAIN_API_KEY are required");
  if (!Number.isFinite(options.count) || options.count < 100) throw new Error("--count must be at least 100");
  if (!Number.isFinite(options.p95LimitMs) || options.p95LimitMs < 1) throw new Error("--p95-limit-ms must be positive");
  return options;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = JSON.parse(await readFile(options.fixture, "utf8"));
  if (!Array.isArray(fixture.questions) || fixture.questions.length < 20) {
    throw new Error("gold fixture must contain at least 20 questions");
  }
  const latencies = [];
  const goldById = new Map();
  let fiveXxCount = 0;
  let error1102Count = 0;
  let requestErrorCount = 0;
  const requiredHealthyReasons = [
    "semantic_provider_unavailable",
    "atomic_extractor_not_configured",
    "segment_candidates_unavailable",
    "reranker_unavailable"
  ];
  const degradedReasonCounts = Object.fromEntries(requiredHealthyReasons.map((reason) => [reason, 0]));
  for (let index = 0; index < options.count; index += 1) {
    const question = fixture.questions[index % fixture.questions.length];
    const started = performance.now();
    let response;
    let bodyText = "";
    try {
      response = await fetch(`${options.apiUrl}/v1/memories/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`
        },
        body: JSON.stringify({
          tenant_id: options.tenant,
          project_id: options.project,
          q: question.query,
          limit: 5,
          search_mode: "hybrid_v4"
        }),
        signal: AbortSignal.timeout(5_000)
      });
      bodyText = await response.text();
    } catch {
      requestErrorCount += 1;
      continue;
    } finally {
      latencies.push(performance.now() - started);
    }
    if (response.status >= 500) fiveXxCount += 1;
    if (/\b1102\b/u.test(bodyText)) error1102Count += 1;
    if (!response.ok) {
      requestErrorCount += 1;
      continue;
    }
    const payload = JSON.parse(bodyText);
    const degradedReasons = payload?.data?.meta?.retrieval?.degraded_reasons ??
      payload?.meta?.retrieval?.degraded_reasons ?? [];
    for (const reason of requiredHealthyReasons) {
      if (degradedReasons.includes(reason)) degradedReasonCounts[reason] += 1;
    }
    if (!goldById.has(question.id)) {
      const results = payload?.data?.results ?? payload?.results ?? [];
      goldById.set(question.id, {
        ...question,
        returned_ids: results.map((item) => item.id).filter(Boolean).slice(0, 5)
      });
    }
  }
  const gold = evaluateRetrievalGold(fixture.questions.map((question) =>
    goldById.get(question.id) ?? { ...question, returned_ids: [] }
  ));
  const p95 = percentile(latencies, 0.95);
  const report = {
    version: 1,
    generated_at: Date.now(),
    request_count: options.count,
    five_xx_count: fiveXxCount,
    cloudflare_1102_count: error1102Count,
    request_error_count: requestErrorCount,
    degraded_reason_counts: degradedReasonCounts,
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95,
      p95_limit: options.p95LimitMs,
      maximum: latencies.length ? Number(Math.max(...latencies).toFixed(2)) : null
    },
    retrieval: gold,
    passed: fiveXxCount === 0 && error1102Count === 0 && requestErrorCount === 0 &&
      Object.values(degradedReasonCounts).every((count) => count === 0) &&
      p95 !== null && p95 < options.p95LimitMs && gold.passed
  };
  if (options.output) await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, reason_code: error instanceof Error ? error.message : "live_smoke_failed" }));
  process.exitCode = 1;
});
