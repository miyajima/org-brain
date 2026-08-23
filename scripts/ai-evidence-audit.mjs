#!/usr/bin/env node

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

const RUNS_PER_SCENARIO = 3;
const NOW = Date.UTC(2026, 7, 22, 0, 0, 0);
const TENANT = "ux-audit-ai";
const PRINCIPAL = "auditor";

export const AI_AUDIT_SCENARIOS = Object.freeze([
  { id: "normal_match", query: "release approval and Cloud hook failure", expected: "degraded", abstain: false },
  { id: "failure_pattern", query: "Cloud hook returns 401 retry", expected: "degraded", abstain: false },
  { id: "missing_evidence", query: "what happened in the unrecorded meeting", expected: "insufficient", abstain: true },
  { id: "conflict", query: "production deploy decision conflicting guidance", expected: "conflicted", abstain: true },
  { id: "low_confidence", query: "migration fallback plan", expected: "degraded", abstain: false },
  { id: "expired", query: "expired rollout decision", expected: "insufficient", abstain: true },
  { id: "permission_boundary", query: "restricted memory project", expected: "insufficient", abstain: true },
  { id: "over_candidate", query: "release cloud auth migration decision", expected: "degraded", abstain: false },
  { id: "insufficient_multi_session", query: "what changed across three incomplete sessions", expected: "insufficient", abstain: true },
  { id: "auth_failure", query: "Cloud MCP authentication failure", expected: null, abstain: null, localApplicability: "not_applicable" },
  { id: "mcp_stopped", query: "MCP service stopped during search", expected: null, abstain: null, transport: true },
  { id: "wrong_past_information", query: "old incorrect release instruction", expected: "degraded", abstain: false }
]);

function captureInput(projectId, key, overrides = {}) {
  return {
    tenant_id: TENANT,
    project_id: projectId,
    kind: "decision",
    lifecycle_state: "active",
    scope_type: "project",
    scope_key: projectId,
    content: `${key} synthetic UX audit evidence`,
    summary: key,
    tags: ["ux-audit", key],
    entities: [],
    source: "ux-audit-fixture",
    source_references: [{ type: "document", ref: `UX-${key.toUpperCase()}` }],
    external_key: `ux-audit:${projectId}:${key}`,
    actor_type: "principal",
    actor_id: PRINCIPAL,
    valid_from: null,
    valid_until: null,
    confidence_score: 0.9,
    utility_score: 0.8,
    rationale: "Synthetic evidence used only for current-state UX verification.",
    reuse_rule: "Use only while running the isolated UX audit.",
    evidence: [],
    conflicts: [],
    permissions: [],
    ...overrides
  };
}

async function seed(store) {
  const ids = {};
  const add = async (scenario, key, overrides) => {
    const result = await store.capture(captureInput(scenario, key, overrides));
    ids[`${scenario}:${key}`] = result.memory_id;
  };

  await add("normal_match", "approval", {
    content: "release approval requires two reviewers and cites RUNBOOK-42",
    summary: "Release approval policy",
    source_references: [{ type: "document", ref: "RUNBOOK-42" }]
  });
  await add("normal_match", "cloud-hook", {
    kind: "pitfall",
    content: "Cloud hook failure requires installation ID and service token checks; never flush the outbox blindly",
    summary: "Cloud hook failure pattern",
    source_references: [{ type: "incident", ref: "INC-7" }]
  });
  await add("failure_pattern", "401", {
    kind: "pitfall",
    content: "Cloud hook returns 401 retry only after checking installation ID and service token; do not retry unsafe writes",
    summary: "Cloud hook 401 recovery",
    source_references: [{ type: "incident", ref: "INC-7" }]
  });
  await add("conflict", "deploy", {
    content: "production deploy decision conflicting guidance requires human review",
    summary: "Conflicting production guidance",
    conflicts: [{ type: "contradiction", ref: "POLICY-B" }]
  });
  await add("low_confidence", "fallback", {
    content: "migration fallback plan may use the previous image after verification",
    summary: "Migration fallback plan",
    confidence_score: 0.4,
    source_references: []
  });
  await add("expired", "rollout", {
    content: "expired rollout decision says to deploy without a smoke test",
    summary: "Expired rollout decision",
    valid_until: NOW - 1
  });
  await add("permission_boundary", "restricted", {
    content: "restricted memory project contains confidential synthetic guidance",
    summary: "Restricted memory",
    permissions: [{ principal_type: "principal", principal_id: "allowed-user", permissions: ["read"] }]
  });
  await store.capture(captureInput("permission_boundary", "foreign-tenant", {
    tenant_id: "ux-audit-other-tenant",
    content: "restricted memory project exists in another tenant",
    external_key: "ux-audit:other-tenant:restricted"
  }));
  for (let index = 0; index < 12; index += 1) {
    await add("over_candidate", `candidate-${index}`, {
      content: `release cloud auth migration decision candidate ${index}; validate OAuth audience before action`,
      summary: `Cloud auth migration candidate ${index}`,
      confidence_score: index < 3 ? 0.9 : 0.45
    });
  }
  await add("insufficient_multi_session", "one-session", {
    content: "what changed across three incomplete sessions: only session one records the schema check",
    summary: "Only one recorded session",
    source_references: [{ type: "session", ref: "SESSION-1" }]
  });
  await add("wrong_past_information", "old", {
    content: "old incorrect release instruction: skip tests",
    summary: "Superseded release instruction",
    lifecycle_state: "suppressed"
  });
  await add("wrong_past_information", "current", {
    content: "old incorrect release instruction is superseded; current instruction requires tests and smoke verification",
    summary: "Current release instruction",
    source_references: [{ type: "document", ref: "RUNBOOK-CURRENT" }]
  });
  return ids;
}

