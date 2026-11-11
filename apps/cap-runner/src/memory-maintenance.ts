import {
  assessMemoryUsefulness,
  buildMemoryCaptureCandidateJson,
  autonomyPolicyHash,
  decideAutonomyAction,
  normalizeAutonomyPolicy,
  planMemoryMaintenanceCore,
  planDecisionClassificationRepairRows as planSharedDecisionClassificationRepairRows,
  planMemoryRepairRows as planSharedMemoryRepairRows,
  type DecisionClassificationRepairPlan,
  type MemoryRepairOptions,
  type MemoryRepairPlan,
  type MemoryRepairRow
} from "@org-brain/shared";

export function canonicalTenantMemoryCandidate(record: Record<string, unknown>): Record<string, unknown> {
  return buildMemoryCaptureCandidateJson(record);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_GROUP_MIN = 4;
const DIGEST_OLDER_THAN_DAYS = 7;
const DUPLICATE_OLDER_THAN_DAYS = 14;
const MAINTENANCE_SOURCE_ALLOWLIST = ["codex", "claude", "cursor", "openclaw", "opencode"] as const;

type RawMemoryRow = {
  id: string;
  project_id: string | null;
  source: string;
  summary: string | null;
  content: string;
  tags_json: string | null;
  created_at: number;
  lifecycle_state?: string | null;
  kind?: string | null;
  scope_type?: string | null;
  scope_key?: string | null;
  confidence_score?: number | null;
  utility_score?: number | null;
  canonical_key?: string | null;
  current_version?: number | null;
  expires_at?: number | null;
};

type PlannedDigest = {
  external_key: string;
  project_id: string | null;
  source: "org-brain";
  created_at: number;
  tags: string[];
  summary: string;
  content: string;
  member_ids: string[];
};

type PlannedCanonicalMemory = {
  external_key: string;
  project_id: string | null;
  source: "org-brain";
  created_at: number;
  tags: string[];
  summary: string;
  content: string;
  member_ids: string[];
};

type PlannedCompaction = {
  id: string;
  reason: "digest" | "duplicate";
  digest_external_key: string | null;
  next_tags: string[];
};

type PlannedQualityUpdate = {
  id: string;
  project_id: string | null;
  source: string;
  content: string;
  summary: string;
  tags_json: string | null;
  kind: string;
  lifecycle_state: string;
  scope_type: string;
  scope_key: string | null;
  canonical_key: string | null;
  current_version: number;
  confidence_score: number;
  utility_score: number;
  expires_at: number | null;
  reason: string;
  risky_low_signal: boolean;
  suppression_candidate: boolean;
  short_summary_candidate: boolean;
  artifact_expiry_candidate: boolean;
};

type MaintenancePlan = {
  canonicals: PlannedCanonicalMemory[];
  digests: PlannedDigest[];
  compactions: PlannedCompaction[];
  qualityUpdates: PlannedQualityUpdate[];
  stats: {
    scanned_count: number;
    canonical_group_count: number;
    canonical_memory_count: number;
    digest_group_count: number;
    digested_memory_count: number;
    duplicate_compaction_count: number;
    total_compaction_count: number;
    quality_update_count: number;
    quality_missing_score_count: number;
    quality_expiry_update_count: number;
    quality_low_signal_count: number;
    quality_short_summary_candidate_count: number;
    quality_suppression_candidate_count: number;
    quality_artifact_expiry_candidate_count: number;
  };
};

export type TenantMaintenanceResult = {
  tenant_id: string;
  applied: boolean;
  stats: MaintenancePlan["stats"];
  autonomy?: {
    mode: string;
    policy_hash: string;
    run_id: string | null;
    requested_mutation_count: number;
    applied_mutation_count: number;
    quarantined_mutation_count: number;
    deferred_mutation_count: number;
    judge_consensus_passed: boolean;
    quarantine_normalized_count: number;
    quarantine_expired_count: number;
  };
};

export type AutonomyMaintenanceOptions = {
  autonomyPolicy?: Record<string, unknown>;
  judgeConsensus?: { pass?: boolean; judgments?: unknown[] } | null;
  runId?: string;
};

type NormalizedAutonomyPolicy = {
  mode: string;
  quarantine: {
    expire_after_days?: number;
  };
  maintenance: {
    max_mutations_per_run?: number;
    max_mutation_ratio_per_run?: number;
  };
};

/**
 * Repair planning deliberately delegates to the same deterministic policy used
 * by local SQLite and the API capture path. The cap runner only supplies D1
 * rows; it does not maintain a second classifier.
 */
export async function planTenantMemoryRepair(
  rows: MemoryRepairRow[],
  options: MemoryRepairOptions = {}
): Promise<MemoryRepairPlan> {
  return planSharedMemoryRepairRows(rows, options);
}

export async function planTenantDecisionClassificationRepair(
  rows: Array<{
    id: string;
    project_id?: string | null;
    business_category_id?: string | null;
    work_type?: string | null;
    status?: string | null;
  }>,
  tenantId = "default"
): Promise<DecisionClassificationRepairPlan> {
  return planSharedDecisionClassificationRepairRows(rows, { tenant_id: tenantId });
}

function collapseWhitespace(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function nullableNumberEqual(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return Math.abs(Number(left) - Number(right)) < 0.0005;
}

function normalizeTextForCompare(value: unknown): string {
  return collapseWhitespace(value);
}

export function planMemoryMaintenance(rows: RawMemoryRow[], options: { tenantId?: string; now?: number } = {}): MaintenancePlan {
  const core = planMemoryMaintenanceCore(rows, {
    tenantId: options.tenantId,
    now: options.now,
    digestOlderThanDays: DIGEST_OLDER_THAN_DAYS,
    duplicateOlderThanDays: DUPLICATE_OLDER_THAN_DAYS,
    digestGroupMin: DIGEST_GROUP_MIN
  });
  const { canonicals, digests, compactions } = core;
  const compactedIds = new Set(compactions.map((item) => item.id));
  const qualityUpdates: PlannedQualityUpdate[] = [];

  for (const row of rows) {
    const assessment = assessMemoryUsefulness(row);
    const summaryChanged = normalizeTextForCompare(row.summary) !== normalizeTextForCompare(assessment.summary);
    const confidenceChanged = !nullableNumberEqual(row.confidence_score, assessment.confidence_score);
    const utilityChanged = !nullableNumberEqual(row.utility_score, assessment.utility_score);
    const expiryChanged = !nullableNumberEqual(row.expires_at, assessment.expires_at);
    if (!summaryChanged && !confidenceChanged && !utilityChanged && !expiryChanged) continue;
    qualityUpdates.push({
      id: row.id,
      project_id: row.project_id ?? null,
      source: row.source,
      content: row.content,
      summary: assessment.summary,
      tags_json: row.tags_json ?? null,
      kind: row.kind ?? "episodic",
      lifecycle_state: row.lifecycle_state ?? "active",
      scope_type: row.scope_type ?? (row.project_id ? "project" : "tenant"),
      scope_key: row.scope_key ?? row.project_id ?? null,
      canonical_key: row.canonical_key ?? null,
      current_version: Number(row.current_version ?? 1),
      confidence_score: assessment.confidence_score,
      utility_score: assessment.utility_score,
      expires_at: assessment.expires_at,
      reason: assessment.reason,
      risky_low_signal: assessment.risky_low_signal,
      suppression_candidate: assessment.suppression_candidate,
      short_summary_candidate: assessment.short_summary_candidate,
      artifact_expiry_candidate: assessment.artifact_expiry_candidate
    });
  }

  const activeQualityUpdates = qualityUpdates.filter((item) => !compactedIds.has(item.id));

  return {
    canonicals,
    digests,
    compactions,
    qualityUpdates: activeQualityUpdates,
    stats: {
      ...core.stats,
      quality_update_count: activeQualityUpdates.length,
      quality_missing_score_count: rows.filter((row) => row.utility_score === null || row.utility_score === undefined || row.confidence_score === null || row.confidence_score === undefined).length,
      quality_expiry_update_count: activeQualityUpdates.filter((item) => item.expires_at !== null).length,
      quality_low_signal_count: activeQualityUpdates.filter((item) => item.risky_low_signal).length,
      quality_short_summary_candidate_count: activeQualityUpdates.filter((item) => item.short_summary_candidate).length,
      quality_suppression_candidate_count: activeQualityUpdates.filter((item) => item.suppression_candidate).length,
      quality_artifact_expiry_candidate_count: activeQualityUpdates.filter((item) => item.artifact_expiry_candidate).length
    }
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function loadMaintenanceTenantIds(db: D1Database): Promise<string[]> {
  const result = await db.prepare(
    `SELECT DISTINCT tenant_id
       FROM memories
      WHERE source IN (${MAINTENANCE_SOURCE_ALLOWLIST.map(() => "?").join(", ")})
      ORDER BY tenant_id ASC
      LIMIT 100`
  )
    .bind(...MAINTENANCE_SOURCE_ALLOWLIST)
    .all<{ tenant_id: string }>();
  return result.results.map((row) => row.tenant_id).filter(Boolean);
}

async function loadMaintenanceRows(db: D1Database, tenantId: string): Promise<RawMemoryRow[]> {
  const result = await db.prepare(
    `SELECT id, project_id, source, summary, content, tags_json, created_at, lifecycle_state,
            kind, scope_type, scope_key, confidence_score, utility_score, canonical_key, current_version, expires_at
       FROM memories
      WHERE tenant_id = ?
        AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
        AND (tags_json IS NULL OR tags_json NOT LIKE '%"compacted"%')
        AND source IN (${MAINTENANCE_SOURCE_ALLOWLIST.map(() => "?").join(", ")})
      ORDER BY created_at DESC
      LIMIT 5000`
  )
    .bind(tenantId, ...MAINTENANCE_SOURCE_ALLOWLIST)
    .all<RawMemoryRow>();
  return result.results;
}

async function loadExistingDigestIdsByExternalKeys(
  db: D1Database,
  tenantId: string,
  externalKeys: string[]
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (externalKeys.length === 0) return results;
  for (const chunk of chunkArray(externalKeys, 100)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const response = await db.prepare(
      `SELECT id, external_key
         FROM memories
        WHERE tenant_id = ?
          AND external_key IN (${placeholders})`
    )
      .bind(tenantId, ...chunk)
      .all<{ id: string; external_key: string | null }>();
    for (const row of response.results) {
      if (row.external_key) results.set(row.external_key, row.id);
    }
  }
  return results;
}

async function runBatchChunks(db: D1Database, statements: D1PreparedStatement[], chunkSize = 80): Promise<void> {
  for (const chunk of chunkArray(statements, chunkSize)) {
    if (chunk.length === 0) continue;
    await db.batch(chunk);
  }
}

function buildApplyStatements(
  db: D1Database,
  tenantId: string,
  plan: Pick<MaintenancePlan, "canonicals" | "digests" | "compactions" | "qualityUpdates">,
  existingDigestIds: Map<string, string>
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];

  for (const synthesized of [...plan.canonicals, ...plan.digests]) {
    const tagsJson = JSON.stringify(synthesized.tags);
    const existingId = existingDigestIds.get(synthesized.external_key);
    const assessment = assessMemoryUsefulness({
      project_id: synthesized.project_id,
      source: synthesized.source,
      content: synthesized.content,
      summary: synthesized.summary,
      tags: synthesized.tags,
      created_at: synthesized.created_at
    });
    if (existingId) {
      statements.push(
        db.prepare(
          "UPDATE memories SET project_id = ?, content = ?, summary = ?, tags_json = ?, source = ?, created_at = ?, kind = ?, lifecycle_state = ?, confidence_score = ?, utility_score = ?, expires_at = ?, consolidated_at = ?, revised_at = ? WHERE tenant_id = ? AND id = ?"
        ).bind(
          synthesized.project_id,
          synthesized.content,
          synthesized.summary,
          tagsJson,
          "org-brain",
          synthesized.created_at,
          "semantic",
          "active",
          assessment.confidence_score,
          assessment.utility_score,
          assessment.expires_at,
          synthesized.created_at,
          synthesized.created_at,
          tenantId,
          existingId
        ),
        db.prepare("DELETE FROM memories_fts WHERE memory_id = ? AND tenant_id = ?").bind(existingId, tenantId),
        db.prepare("INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)").bind(existingId, tenantId, `${synthesized.summary}\n${synthesized.content}`)
      );
      continue;
    }

    const id = `mem_digest_${synthesized.external_key.replace(/[^A-Za-z0-9_]/g, "_")}`;
    statements.push(
      db.prepare(
        "INSERT INTO memories(id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at, confidence_score, utility_score, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        id,
        tenantId,
        synthesized.project_id,
        synthesized.content,
        synthesized.summary,
        tagsJson,
        "org-brain",
        synthesized.external_key,
        synthesized.created_at,
        assessment.confidence_score,
        assessment.utility_score,
        assessment.expires_at
      ),
      db.prepare(
        "UPDATE memories SET kind = ?, lifecycle_state = ?, consolidated_at = ?, revised_at = ? WHERE tenant_id = ? AND id = ?"
      ).bind("semantic", "active", synthesized.created_at, synthesized.created_at, tenantId, id),
      db.prepare("INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)").bind(id, tenantId, `${synthesized.summary}\n${synthesized.content}`)
    );
  }

  for (const update of plan.qualityUpdates) {
    const nextVersion = update.current_version + 1;
    statements.push(
      db.prepare(
        `UPDATE memories
            SET summary = ?, confidence_score = ?, utility_score = ?, expires_at = ?, current_version = ?, revised_at = ?
          WHERE tenant_id = ? AND id = ?`
      ).bind(update.summary, update.confidence_score, update.utility_score, update.expires_at, nextVersion, Date.now(), tenantId, update.id),
      db.prepare(
        `INSERT INTO memory_versions(
          id, memory_id, tenant_id, version, operation, content, summary, tags_json, kind, lifecycle_state,
          scope_type, scope_key, actor_type, actor_id, confidence_score, utility_score, canonical_key, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        `quality_maintenance_${update.id}_${nextVersion}`,
        update.id,
        tenantId,
        nextVersion,
        "quality-maintenance",
        update.content,
        update.summary,
        update.tags_json,
        update.kind,
        update.lifecycle_state,
        update.scope_type,
        update.scope_key,
        "system",
        "memory-maintenance",
        update.confidence_score,
        update.utility_score,
        update.canonical_key,
        Date.now()
      ),
      db.prepare("DELETE FROM memories_fts WHERE memory_id = ? AND tenant_id = ?").bind(update.id, tenantId),
      db.prepare("INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)").bind(update.id, tenantId, `${update.summary}\n${update.content}`)
    );
  }

  for (const compaction of plan.compactions) {
    statements.push(
      db.prepare("UPDATE memories SET tags_json = ?, lifecycle_state = ?, suppressed_at = ?, revised_at = ? WHERE tenant_id = ? AND id = ?").bind(
        JSON.stringify(compaction.next_tags),
        "suppressed",
        Date.now(),
        Date.now(),
        tenantId,
        compaction.id
      ),
      db.prepare("DELETE FROM memories_fts WHERE memory_id = ? AND tenant_id = ?").bind(compaction.id, tenantId)
    );
  }

  return statements;
}

export async function runTenantMemoryMaintenance(
  db: D1Database,
  tenantId: string,
  now = Date.now(),
  options: AutonomyMaintenanceOptions = {}
): Promise<TenantMaintenanceResult> {
  const rows = await loadMaintenanceRows(db, tenantId);
  const plan = planMemoryMaintenance(rows, { tenantId, now });

  const autonomyPolicy = options.autonomyPolicy
    ? normalizeAutonomyPolicy(options.autonomyPolicy) as unknown as NormalizedAutonomyPolicy
    : null;
  let quarantineNormalizedCount = 0;
  let quarantineExpiredCount = 0;
  if (autonomyPolicy) {
    const quarantineExpireCutoff = now - Number(autonomyPolicy.quarantine?.expire_after_days ?? 180) * DAY_MS;
    const normalizedResult = await db.prepare(
      "UPDATE memory_learning_candidates SET status = 'quarantine' WHERE tenant_id = ? AND status = 'review'"
    ).bind(tenantId).run();
    const expiredResult = await db.prepare(
      "UPDATE memory_learning_candidates SET status = 'expired', reviewed_at = ? WHERE tenant_id = ? AND status = 'quarantine' AND (expires_at <= ? OR created_at <= ?)"
    ).bind(now, tenantId, now, quarantineExpireCutoff).run();
    quarantineNormalizedCount = Number(normalizedResult.meta?.changes ?? 0);
    quarantineExpiredCount = Number(expiredResult.meta?.changes ?? 0);
  }
  const judgeConsensusPassed = options.judgeConsensus?.pass === true;
  const judgments = Array.isArray(options.judgeConsensus?.judgments) ? options.judgeConsensus.judgments : [];
  const gate = (action: string) => autonomyPolicy
    ? decideAutonomyAction({
      action,
      policy: autonomyPolicy,
      deterministic: { passed: true },
      judgments,
      candidate: { route: "active" }
    })
    : { action: "apply" };
  const plannedSemantic = [...plan.canonicals, ...plan.digests];
  const semanticDecision = gate("active_promotion");
  const compactionDecision = gate("suppress");
  const qualityDecision = gate("summary_revise");
  const requestedMutationCount = plannedSemantic.length + plan.compactions.length + plan.qualityUpdates.length;
  const mutationLimit = autonomyPolicy
    ? Math.max(1, Math.min(
      Number(autonomyPolicy.maintenance.max_mutations_per_run ?? requestedMutationCount),
      Math.ceil(Math.max(1, rows.length) * Number(autonomyPolicy.maintenance.max_mutation_ratio_per_run ?? 1))
    ))
    : Number.POSITIVE_INFINITY;
  let remainingMutationSlots = Math.min(requestedMutationCount, mutationLimit);
  const permittedSemantic = semanticDecision.action === "apply" ? plannedSemantic.slice(0, remainingMutationSlots) : [];
  remainingMutationSlots -= permittedSemantic.length;
  const permittedCompactions = compactionDecision.action === "apply" ? plan.compactions.slice(0, Math.max(0, remainingMutationSlots)) : [];
  remainingMutationSlots -= permittedCompactions.length;
  const permittedQualityUpdates = qualityDecision.action === "apply" ? plan.qualityUpdates.slice(0, Math.max(0, remainingMutationSlots)) : [];
  const appliedMutationCount = permittedSemantic.length + permittedCompactions.length + permittedQualityUpdates.length;
  const quarantinedMutationCount = [semanticDecision, compactionDecision, qualityDecision]
    .filter((decision) => decision.action === "quarantine").length > 0
    ? requestedMutationCount - appliedMutationCount
    : 0;
  const deferredMutationCount = requestedMutationCount - appliedMutationCount;
  const autonomy = autonomyPolicy ? {
    mode: autonomyPolicy.mode,
    policy_hash: autonomyPolicyHash(autonomyPolicy),
    run_id: options.runId ?? null,
    requested_mutation_count: requestedMutationCount,
    applied_mutation_count: appliedMutationCount,
    quarantined_mutation_count: quarantinedMutationCount,
    deferred_mutation_count: deferredMutationCount,
    judge_consensus_passed: judgeConsensusPassed,
    quarantine_normalized_count: quarantineNormalizedCount,
    quarantine_expired_count: quarantineExpiredCount
  } : undefined;

  if (plan.canonicals.length === 0 && plan.digests.length === 0 && plan.compactions.length === 0 && plan.qualityUpdates.length === 0) {
    return { tenant_id: tenantId, applied: false, stats: plan.stats, ...(autonomy ? { autonomy } : {}) };
  }

  const existingDigestIds = await loadExistingDigestIdsByExternalKeys(
    db,
    tenantId,
    [...plan.canonicals, ...plan.digests].map((item) => item.external_key)
  );

  for (const synthesized of permittedSemantic) {
    await runBatchChunks(
      db,
      buildApplyStatements(db, tenantId, { canonicals: [synthesized as PlannedCanonicalMemory], digests: [], compactions: [], qualityUpdates: [] }, existingDigestIds),
      10
    );
  }

  await runBatchChunks(
    db,
    buildApplyStatements(db, tenantId, { canonicals: [], digests: [], compactions: permittedCompactions, qualityUpdates: [] }, existingDigestIds),
    80
  );

  await runBatchChunks(
    db,
    buildApplyStatements(db, tenantId, { canonicals: [], digests: [], compactions: [], qualityUpdates: permittedQualityUpdates }, existingDigestIds),
    40
  );

  return { tenant_id: tenantId, applied: appliedMutationCount > 0, stats: plan.stats, ...(autonomy ? { autonomy } : {}) };
}

export async function runScheduledMemoryMaintenance(
  db: D1Database,
  now = Date.now(),
  options: AutonomyMaintenanceOptions = {}
): Promise<TenantMaintenanceResult[]> {
  const tenantIds = await loadMaintenanceTenantIds(db);
  const results: TenantMaintenanceResult[] = [];
  for (const tenantId of tenantIds) {
    results.push(await runTenantMemoryMaintenance(db, tenantId, now, options));
  }
  return results;
}
