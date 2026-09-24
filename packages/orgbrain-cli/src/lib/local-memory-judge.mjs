import { appendFile, chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  createMemoryJudge, createOpenRouterMemoryTransport, MEMORY_JUDGMENT_MODEL,
  MEMORY_JUDGMENT_VERSION, normalizeJudgmentPolicy, judgmentHash, memoryJudgmentPolicyHash
} from "../../../shared/src/memory-judgment-runtime.mjs";
import { qualifyMemoryJudgment } from "../../../shared/src/memory-judgment-evaluation.mjs";
import { localJudgmentImplementationHash } from "./local-memory-judgment-binding.mjs";
import { CLI_BUILD_INFO } from "../build-info.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

export async function openJudgmentDatabase(dbPath) {
  const file = `${dbPath}.jev.sqlite`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try { const handle = await open(file, "wx", 0o600); await handle.close(); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid_judgment_store");
  await chmod(file, 0o600);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS decisions (key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_queue (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
      source TEXT NOT NULL, mode TEXT NOT NULL, records_json TEXT NOT NULL, content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      judgment_json TEXT, completed_at INTEGER);`);
  return db;
}

export function localJudgmentPolicy(stage, projectId, env = process.env) {
  const projects = String(env.ORGBRAIN_JEV_PROJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return normalizeJudgmentPolicy({
    mode: projectId && projects.includes(projectId) ? env[`ORGBRAIN_JEV_${stage.toUpperCase()}_MODE`] : "off",
    capture_assessment_mode: stage === "capture" ? env.ORGBRAIN_JEV_CAPTURE_ASSESSMENT_MODE : "off",
    threshold: env.ORGBRAIN_JEV_THRESHOLD
  });
}

export function memoryJudgmentCandidate(memory, id = memory.id, { includeCaptureAssessment = false } = {}) {
  let learning = memory.learning ?? memory.learning_json ?? memory.observation ?? {};
  if (includeCaptureAssessment && typeof learning === "string") {
    try { learning = JSON.parse(learning); } catch { learning = {}; }
  }
  if (!learning || Array.isArray(learning)) learning = {};
  const kind = memory.kind ?? memory.memory_kind;
  const protectedReasons = [];
  if (kind === "constraint") protectedReasons.push("constraint");
  if (memory.explicit_save === true || learning.explicit_save === true) protectedReasons.push("explicit_save");
  if (memory.user_correction === true || learning.user_correction === true || learning.correction) protectedReasons.push("user_correction");
  if ((kind === "pitfall" || learning.lesson_type === "failure") && !learning.verified_outcome) protectedReasons.push("unresolved_failure");
  if (memory.confirmation_only) protectedReasons.push("human_confirmation");
  return {
    id, text: String(memory.content ?? memory.text ?? learning.decision ?? learning.verified_outcome ?? ""),
    rationale: memory.rationale ?? learning.rationale ?? null,
    reuse_rule: memory.reuse_rule ?? memory.reuseRule ?? learning.reuse_when ?? null,
    source_text: memory.source_text ?? learning.source_text ?? null,
    ...(includeCaptureAssessment ? {
      lesson_type: ["decision", "success", "failure"].includes(learning.lesson_type) ? learning.lesson_type : null,
      lesson_context: Object.fromEntries(["procedure", "why_it_worked", "observed_outcome", "decision", "selected_value",
      "symptom", "failed_approach", "root_cause", "correction", "verified_outcome", "avoidance_rule"]
      .filter((key) => typeof learning[key] === "string" && learning[key].trim())
      .map((key) => [key, learning[key]]))
    } : {}),
    evidence: memory.evidence ?? [], source_references: memory.source_references ?? memory.sourceReferences ?? [],
    project_id: memory.project_id ?? memory.projectId ?? null,
    version: memory.current_version ?? memory.version ?? null,
    kind: kind ?? null, created_at: memory.created_at ?? memory.createdAt ?? null,
    valid_until: memory.valid_until ?? memory.validUntil ?? memory.expires_at ?? null,
    verification_state: memory.verification_state ?? memory.verification?.state ?? null,
    conflicts: memory.conflicts ?? [], protected_reasons: protectedReasons
  };
}

// Qualification reports are created by the evaluation CLI, never by a model
// answering a retrieval request. This checks scope/bindings, not a self-score.
export async function readJudgmentQualification(file, stage, policy) {
  if (!file) return false;
  try {
    const report = JSON.parse(await readFile(file, "utf8"));
    const root = dirname(resolve(file));
    const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
    if (manifest.implementation_hash !== await localJudgmentImplementationHash()) return false;
    const observations = JSON.parse(await readFile(resolve(root, "outcomes.json"), "utf8"));
    const recomputed = await qualifyMemoryJudgment(manifest, observations);
    if (await judgmentHash(report) !== await judgmentHash(recomputed)) return false;
    for (const observation of observations) for (const key of ["artifact", "test"]) {
      const path = resolve(root, observation.verification?.[`${key}_path`] ?? "");
      if (!path.startsWith(`${root}${sep}`)) return false;
      const bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== observation.verification[`${key}_hash`]) return false;
      if (key === "test") {
        const receipt = JSON.parse(bytes.toString());
        if (receipt.case_id !== observation.case_id || receipt.arm !== observation.arm || receipt.passed !== observation.task_success
          || receipt.artifact_hash !== observation.verification.artifact_hash) return false;
      }
    }
    return report.schema === "memory-judgment-qualification/v1" && report.status === "passed"
      && report.policy_version === MEMORY_JUDGMENT_VERSION && report.model === MEMORY_JUDGMENT_MODEL
      && report.threshold === policy.threshold && report.stages?.includes(stage)
      && report.policy_hash === await memoryJudgmentPolicyHash(policy.threshold)
      && report.evidence_kind === "verified_task_outcomes" && report.holdout_count >= 20
      && report.critical_regressions === 0 && report.task_success_improvement > 0
      && report.false_application_regression <= 0 && report.required_memory_loss_regression <= 0
      && /^[a-f0-9]{64}$/u.test(report.manifest_hash ?? "") && /^[a-f0-9]{64}$/u.test(report.evidence_hash ?? "");
  } catch { return false; }
}

export function createLocalMemoryJudge({ dbPath, env = process.env, transport, shadowOnly = false } = {}) {
  const cache = {
    async get(key) {
      const db = await openJudgmentDatabase(dbPath);
      try { const row = db.prepare("SELECT response FROM decisions WHERE key = ?").get(key); return row ? JSON.parse(row.response) : undefined; }
      finally { db.close(); }
    },
    async set(key, response) {
      const db = await openJudgmentDatabase(dbPath);
      try {
        db.prepare("INSERT OR REPLACE INTO decisions VALUES (?, ?, ?)").run(key, JSON.stringify(response), Date.now());
        db.exec("DELETE FROM decisions WHERE key NOT IN (SELECT key FROM decisions ORDER BY created_at DESC LIMIT 256)");
      } finally { db.close(); }
    }
  };
  const judge = createMemoryJudge({ cache, transport: transport ?? createOpenRouterMemoryTransport({ apiKey: env.OPENROUTER_API_KEY }) });
  return async ({ stage, context, candidates }) => {
    const policy = localJudgmentPolicy(stage, context.project_id, env);
    if (shadowOnly && policy.mode === "active") policy.mode = "shadow";
    const activeQualified = policy.mode === "active" && await readJudgmentQualification(env.ORGBRAIN_JEV_QUALIFICATION_FILE, stage, policy);
    const result = await judge({ stage, context, candidates, policy, active_qualified: activeQualified });
    if (policy.mode !== "off") {
      // No prompt, original ID, text, credentials, or provider error bodies.
      const file = `${dbPath}.jev-metrics.jsonl`;
      try {
        const trace = { ...result, telemetry_version: "memory-judgment-telemetry/v2", event_id: randomUUID(), recorded_at: Date.now(), build: CLI_BUILD_INFO,
          project_hash: await judgmentHash(context.project_id), tenant_hash: await judgmentHash(context.tenant_id ?? "default"),
          policy_hash: await memoryJudgmentPolicyHash(policy.threshold),
          decisions: await Promise.all(result.decisions.map(async ({ id, duplicate_of, ...decision }, index) => ({ ...decision,
            candidate_hash: await judgmentHash(id), candidate_snapshot_hash: await judgmentHash(candidates[index]) }))) };
        try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) return result; }
        catch (error) { if (error.code !== "ENOENT") return result; }
        await appendFile(file, `${JSON.stringify(trace)}\n`, { mode: 0o600 });
        await chmod(file, 0o600);
      } catch { /* Telemetry failure cannot alter retrieval or capture. */ }
    }
    return result;
  };
}

export function createLearningCandidateJudge(options) {
  const judge = createLocalMemoryJudge(options);
  return async (rows, tenantId) => {
    const projects = new Map();
    for (const row of rows) {
      const policy = localJudgmentPolicy("capture", row.project_id, options.env ?? process.env);
      if (policy.mode === "off") continue;
      const group = projects.get(row.project_id) ?? [];
      let payload;
      try { payload = JSON.parse(row.payload_json); } catch { continue; }
      group.push(memoryJudgmentCandidate({ ...payload, ...(payload.item ?? {}),
        project_id: row.project_id, valid_until: row.expires_at }, row.id,
      { includeCaptureAssessment: policy.capture_assessment_mode === "shadow" }));
      projects.set(row.project_id, group);
    }
    const reports = [];
    for (const [projectId, candidates] of projects) reports.push(await judge({ stage: "capture",
      context: { tenant_id: tenantId, project_id: projectId, purpose: "Select reusable learning for this project. Existing verification and consensus remain required." }, candidates }));
    return reports.length ? { reports, omitted: reports.filter((r) => r.applied).flatMap((r) => r.decisions.filter((d) => d.action === "omit").map((d) => d.id)) } : null;
  };
}
