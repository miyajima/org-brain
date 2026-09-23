import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { safeAttemptActionLabel } from "../../../shared/src/attempt-history-runtime.mjs";

const execFileAsync = promisify(execFile);
const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

function asObject(value) {
  if (typeof value === "string") { try { return asObject(JSON.parse(value)); } catch { return null; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function toolName(payload) {
  return String(payload.tool_name ?? payload.name ?? payload.tool ?? "").split(/[.:/]/u).at(-1);
}

function actionFromHook(payload) {
  let name = toolName(payload);
  let input = asObject(payload.tool_input ?? payload.input ?? payload.arguments);
  if (name === "exec") {
    const code = String(input?.code ?? "");
    const invocations = [...code.matchAll(/tools\.exec_command\(\s*(\{[^\n]*\})\s*\)/gu)];
    if (invocations.length !== 1 || (code.match(/\btools\.[a-zA-Z_]+\s*\(/gu) ?? []).length !== 1) return null;
    input = asObject(invocations[0][1]);
    name = "exec_command";
  }
  if (name !== "exec_command" && name !== "apply_patch") return null;
  const operation = name === "exec_command" ? input?.cmd : input?.input ?? input?.patch;
  if (typeof operation !== "string" || !operation.trim()) return null;
  return {
    tool: name,
    action_key: `tool:${name}:${digest(operation).slice(0, 48)}`,
    action_label: safeAttemptActionLabel(operation, name),
    target: name,
    workdir: typeof input?.workdir === "string" ? input.workdir : payload.cwd
  };
}

function structuredResult(payload) {
  const raw = payload.tool_result ?? payload.tool_response ?? payload.result ?? payload.output;
  let result = asObject(raw);
  if (Array.isArray(result?.content)) result = asObject(result.content.find((item) => item?.type === "text")?.text) ?? result;
  if (Number.isInteger(result?.exit_code)) return { outcome: result.exit_code === 0 ? "success" : "failure", result_summary: `exit code ${result.exit_code}`, raw };
  if (result?.isError === true || result?.is_error === true) return { outcome: "failure", result_summary: "tool error", raw };
  if (result?.isError === false || result?.is_error === false) return { outcome: "success", result_summary: "tool succeeded", raw };
  return null;
}

async function workspaceConditions(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  try {
    const [head, status, diff] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 700, maxBuffer: 1024 }),
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeout: 700, maxBuffer: 100_000 }),
      execFileAsync("git", ["diff", "HEAD", "--binary"], { cwd, timeout: 700, maxBuffer: 2_000_000 })
    ]);
    if (status.stdout.split("\n").some((line) => line.startsWith("??"))) return null;
    return { git_head: head.stdout.trim(), tracked_diff: digest(diff.stdout) };
  } catch { return null; }
}

export async function preflightHookAction(payload, store, tenantId, projectId) {
  const name = toolName(payload);
  if (!/^(?:exec|exec_command|apply_patch)$/u.test(name)) return null;
  const action = actionFromHook(payload);
  if (!action) {
    await store.recordActionHookCoverage(tenantId, projectId, name, "opaque");
    return { decision: "warn", reason: "opaque_tool_action" };
  }
  const conditions = await workspaceConditions(action.workdir);
  const decision = await store.preflightAction(tenantId, { project_id: projectId, action_key: action.action_key, conditions }, { source: "hook" });
  await store.recordActionHookCoverage(tenantId, projectId, name, decision.decision === "block" ? "blocked" : "checked");
  return decision;
}

export async function recordHookActionResult(payload, store, tenantId, projectId) {
  const name = toolName(payload);
  if (!/^(?:exec|exec_command|apply_patch)$/u.test(name)) return null;
  const action = actionFromHook(payload);
  const result = structuredResult(payload);
  const callId = payload.tool_call_id ?? payload.call_id ?? payload.tool_use_id;
  if (!action || !result || !callId) {
    await store.recordActionHookCoverage(tenantId, projectId, name, "opaque");
    return { recorded: false, reason: "opaque_or_unlinked_result" };
  }
  const prior = await store.searchAttempts(tenantId, { project_id: projectId, action_key: action.action_key, limit: 1 });
  if (result.outcome === "success" && prior.length === 0) return { recorded: false, reason: "unrelated_success" };
  const sourceKey = digest(`${payload.session_id ?? payload.thread_id ?? ""}\0${callId}`);
  const conditions = await workspaceConditions(action.workdir);
  const attempt = await store.recordAttempt(tenantId, {
    id: sourceKey, project_id: projectId, action_key: action.action_key,
    action_label: action.action_label, attempt_type: "tool_result", target: action.target,
    conditions: conditions ?? {}, outcome: result.outcome, result_summary: result.result_summary,
    failure_kind: result.outcome === "failure" ? "unknown" : undefined,
    performed_at: Date.now(), executed_by_type: "agent", executed_by: "codex",
    evidence: [{ ref_type: "hook_tool_result", ref_id: digest(String(callId)), content_hash: digest(result.raw) }],
    source: "codex_post_tool", source_key: sourceKey
  }, { trusted: true });
  await store.recordActionHookCoverage(tenantId, projectId, name, "recorded");
  return { recorded: true, attempt_id: attempt.id, outcome: attempt.outcome };
}
