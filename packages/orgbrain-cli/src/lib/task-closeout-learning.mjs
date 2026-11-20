import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { isTransientMemory } from "@org-brain/shared/runtime/memory-admission-runtime";
import { screenInteractiveProse } from "@org-brain/shared/runtime/memory-review-runtime";
import { proposeLocalMemory } from "./mcp/memory-capture.mjs";
import { containsRedactedSensitiveToken, redactSensitiveText } from "./sensitive-text-redaction.mjs";

const run = promisify(execFile);
const gitOptions = { encoding: "buffer", timeout: 3_000, maxBuffer: 128 * 1024, windowsHide: true };
const sourcePath = /^(?:[\p{L}\p{N}_-][\p{L}\p{N}._-]*\/)*[\p{L}\p{N}_-][\p{L}\p{N}._-]*\.(?:md|txt)$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exact(value, fields) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)));
}

function lessonText(value, field, limit) {
  if (typeof value !== "string" || value.trim().length > limit || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error(`task_lesson_invalid_${field}`);
  }
  const text = screenInteractiveProse(value, field);
  if (/^(?:unknown|none|n\/a|todo|tbd|未確認|不明|未定|なし)$/iu.test(text)
    || containsRedactedSensitiveToken(redactSensitiveText(text, { phoneNumbers: false }))) {
    throw new Error(`task_lesson_invalid_${field}`);
  }
  return text;
}

function normalize(value) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

async function readCommittedLessonSource(workspace, source) {
  if (!exact(source, ["path", "start_line", "end_line"]) || typeof source.path !== "string"
    || source.path.length > 180 || !sourcePath.test(source.path) || source.path !== source.path.normalize("NFKC")
    || !Number.isSafeInteger(source.start_line) || source.start_line < 1
    || !Number.isSafeInteger(source.end_line) || source.end_line < source.start_line
    || source.end_line - source.start_line > 3) throw new Error("task_lesson_invalid_source");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = async (...args) => (await run("git", ["-C", workspace, ...args], { ...gitOptions, env })).stdout;
  let commit, bytes;
  try {
    if (await realpath((await git("rev-parse", "--show-toplevel")).toString("utf8").trim()) !== workspace) {
      throw new Error("source_workspace_mismatch");
    }
    commit = (await git("rev-parse", "--verify", "HEAD^{commit}")).toString("utf8").trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new Error("source_commit_invalid");
    const entry = (await git("ls-tree", commit, "--", source.path)).toString("utf8");
    const blob = /^100(?:644|755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t/u.exec(entry)?.[1];
    if (!blob) throw new Error("source_not_regular");
    bytes = await git("cat-file", "blob", blob);
  } catch {
    throw new Error("task_lesson_source_unavailable");
  }
  let lines;
  try { lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/u); }
  catch { throw new Error("task_lesson_source_unavailable"); }
  if (source.end_line > lines.length) throw new Error("task_lesson_source_range_unavailable");
  return { commit, contentHash: sha256(bytes), excerpt: lines.slice(source.start_line - 1, source.end_line).join(" ") };
}

export async function proposeTaskCloseoutLesson({
  store, checkpointStore, identity, input, principal
}) {
  if (!exact(input, ["conclusion", "rationale", "reuse_when", "source"])) throw new Error("task_lesson_invalid_shape");
  const conclusion = lessonText(input.conclusion, "conclusion", 240);
  const rationale = lessonText(input.rationale, "rationale", 500);
  const reuseWhen = lessonText(input.reuse_when, "reuse_when", 320);
  if (new Set([conclusion, rationale, reuseWhen].map(normalize)).size !== 3) throw new Error("task_lesson_requires_distinct_fields");
  const resumed = await checkpointStore.resumeCloseout(identity);
  if (!resumed) throw new Error("task_lesson_checkpoint_missing");
  const { scope, completed, unverified, next_action: nextAction } = resumed.checkpoint;
  const checkpointText = [scope, nextAction, ...completed.map((item) => item.work), ...unverified.map((item) => item.detail)];
  const checkpointProse = checkpointText.filter(Boolean).map(normalize);
  if ([conclusion, rationale, reuseWhen].map(normalize).some((text) => checkpointProse.includes(text))
    || isTransientMemory({ summary: conclusion, content: conclusion })) throw new Error("task_lesson_transient_progress");
  const source = await readCommittedLessonSource(identity.workspace, input.source);
  // Accept exactly the one documented rule the independent source supports,
  // not invented claims prefixed/suffixed to a valid quotation.
  if (normalize(source.excerpt) !== normalize(conclusion)) throw new Error("task_lesson_conclusion_not_in_source");
  const { path, start_line: startLine, end_line: endLine } = input.source;
  const sourceRef = `repo:${identity.projectId}/${path}`;
  const candidateHash = sha256(JSON.stringify([identity.tenantId, identity.projectId, conclusion, rationale, reuseWhen,
    sourceRef, startLine, endLine, source.contentHash]));
  return proposeLocalMemory(store, {
    tenant_id: identity.tenantId,
    source: "task-closeout-lesson",
    actor_id: principal,
    item: {
      external_key: `task-lesson:${candidateHash}`,
      content: conclusion,
      summary: conclusion,
      project_id: identity.projectId,
      business_category_id: identity.businessCategoryId,
      work_type: identity.workType,
      tags: ["source-backed-task-lesson"]
    },
    review_context: {
      candidate_id: `task-lesson:${candidateHash}`,
      candidate_hash: candidateHash,
      conclusion,
      reason_summary: rationale,
      reuse_rule: reuseWhen,
      source_references: [{ type: "document", ref: sourceRef, content_hash: source.contentHash }]
    },
    evidence: [{
      evidence_type: "doc",
      evidence_ref: `git:${source.commit}:${path}#L${startLine}-L${endLine}`,
      relation: "supports",
      note: "Exact passage verified from committed source; runtime behavior is not verified."
    }]
  }, { pinnedSourceReview: true });
}
