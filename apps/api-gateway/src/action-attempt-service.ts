import {
  attemptSummaryJa,
  normalizeAttempt,
  normalizeAttemptConditions,
  normalizeAttemptMetricEvent,
  normalizeAttemptUse,
  preflightAttempt,
  publicAttempt,
  rankAttempts,
  sha256,
  type AttemptRow,
  type PublicAttempt
} from "@org-brain/shared";
import type { Env } from "./types";

function projectId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value)) throw new Error("invalid_project_id");
  return value;
}

function actionKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value)) throw new Error("invalid_action_key");
  return value;
}

export async function recordActionAttempt(
  env: Env,
  tenantId: string,
  principal: string,
  raw: Record<string, unknown>,
  options: { trusted?: boolean } = {}
): Promise<PublicAttempt & { deduplicated?: boolean }> {
  // MCP callers cannot assert either verification or another person's identity.
  const trusted = options.trusted === true;
  const input = trusted ? raw : { ...raw, executed_by_type: "unknown", executed_by: null };
  const row = normalizeAttempt(input, { tenantId, principal, trusted });
  const db = env.OPEN_BRAIN_DB;
  const previous = await db.prepare("SELECT * FROM action_attempts WHERE tenant_id=? AND source_key=?")
    .bind(tenantId, row.source_key).first<AttemptRow>();
  if (previous) {
    const comparable = Object.keys(row).filter((key) => key !== "created_at") as Array<keyof AttemptRow>;
    if (comparable.some((key) => previous[key] !== row[key])) throw new Error("attempt_source_key_conflict");
    return { ...publicAttempt(previous), deduplicated: true };
  }
  if (row.supersedes_id) {
    const prior = await db.prepare("SELECT id,project_id FROM action_attempts WHERE tenant_id=? AND id=?")
      .bind(tenantId, row.supersedes_id).first<{ id: string; project_id: string }>();
    if (!prior || prior.project_id !== row.project_id) throw new Error("superseded_attempt_not_found");
    const replacement = await db.prepare("SELECT id FROM action_attempts WHERE tenant_id=? AND supersedes_id=?")
      .bind(tenantId, row.supersedes_id).first<{ id: string }>();
    if (replacement) throw new Error("attempt_already_superseded");
  }
  const fields = Object.keys(row) as Array<keyof AttemptRow>;
  await db.prepare(`INSERT INTO action_attempts(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`)
    .bind(...fields.map((key) => row[key])).run();
  if (row.verification_state === "verified" && row.attempt_type === "intervention"
      && row.outcome === "failure" && row.failure_kind === "deterministic" && row.conditions_hash) {
    const patternKey = `attempt:${(await sha256(`${row.project_id}\0${row.action_key}\0${row.conditions_hash}`)).slice(0, 48)}`;
    await db.prepare(`INSERT OR IGNORE INTO memory_failure_patterns(
      id,tenant_id,project_id,business_category_id,work_type,pattern_key,label,
      action_fingerprint,failure_fingerprint,is_active,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      crypto.randomUUID(), tenantId, row.project_id, null, null, patternKey, row.action_label,
      await sha256(row.action_key), await sha256(row.result_summary), 1, row.created_at, row.created_at
    ).run();
    const pattern = await db.prepare("SELECT id FROM memory_failure_patterns WHERE tenant_id=? AND pattern_key=?")
      .bind(tenantId, patternKey).first<{ id: string }>();
    if (!pattern) throw new Error("failure_pattern_missing_after_insert");
    await db.prepare("INSERT INTO action_attempt_pattern_links(tenant_id,attempt_id,pattern_id) VALUES(?,?,?)")
      .bind(tenantId, row.id, pattern.id).run();
    const laterSuccess = await db.prepare(`SELECT 1 FROM action_attempts a
      WHERE a.tenant_id=? AND a.project_id=? AND a.action_key=? AND a.conditions_hash=?
        AND a.verification_state='verified' AND a.outcome='success' AND a.performed_at>=?
        AND NOT EXISTS (SELECT 1 FROM action_attempts next WHERE next.tenant_id=a.tenant_id AND next.supersedes_id=a.id)
      LIMIT 1`).bind(tenantId, row.project_id, row.action_key, row.conditions_hash, row.performed_at).first();
    await db.prepare("UPDATE memory_failure_patterns SET is_active=?,updated_at=? WHERE tenant_id=? AND id=?")
      .bind(laterSuccess ? 0 : 1, row.created_at, tenantId, pattern.id).run();
  }
  if (row.verification_state === "verified" && row.outcome === "success" && row.conditions_hash) {
    const patternKey = `attempt:${(await sha256(`${row.project_id}\0${row.action_key}\0${row.conditions_hash}`)).slice(0, 48)}`;
    const laterFailure = await db.prepare(`SELECT 1 FROM action_attempts a
      WHERE a.tenant_id=? AND a.project_id=? AND a.action_key=? AND a.conditions_hash=?
        AND a.verification_state='verified' AND a.attempt_type='intervention'
        AND a.outcome='failure' AND a.failure_kind='deterministic' AND a.performed_at>?
        AND NOT EXISTS (SELECT 1 FROM action_attempts next WHERE next.tenant_id=a.tenant_id AND next.supersedes_id=a.id)
      LIMIT 1`).bind(tenantId, row.project_id, row.action_key, row.conditions_hash, row.performed_at).first();
    if (!laterFailure) await db.prepare("UPDATE memory_failure_patterns SET is_active=0,updated_at=? WHERE tenant_id=? AND pattern_key=?")
      .bind(row.created_at, tenantId, patternKey).run();
  }
  if (row.supersedes_id) {
    const links = (await db.prepare("SELECT pattern_id FROM action_attempt_pattern_links WHERE tenant_id=? AND attempt_id=?")
      .bind(tenantId, row.supersedes_id).all<{ pattern_id: string }>()).results;
    for (const link of links) {
      const unresolved = await db.prepare(`SELECT COUNT(*) AS count FROM action_attempt_pattern_links l
        JOIN action_attempts a ON a.tenant_id=l.tenant_id AND a.id=l.attempt_id
        WHERE l.tenant_id=? AND l.pattern_id=? AND a.outcome='failure'
          AND NOT EXISTS (SELECT 1 FROM action_attempts next WHERE next.tenant_id=a.tenant_id AND next.supersedes_id=a.id)`)
        .bind(tenantId, link.pattern_id).first<{ count: number }>();
      if (!unresolved?.count) await db.prepare("UPDATE memory_failure_patterns SET is_active=0,updated_at=? WHERE tenant_id=? AND id=?")
        .bind(row.created_at, tenantId, link.pattern_id).run();
    }
  }
  return publicAttempt(row);
}

export async function searchActionAttempts(
  env: Env,
  tenantId: string,
  input: { project_id: string; action_key?: string | null; query?: string | null; limit?: number }
): Promise<PublicAttempt[]> {
  const project = projectId(input.project_id);
  const key = input.action_key ? actionKey(input.action_key) : null;
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  const rows = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT a.* FROM action_attempts a
     WHERE a.tenant_id=? AND a.project_id=? AND (? IS NULL OR a.action_key=?)
       AND NOT EXISTS (SELECT 1 FROM action_attempts next
                       WHERE next.tenant_id=a.tenant_id AND next.supersedes_id=a.id)
     ORDER BY a.performed_at DESC,a.id DESC LIMIT 500`
  ).bind(tenantId, project, key, key).all<AttemptRow>()).results;
  const ranked = rankAttempts(rows, input.query, limit);
  for (const attempt of ranked) {
    if (attempt.verification_state !== "verified" || attempt.executed_by_type !== "principal" || !attempt.executed_by) continue;
    const profile = await env.OPEN_BRAIN_DB.prepare(
      "SELECT display_name FROM user_profiles WHERE tenant_id=? AND principal=? AND status='active'"
    ).bind(tenantId, attempt.executed_by).first<{ display_name: string }>();
    if (profile?.display_name) Object.assign(attempt, { executed_by_name: profile.display_name });
  }
  for (const attempt of ranked) attempt.summary_ja = attemptSummaryJa(attempt);
  return ranked;
}

