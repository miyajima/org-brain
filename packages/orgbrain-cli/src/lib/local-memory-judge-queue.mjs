import { existsSync } from "node:fs";
import { createLocalMemoryJudge, localJudgmentPolicy, memoryJudgmentCandidate, openJudgmentDatabase } from "./local-memory-judge.mjs";
import { judgmentHash } from "../../../shared/src/memory-judgment-runtime.mjs";

// Called by Stop: local persistence only, never inference. These are records
// already admitted by the existing hook, not a new memory-authorizing API.
export async function enqueueJudgmentCapture({ dbPath, tenantId, projectId, source, records, env = process.env, now = Date.now() }) {
  const policy = localJudgmentPolicy("capture", projectId, env);
  if (policy.mode === "off" || records.length === 0) return { queued: false, mode: "off" };
  if (records.length > 3 || records.some((r) => (r.projectId ?? r.project_id) !== projectId)) throw new Error("invalid_capture_judgment_batch");
  const contentHash = await judgmentHash({ tenantId, projectId, source, records });
  const id = await judgmentHash({ contentHash, mode: policy.mode });
  const db = await openJudgmentDatabase(dbPath);
  try {
    db.prepare("INSERT OR IGNORE INTO capture_queue (id, tenant_id, project_id, source, mode, records_json, content_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, tenantId, projectId, source, policy.mode, JSON.stringify(records), contentHash, now, now + 7 * 86400_000);
    return { queued: true, mode: policy.mode, id };
  } finally { db.close(); }
}

export async function drainJudgmentCapture({ dbPath, tenantId = "default", projectId, env = process.env, judge, capture, now: suppliedNow, allowActiveCapture = true }) {
  const now = suppliedNow ?? Date.now();
  if (!existsSync(`${dbPath}.jev.sqlite`)) return { processed: 0, captured: 0, judgments: [] };
  if (!projectId) return { processed: 0, captured: 0, judgments: [], skipped: "project_required" };
  const ask = judge ?? createLocalMemoryJudge({ dbPath, env });
  const save = capture ?? (async (source, tenant, records) => {
    const { captureLocalMemories } = await import("../hook-memory-bridge.mjs");
    const { LocalMemoryStore } = await import("./local-memory-store.mjs");
    return captureLocalMemories(source, tenant, records, { store: new LocalMemoryStore(dbPath) });
  });
  const db = await openJudgmentDatabase(dbPath);
  const report = { processed: 0, captured: 0, judgments: [] };
  try {
    // Completed evidence is transient and follows the queue's seven-day TTL.
    db.prepare("DELETE FROM capture_queue WHERE tenant_id=? AND project_id=? AND status='completed' AND expires_at <= ?").run(tenantId, projectId, now);
    const jobs = db.prepare("SELECT * FROM capture_queue WHERE tenant_id=? AND project_id=? AND status='pending' ORDER BY created_at LIMIT 20").all(tenantId, projectId);
    for (const job of jobs) {
      if (job.mode === "active" && !allowActiveCapture) continue;
      if (job.expires_at <= now) {
        db.prepare("UPDATE capture_queue SET status='expired' WHERE id=? AND status='pending'").run(job.id);
        continue;
      }
      if (!db.prepare("UPDATE capture_queue SET status='processing', completed_at=? WHERE id=? AND status='pending'").run(now, job.id).changes) continue;
      try {
        const records = JSON.parse(job.records_json);
        if (await judgmentHash({ tenantId, projectId, source: job.source, records }) !== job.content_hash) throw new Error("capture_snapshot_changed");
        const stillValid = (record) => {
          const expiry = record.valid_until ?? record.validUntil ?? record.expires_at;
          return expiry == null || expiry > (suppliedNow ?? Date.now());
        };
        const candidates = records.map((r, index) => ({ record: r, candidate: memoryJudgmentCandidate(r, `candidate-${index}`) }))
          .filter(({ record }) => stillValid(record)).map(({ candidate }) => candidate);
        const judgment = await ask({ stage: "capture", context: { tenant_id: tenantId, project_id: projectId, purpose: "Future reuse within this project; preserve candidate conditions." }, candidates });
        const decisions = new Map(judgment.decisions.map((item) => [item.id, item]));
        const retained = records.filter((record, index) => {
          return stillValid(record) && (!judgment.applied || decisions.get(`candidate-${index}`)?.action !== "omit");
        });
        // Shadow jobs have already followed the original hook capture path.
        // Active failure/abstention restores that same path, without another AI.
        if (job.mode === "active" && retained.length) report.captured += (await save(job.source, tenantId, retained)).length;
        db.prepare("UPDATE capture_queue SET status='completed', judgment_json=?, completed_at=? WHERE id=? AND status='processing'")
          .run(JSON.stringify(judgment), now, job.id);
        report.processed++;
        report.judgments.push(judgment);
      } catch {
        // Do not automatically resend an uncertain attempt or promote a corrupt
        // packet. Preserve its source for explicit inspection/recovery.
        db.prepare("UPDATE capture_queue SET status='held' WHERE id=? AND status='processing'").run(job.id);
        report.judgments.push({ status: "held", reason_code: "capture_processing_failed" });
      }
    }
  } finally { db.close(); }
  return report;
}

export async function inspectJudgmentCapture({ dbPath, tenantId = "default", projectId }) {
  if (!existsSync(`${dbPath}.jev.sqlite`)) return [];
  const db = await openJudgmentDatabase(dbPath);
  try {
    return db.prepare("SELECT id, mode, status, created_at, expires_at, completed_at FROM capture_queue WHERE tenant_id=? AND project_id=? ORDER BY created_at LIMIT 100")
      .all(tenantId, projectId);
  } finally { db.close(); }
}

// Explicit operator recovery restores the admitted baseline using its stable
// external keys. It never repeats an uncertain provider request.
export async function recoverJudgmentCapture({ dbPath, tenantId = "default", projectId, id, capture, now = Date.now() }) {
  const db = await openJudgmentDatabase(dbPath);
  try {
    const job = db.prepare("SELECT * FROM capture_queue WHERE tenant_id=? AND project_id=? AND id=?").get(tenantId, projectId, id);
    if (!job || !["held", "processing"].includes(job.status)) throw new Error("held_job_required");
    if (job.status === "processing" && now - job.completed_at < 300_000) throw new Error("capture_worker_may_be_running");
    const records = JSON.parse(job.records_json);
    if (await judgmentHash({ tenantId, projectId, source: job.source, records }) !== job.content_hash) throw new Error("capture_snapshot_changed");
    const retained = records.filter((r) => job.expires_at > now && (r.valid_until ?? r.validUntil ?? r.expires_at ?? Infinity) > now);
    let saved = [];
    if (job.mode === "active" && retained.length) {
      if (capture) saved = await capture(job.source, tenantId, retained);
      else {
        const { captureLocalMemories } = await import("../hook-memory-bridge.mjs");
        const { LocalMemoryStore } = await import("./local-memory-store.mjs");
        saved = await captureLocalMemories(job.source, tenantId, retained, { store: new LocalMemoryStore(dbPath) });
      }
    }
    db.prepare("UPDATE capture_queue SET status='completed', completed_at=?, judgment_json=? WHERE id=?")
      .run(now, JSON.stringify({ status: "baseline_restored", request_count: 0 }), id);
    return { id, status: "baseline_restored", captured: saved.length, request_count: 0 };
  } finally { db.close(); }
}
