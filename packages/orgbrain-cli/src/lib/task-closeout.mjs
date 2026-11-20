import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { containsRedactedSensitiveToken, redactSensitiveText } from "./sensitive-text-redaction.mjs";
import { loadWorkspaceConfig, resolveWorkspaceMapping, workspacesFileFromEnv } from "./workspace-config.mjs";

export const TASK_CLOSEOUT_MAX_BYTES = 16_384;
const ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:#@-]{0,159}$/u;
const EVIDENCE_TYPES = new Set(["check", "read", "search", "source"]);
const GAP_TYPES = new Set(["not_run", "failed", "blocked", "missing_evidence"]);
const run = promisify(execFile);

function hasExactly(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}

function summary(value, max) {
  if (typeof value !== "string" || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new Error("task_checkpoint_invalid_summary");
  const clean = value.trim();
  if (!clean || clean.length > max) throw new Error("task_checkpoint_invalid_summary");
  return redactSensitiveText(clean, { phoneNumbers: "filtered" });
}

// The completion fields only carry pointers back to the supplying tool or
// immutable source. This parser cannot make them new execution attestations.
export function validateTaskCloseout(value) {
  if (!hasExactly(value, ["scope", "completed", "unverified", "next_action"])
    || !Array.isArray(value.completed) || value.completed.length > 12
    || !Array.isArray(value.unverified) || value.unverified.length > 12
    || (!value.completed.length && !value.unverified.length)) throw new Error("task_checkpoint_invalid_shape");
  return {
    scope: summary(value.scope, 240),
    completed: value.completed.map((item) => {
      if (!hasExactly(item, ["work", "evidence"]) || !Array.isArray(item.evidence)
        || !item.evidence.length || item.evidence.length > 6) throw new Error("task_checkpoint_evidence_required");
      const seen = new Set();
      return { work: summary(item.work, 320), evidence: item.evidence.map((evidence) => {
        if (!hasExactly(evidence, ["kind", "ref"]) || !EVIDENCE_TYPES.has(evidence.kind)
          || typeof evidence.ref !== "string" || !EVIDENCE_ID.test(evidence.ref)
          || containsRedactedSensitiveToken(redactSensitiveText(evidence.ref, { phoneNumbers: "filtered" }))) {
          throw new Error("task_checkpoint_invalid_reference");
        }
        const key = `${evidence.kind}\0${evidence.ref}`;
        if (seen.has(key)) throw new Error("task_checkpoint_duplicate_reference");
        seen.add(key);
        return { kind: evidence.kind, ref: evidence.ref };
      }) };
    }),
    unverified: value.unverified.map((item) => {
      if (!hasExactly(item, ["reason", "detail"]) || !GAP_TYPES.has(item.reason)) {
        throw new Error("task_checkpoint_invalid_gap");
      }
      return { reason: item.reason, detail: summary(item.detail, 320) };
    }),
    next_action: value.next_action === null ? null : summary(value.next_action, 320)
  };
}

async function resolveIdentity(cwd, taskId, env) {
  if (typeof taskId !== "string" || !ID.test(taskId)
    || containsRedactedSensitiveToken(redactSensitiveText(taskId, { phoneNumbers: "filtered" }))) {
    throw new Error("task_checkpoint_explicit_task_id_required");
  }
  const directory = await realpath(cwd);
  const mapping = await resolveWorkspaceMapping(await loadWorkspaceConfig(workspacesFileFromEnv(env)), directory);
  const tenantId = mapping.entry?.tenant_id;
  const projectId = mapping.entry?.project_id;
  if (!tenantId || !projectId || !mapping.root) throw new Error("task_checkpoint_workspace_requires_tenant_and_project");
  // A mapped common repository supplies authorization context, but a linked
  // worktree supplies its own checkpoint identity. No cross-worktree reuse.
  let workspaceRoot = mapping.root;
  if (mapping.source !== "workspace") {
    try {
      const result = await run("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
        timeout: 1_000, maxBuffer: 16_384, windowsHide: true
      });
      workspaceRoot = await realpath(result.stdout.trim());
    } catch (error) {
      // Do not fall back to a common Git root when worktree identity fails.
      if (mapping.source !== "project-file") throw error;
    }
  }
  const workspace = await realpath(workspaceRoot);
  return { identity: { tenantId, projectId, taskId, workspace }, entry: mapping.entry };
}

export async function resolveCloseoutIdentity(cwd, taskId, env = process.env) {
  return (await resolveIdentity(cwd, taskId, env)).identity;
}

export async function resolveCloseoutLessonIdentity(cwd, taskId, env = process.env) {
  const { identity, entry } = await resolveIdentity(cwd, taskId, env);
  return { ...identity, businessCategoryId: entry.business_category_id, workType: entry.default_work_type };
}

export function taskCloseoutKeys({ tenantId, projectId, taskId, workspace }) {
  const digest = createHash("sha256").update(JSON.stringify([tenantId, projectId, workspace, taskId])).digest("hex");
  return { id: `closeout:${digest}`, taskKey: `closeout:${digest}` };
}
