#!/usr/bin/env node

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

const samples = Math.max(20, Math.min(10_000, Number(process.argv[2] ?? 100) || 100));
const directory = await mkdtemp(join(tmpdir(), "orgbrain-activity-overhead-"));
await chmod(directory, 0o700);

try {
  const store = new LocalMemoryStore(join(directory, "memory.sqlite"));
  await store.init();
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await store.recordActivity({
      tenant_id: "default",
      project_id: "overhead-fixture",
      harness_name: "codex",
      collection_method: "hook",
      fidelity: "observed",
      action: "tool.completed",
      session_id: "overhead-fixture",
      tool_call_id: `call-${index}`,
      occurred_at: new Date(1_760_000_000_000 + index).toISOString(),
      tool_name: "exec_command",
      result: { ok: true }
    });
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  const percentile = (fraction) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * fraction) - 1)];
  const report = {
    schema_version: "agent-activity-overhead/v1",
    samples,
    warm_store: true,
    includes_process_startup: false,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: durations.at(-1),
    gate_ms: 50,
    passed: percentile(0.95) <= 50
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
