#!/usr/bin/env node

import { pathToFileURL } from "node:url";

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  const apiUrl = (process.env.ORGBRAIN_API_URL || "http://127.0.0.1:8787").replace(/\/+$/u, "");
  const apiKey = process.env.ORGBRAIN_API_KEY?.trim();
  if (!apiKey) throw new Error("ORGBRAIN_API_KEY is required");
  const projectId = option(argv, "--project", null);
  if (!projectId) throw new Error("--project is required");
  const requests = Math.min(1_000, Math.max(1, Number(option(argv, "--requests", 200))));
  const failures = [];
  const latencies = [];
  for (let index = 0; index < requests; index += 1) {
    const startedAt = performance.now();
    const response = await fetch(`${apiUrl}/v1/memories/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        tenant_id: "default",
        project_id: projectId,
        q: index % 2 === 0 ? "previous verified decision rationale" : "known failure avoidance rule",
        limit: 5,
        generation_id: "gen_verified_learning",
        rewrite_query: false
      }),
      signal: AbortSignal.timeout(5_000)
    });
    latencies.push(performance.now() - startedAt);
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.error?.code === "1102") {
      failures.push({ index, status: response.status, reason_code: body?.error?.code ?? "invalid_response" });
    }
  }
  const sorted = [...latencies].sort((left, right) => left - right);
  const report = {
    ok: failures.length === 0,
    requests,
    failures: failures.length,
    cloudflare_1102: failures.filter((item) => item.reason_code === "1102").length,
    p95_ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
    failure_reason_codes: [...new Set(failures.map((item) => item.reason_code))]
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