async function closedPortProbe() {
  const startedAt = performance.now();
  try {
    await fetch("http://127.0.0.1:1/mcp");
    return { outcome: "unexpected_success", duration_ms: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      outcome: "connection_refused",
      error_code: error?.cause?.code ?? error?.code ?? "fetch_failed",
      duration_ms: Math.round(performance.now() - startedAt),
      recovery_action: "MCPを再起動し、doctorで到達性を確認してから安全な読取操作を再試行する"
    };
  }
}

function summarizeContext(context, durationMs) {
  const bundle = context.evidence_bundle;
  return {
    outcome: "completed",
    duration_ms: Math.round(durationMs),
    evidence_status: bundle.evidence_status,
    abstention_recommended: bundle.abstention_recommended,
    answer_template: bundle.answer_template,
    memory_ids: bundle.evidence.map((item) => item.memory_id),
    source_refs: bundle.evidence.map((item) => item.source_reference?.ref ?? null),
    missing_evidence: bundle.missing_evidence,
    degraded_reasons: bundle.degraded_reasons,
    conflict_count: bundle.conflicts.length,
    candidate_count: context.results.length
  };
}

function assertScenario(scenario, runs, ids) {
  if (scenario.id === "auth_failure") return { passed: true, note: "Localは認証境界がないためN/A" };
  if (scenario.id === "mcp_stopped") {
    return { passed: runs.every((run) => run.outcome === "connection_refused"), note: "closed-port transport probe" };
  }
  const statusMatches = runs.every((run) => run.evidence_status === scenario.expected);
  const abstentionMatches = runs.every((run) => run.abstention_recommended === scenario.abstain);
  const bounded = scenario.id !== "over_candidate" || runs.every((run) => run.memory_ids.length <= 5);
  const isolated = scenario.id !== "permission_boundary" || runs.every((run) => run.memory_ids.length === 0 && run.candidate_count === 0);
  const currentOnly = scenario.id !== "wrong_past_information" || runs.every((run) =>
    run.memory_ids.includes(ids["wrong_past_information:current"]) &&
    !run.memory_ids.includes(ids["wrong_past_information:old"])
  );
  return {
    passed: statusMatches && abstentionMatches && bounded && isolated && currentOnly,
    checks: { statusMatches, abstentionMatches, bounded, isolated, currentOnly }
  };
}

export async function runLocalAiEvidenceAudit() {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-ai-audit-"));
  await chmod(directory, 0o700);
  const store = new LocalMemoryStore(join(directory, "memory.sqlite"), { denseEmbeddingProvider: null });
  try {
    const ids = await seed(store);
    const scenarios = [];
    for (const scenario of AI_AUDIT_SCENARIOS) {
      const runs = [];
      for (let index = 0; index < RUNS_PER_SCENARIO; index += 1) {
        if (scenario.id === "auth_failure") {
          runs.push({ outcome: "not_applicable", reason: "Local MCP does not have a user OAuth boundary" });
          continue;
        }
        if (scenario.transport) {
          runs.push(await closedPortProbe());
          continue;
        }
        const startedAt = performance.now();
        const context = await store.retrieveContext({
          tenant_id: TENANT,
          project_id: scenario.id,
          query: scenario.query,
          principal_id: PRINCIPAL,
          top_k: 5,
          token_budget: 1024,
          at: NOW
        });
        runs.push(summarizeContext(context, performance.now() - startedAt));
      }
      scenarios.push({
        id: scenario.id,
        query: scenario.query,
        expected_evidence_status: scenario.expected,
        expected_abstention: scenario.abstain,
        runs,
        validation: assertScenario(scenario, runs, ids)
      });
    }
    const failed = scenarios.filter((scenario) => !scenario.validation.passed);
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      target: "local",
      fixture: {
        kind: "fresh_synthetic",
        tenant_id: TENANT,
        principal_id: PRINCIPAL,
        run_count_per_scenario: RUNS_PER_SCENARIO,
        database_path_persisted: false
      },
      summary: {
        scenario_count: scenarios.length,
        applicable_scenario_count: scenarios.filter((scenario) => scenario.id !== "auth_failure").length,
        passed_count: scenarios.length - failed.length,
        failed_count: failed.length,
        all_applicable_passed: failed.length === 0
      },
      scenarios,
      cloudflare: {
        status: "not_run",
        reason: "ORGBRAIN_MCP_URL, managed MCP hostname, and explicit Access policy ID were not available"
      }
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const outputIndex = argv.indexOf("--output");
  return { output: outputIndex >= 0 ? argv[outputIndex + 1] : null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runLocalAiEvidenceAudit();
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    const output = resolve(args.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ output, summary: result.summary })}\n`);
  } else {
    process.stdout.write(serialized);
  }
  if (!result.summary.all_applicable_passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
