#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexSessionImportReport } from "../packages/orgbrain-cli/src/codex-session-import.mjs";
import { observeMemoryContractV2Event } from "../packages/shared/src/memory-contract-v2-runtime.mjs";

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function payload(row) {
  return row?.payload && typeof row.payload === "object" ? row.payload : row;
}

async function materializeRows(item, workspace, otherWorkspace) {
  const cwd = item.workspace_scope === "other" ? otherWorkspace : workspace;
  const rows = [];
  const sessionMeta = {
    timestamp: "2026-08-15T02:00:00.000Z",
    type: "session_meta",
    payload: { id: item.session_id, cwd, thread_source: item.thread_source ?? "user" }
  };
  rows.push(sessionMeta);
  for (const rawRow of item.rows ?? []) {
    const row = clone(rawRow);
    rows.push(row);
    const event = payload(row);
    if (event?.type !== "custom_tool_call" || event.name !== "orgbrain_memory_observe") continue;
    const input = event.input;
    if (!input || input.capture_intent !== "verify" || (input.gaps ?? []).length > 0) continue;
    const observed = await observeMemoryContractV2Event(input, { workspaceRoot: workspace });
    rows.push({
      timestamp: "2026-08-15T02:00:59.000Z",
      type: "event_msg",
      payload: {
        type: "custom_tool_call_output",
        call_id: event.call_id,
        output: JSON.stringify(observed)
      }
    });
  }
  return rows;
}

export async function predictCalibrationCases(cases) {
  const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-calibration-predict-"));
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(workspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "calibration@example.invalid"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Calibration Predictor"], { cwd: workspace, stdio: "ignore" });
  try {
    for (const item of cases) {
      for (const file of item.workspace_files ?? []) {
        const target = path.join(workspace, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.base ?? "", "utf8");
      }
    }
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-qm", "calibration base"], { cwd: workspace, stdio: "ignore" });
    for (const item of cases) {
      for (const file of item.workspace_files ?? []) {
        const target = path.join(workspace, file.path);
        await writeFile(target, file.current ?? file.base ?? "", "utf8");
      }
      const rows = await materializeRows(item, workspace, otherWorkspace);
      await writeFile(path.join(sessionsRoot, `${item.case_id}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    }
    const report = await createCodexSessionImportReport({
      workspaceRoot: workspace,
      sessionsRoot,
      env: {
        ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
        ORGBRAIN_ENABLE_ORG_SHARING: "false",
        ORGBRAIN_TENANT_ID: "default",
        ORGBRAIN_LOCAL_DB: path.join(root, "calibration.sqlite"),
        ORGBRAIN_WORKSPACES_FILE: path.join(root, "missing-workspaces.json"),
        ORGBRAIN_HOOK_ENV_FILES: path.join(root, "missing-hooks.env")
      }
    });
    const batches = new Map(report.plan.batches.map((batch) => [batch.session_hash, batch]));
    const predictions = [];
    for (const item of cases) {
      const batch = batches.get(hash(item.session_id));
      const active = batch?.active ?? [];
      const review = batch?.review ?? [];
      const route = active.length ? "active" : review.length ? "review" : "excluded";
      const candidate = active[0] ?? review[0] ?? {};
      predictions.push({
        case_id: item.case_id,
        route,
        lesson_type: active[0]?.learning?.lesson_type ?? null,
        verification_state: candidate.verification?.state ?? candidate.verification_state ?? null,
        reason_codes: [...new Set([...(batch?.excluded_reason_codes ?? []), ...(candidate.reason_codes ?? [])])].sort(),
        judge_verdicts: {
          evidence_entailment: route === "active" ? "pass" : "fail",
          durability_atomicity: route === "active" ? "pass" : "fail",
          future_reuse_overgeneralization: route === "active" ? "pass" : "fail"
        },
        hard_guardrails: []
      });
    }
    return predictions;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