export async function preflightAction(
  env: Env,
  tenantId: string,
  input: { project_id: string; action_key: string; conditions?: Record<string, string>; change_hypothesis?: string;
    alternatives?: Array<{ action_key: string; label: string }> }
) {
  const key = actionKey(input.action_key);
  const condition = normalizeAttemptConditions(input.conditions);
  const attempts = await searchActionAttempts(env, tenantId, { project_id: input.project_id, action_key: key, limit: 100 });
  const decision = preflightAttempt(attempts, { action_key: key, conditions_hash: condition.conditions_hash,
    change_hypothesis: input.change_hypothesis });
  const alternative_candidates = [];
  for (const candidate of (input.alternatives ?? []).slice(0, 5)) {
    const otherKey = actionKey(candidate.action_key);
    const exists = await env.OPEN_BRAIN_DB.prepare(
      "SELECT 1 FROM action_attempts WHERE tenant_id=? AND project_id=? AND action_key=? LIMIT 1"
    ).bind(tenantId, input.project_id, otherKey).first();
    if (!exists) alternative_candidates.push({ action_key: otherKey, label: candidate.label.slice(0, 240), status: "no_accessible_prior_attempt" });
  }
  const event = await recordActionAttemptMetricEvent(env, tenantId, {
    project_id: input.project_id, kind: "preflight", source: "mcp", action_key: key,
    conditions_hash: condition.conditions_hash, decision: decision.decision, reason: decision.reason,
    matched_attempt_id: decision.prior_attempts[0]?.id ?? null
  });
  return { ...decision, alternative_candidates, preflight_event_id: event.id };
}

export async function recordActionAttemptMetricEvent(
  env: Env, tenantId: string, raw: Record<string, unknown>, options: { trusted?: boolean } = {}
) {
  const row = normalizeAttemptMetricEvent(raw, { tenantId, trusted: options.trusted === true });
  const db = env.OPEN_BRAIN_DB;
  if (row.kind === "feedback") {
    const prior = await db.prepare(`SELECT id,decision FROM action_attempt_metric_events
      WHERE tenant_id=? AND project_id=? AND id=? AND kind='preflight'`)
      .bind(tenantId, row.project_id, row.related_event_id).first<{ id: string; decision: string }>();
    if (!prior || prior.decision !== "block") throw new Error("blocked_preflight_event_not_found");
  }
  const previous = await db.prepare("SELECT * FROM action_attempt_metric_events WHERE tenant_id=? AND id=?")
    .bind(tenantId, row.id).first<Record<string, unknown>>();
  if (previous) {
    if (Object.keys(row).some((key) => key !== "created_at" && previous[key] !== row[key as keyof typeof row])) throw new Error("attempt_metric_id_conflict");
    return { ...previous, id: String(previous.id), verification_state: String(previous.verification_state),
      evidence: JSON.parse(String(previous.evidence_json)), deduplicated: true };
  }
  const fields = Object.keys(row) as Array<keyof typeof row>;
  await db.prepare(`INSERT INTO action_attempt_metric_events(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`)
    .bind(...fields.map((key) => row[key])).run();
  return { ...row, evidence: JSON.parse(row.evidence_json) };
}

export async function actionAttemptMetricsReport(env: Env, tenantId: string, project: string) {
  const id = projectId(project);
  const db = env.OPEN_BRAIN_DB;
  const counts = await db.prepare(`SELECT
    SUM(kind='context_query') AS context_queries,
    SUM(kind='context_query' AND returned_count>0) AS context_queries_with_history,
    SUM(kind='preflight') AS preflight_checks,
    SUM(kind='preflight' AND decision='block') AS preflight_blocks,
    SUM(kind='feedback' AND feedback_verdict='false_block' AND verification_state='reported') AS false_blocks_reported,
    SUM(kind='feedback' AND feedback_verdict='false_block' AND verification_state='verified') AS false_blocks_verified
    FROM action_attempt_metric_events WHERE tenant_id=? AND project_id=?`).bind(tenantId, id).first<Record<string, number | null>>();
  const coverage = (await db.prepare(`SELECT coverage,SUM(count) AS count FROM action_hook_coverage
    WHERE tenant_id=? AND project_id=? GROUP BY coverage`).bind(tenantId, id).all<{ coverage: string; count: number }>()).results;
  const usage = (await db.prepare(`SELECT stage,verification_state,COUNT(*) AS count FROM action_attempt_use_events
    WHERE tenant_id=? AND project_id=? GROUP BY stage,verification_state`).bind(tenantId, id).all()).results;
  const repeated = await db.prepare(`SELECT COUNT(*) AS count FROM action_attempts a
    WHERE a.tenant_id=? AND a.project_id=? AND a.attempt_type='intervention'
      AND a.conditions_hash IS NOT NULL AND EXISTS (
        SELECT 1 FROM action_attempts prior WHERE prior.tenant_id=a.tenant_id AND prior.project_id=a.project_id
          AND prior.action_key=a.action_key AND prior.conditions_hash=a.conditions_hash
          AND prior.verification_state='verified' AND prior.attempt_type='intervention'
          AND prior.outcome='failure' AND prior.failure_kind='deterministic'
          AND prior.performed_at<a.performed_at
          AND NOT EXISTS (SELECT 1 FROM action_attempts correction
            WHERE correction.tenant_id=prior.tenant_id AND correction.supersedes_id=prior.id)
      )`).bind(tenantId, id).first<{ count: number }>();
  const eventCounts = {
    context_queries: Number(counts?.context_queries ?? 0),
    context_queries_with_history: Number(counts?.context_queries_with_history ?? 0),
    preflight_checks: Number(counts?.preflight_checks ?? 0),
    preflight_blocks: Number(counts?.preflight_blocks ?? 0),
    false_blocks_reported: Number(counts?.false_blocks_reported ?? 0),
    false_blocks_verified: Number(counts?.false_blocks_verified ?? 0)
  };
  const coverageCounts = Object.fromEntries(coverage.map((row) => [row.coverage, Number(row.count)]));
  const checked = Number(coverageCounts.checked ?? 0) + Number(coverageCounts.blocked ?? 0);
  const opaque = Number(coverageCounts.opaque ?? 0);
  const returned = usage.filter((row) => row.stage === "returned")
    .reduce((sum, row) => sum + Number(row.count), 0);
  const verifiedAdoptions = usage.filter((row) => row.stage === "adopted" && row.verification_state === "verified")
    .reduce((sum, row) => sum + Number(row.count), 0);
  return { project_id: id, ...eventCounts, confirmed_same_condition_reexecutions: Number(repeated?.count ?? 0),
    history_return_rate: eventCounts.context_queries ? eventCounts.context_queries_with_history / eventCounts.context_queries : null,
    verified_adoption_rate: returned ? verifiedAdoptions / returned : null,
    opaque_operation_rate: checked + opaque ? opaque / (checked + opaque) : null,
    coverage: coverageCounts, usage };
}

export async function recordActionAttemptUse(
  env: Env, tenantId: string, raw: Record<string, unknown>, options: { trusted?: boolean } = {}
) {
  const row = normalizeAttemptUse(raw, { tenantId, trusted: options.trusted === true });
  const attempt = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM action_attempts WHERE tenant_id=? AND project_id=? AND id=?"
  ).bind(tenantId, row.project_id, row.attempt_id).first();
  if (!attempt) throw new Error("attempt_not_found");
  const previous = await env.OPEN_BRAIN_DB.prepare(
    "SELECT * FROM action_attempt_use_events WHERE tenant_id=? AND id=?"
  ).bind(tenantId, row.id).first<Record<string, unknown>>();
  if (previous) {
    if (Object.keys(row).some((key) => key !== "created_at" && previous[key] !== row[key as keyof typeof row])) throw new Error("attempt_use_id_conflict");
    return { ...previous, id: String(previous.id),
      verification_state: String(previous.verification_state),
      evidence: JSON.parse(String(previous.evidence_json)), deduplicated: true };
  }
  const fields = Object.keys(row) as Array<keyof typeof row>;
  await env.OPEN_BRAIN_DB.prepare(`INSERT INTO action_attempt_use_events(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`)
    .bind(...fields.map((key) => row[key])).run();
  return { ...row, evidence: JSON.parse(row.evidence_json) };
}

export async function actionAttemptUseReport(env: Env, tenantId: string, project: string) {
  return (await env.OPEN_BRAIN_DB.prepare(
    "SELECT stage,verification_state,COUNT(*) AS count FROM action_attempt_use_events WHERE tenant_id=? AND project_id=? GROUP BY stage,verification_state ORDER BY stage,verification_state"
  ).bind(tenantId, projectId(project)).all()).results;
}
