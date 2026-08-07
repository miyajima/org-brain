import { HttpError, sha256, ulid } from "@org-brain/shared";
import type { Env } from "./types";

export type RetrievalGenerationAssignment = {
  tenant_id: string;
  project_scope_key: string;
  active_generation_id: string;
  shadow_generation_id: string | null;
  shadow_sample_rate: number;
  updated_at: number;
};

function objectBody(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  return raw as Record<string, unknown>;
}

export async function createRetrievalRankingProfile(env: Env, raw: unknown) {
  const body = objectBody(raw);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 128) : "";
  const algorithm = typeof body.algorithm === "string" ? body.algorithm.trim().slice(0, 128) : "";
  if (!name) throw new HttpError(400, "ranking_profile_name_required", "name is required");
  if (!algorithm) throw new HttpError(400, "ranking_algorithm_required", "algorithm is required");
  if (algorithm !== "reciprocal_rank_fusion") {
    throw new HttpError(400, "unsupported_ranking_algorithm", "this deployment supports reciprocal_rank_fusion only");
  }
  const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : {};
  const supportedConfigKeys = new Set([
    "rrf_constant", "atomic_weight", "profile_weight",
    "timeline_weight", "ledger_weight", "decision_weight"
  ]);
  const unsupportedConfigKey = Object.keys(config as Record<string, unknown>).find((key) => !supportedConfigKeys.has(key));
  if (unsupportedConfigKey) {
    throw new HttpError(400, "unsupported_ranking_config", `unsupported ranking config key: ${unsupportedConfigKey}`);
  }
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new HttpError(400, "invalid_ranking_config", `${key} must be a non-negative finite number`);
    }
  }
  const configJson = JSON.stringify(config, Object.keys(config as Record<string, unknown>).sort());
  const now = Date.now();
  const profile = {
    id: typeof body.id === "string" && body.id.trim() ? body.id.trim().slice(0, 128) : ulid(now),
    name,
    algorithm,
    config_json: configJson,
    config_hash: await sha256(configJson),
    created_at: now
  };
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO retrieval_ranking_profiles(id, name, algorithm, config_json, config_hash, created_at)
     VALUES(?,?,?,?,?,?)`
  ).bind(...Object.values(profile)).run();
  return profile;
}

export async function createRetrievalGeneration(env: Env, raw: unknown) {
  const body = objectBody(raw);
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 160) : "";
  const extractorName = typeof body.extractor_name === "string" ? body.extractor_name.trim().slice(0, 128) : "";
  const extractorVersion = typeof body.extractor_version === "string" ? body.extractor_version.trim().slice(0, 64) : "";
  const rankingProfileId = typeof body.ranking_profile_id === "string" ? body.ranking_profile_id.trim().slice(0, 128) : "";
  const unitSchemaVersion = Number(body.unit_schema_version);
  if (!label) throw new HttpError(400, "generation_label_required", "label is required");
  if (!extractorName || !extractorVersion) throw new HttpError(400, "extractor_required", "extractor_name and extractor_version are required");
  if (![1, 2].includes(unitSchemaVersion)) {
    throw new HttpError(400, "unsupported_unit_schema_version", "this deployment supports unit schema versions 1 and 2");
  }
  const supportedExtractorVersion = unitSchemaVersion === 1 ? "1" : "4";
  if (extractorName !== "retrieval-units" || extractorVersion !== supportedExtractorVersion) {
    throw new HttpError(
      400,
      "unsupported_retrieval_extractor",
      `unit schema ${unitSchemaVersion} requires retrieval-units extractor version ${supportedExtractorVersion} in this deployment`
    );
  }
  if (!rankingProfileId) throw new HttpError(400, "ranking_profile_id_required", "ranking_profile_id is required");
  const profile = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM retrieval_ranking_profiles WHERE id = ? AND retired_at IS NULL"
  ).bind(rankingProfileId).first<{ id: string }>();
  if (!profile) throw new HttpError(400, "ranking_profile_not_found", "ranking profile not found or retired");
  const baselineGenerationId = typeof body.baseline_generation_id === "string" && body.baseline_generation_id.trim()
    ? body.baseline_generation_id.trim().slice(0, 128)
    : null;
  if (baselineGenerationId) {
    const baseline = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id FROM retrieval_generations WHERE id = ? AND status NOT IN ('retired', 'failed')"
    ).bind(baselineGenerationId).first<{ id: string }>();
    if (!baseline) throw new HttpError(400, "baseline_generation_not_found", "baseline generation not found or unavailable");
  }
  const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config : {};
  const configJson = JSON.stringify(config, Object.keys(config as Record<string, unknown>).sort());
  const now = Date.now();
  const generation = {
    id: typeof body.id === "string" && body.id.trim() ? body.id.trim().slice(0, 128) : ulid(now),
    label,
    unit_schema_version: unitSchemaVersion,
    extractor_name: extractorName,
    extractor_version: extractorVersion,
    embedding_profile_id: typeof body.embedding_profile_id === "string" ? body.embedding_profile_id.trim().slice(0, 128) : null,
    ranking_profile_id: rankingProfileId,
    config_hash: await sha256(configJson),
    baseline_generation_id: baselineGenerationId,
    status: "building",
    created_at: now
  };
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO retrieval_generations(
       id, label, unit_schema_version, extractor_name, extractor_version,
       embedding_profile_id, ranking_profile_id, config_hash,
       baseline_generation_id, status, created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(...Object.values(generation)).run();
  return generation;
}

type StableUnitRow = Record<string, unknown> & {
  id: string;
  source_type: string;
  source_id: string;
  content_hash: string;
  text: string;
};

export async function backfillRetrievalGeneration(env: Env, tenantId: string, generationId: string, raw: unknown) {
  const body = objectBody(raw);
  const generation = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, unit_schema_version, extractor_name, extractor_version,
            baseline_generation_id, status
     FROM retrieval_generations WHERE id = ?`
  ).bind(generationId).first<{
    id: string; unit_schema_version: number; extractor_name: string; extractor_version: string;
    baseline_generation_id: string | null; status: string;
  }>();
  if (!generation) throw new HttpError(404, "retrieval_generation_not_found", "retrieval generation not found");
  if (!["building", "shadow"].includes(generation.status)) {
    throw new HttpError(409, "retrieval_generation_not_buildable", "only building or shadow generations can be backfilled");
  }
  const sourceGenerationId = generation.baseline_generation_id ||
    (generation.unit_schema_version === 1 ? "gen_baseline_units" : "gen_structured_context");
  if (sourceGenerationId === generationId) throw new HttpError(409, "retrieval_generation_self_baseline", "generation cannot backfill from itself");
  const sourceGeneration = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, unit_schema_version, status FROM retrieval_generations WHERE id = ?"
  ).bind(sourceGenerationId).first<{ id: string; unit_schema_version: number; status: string }>();
  if (!sourceGeneration || ["retired", "failed"].includes(sourceGeneration.status)) {
    throw new HttpError(409, "retrieval_baseline_unavailable", "baseline generation is unavailable");
  }
  if (sourceGeneration.unit_schema_version !== generation.unit_schema_version) {
    throw new HttpError(409, "retrieval_baseline_schema_mismatch", "baseline and target unit schemas must match");
  }
  const projectId = typeof body.project_id === "string" && body.project_id.trim() ? body.project_id.trim().slice(0, 128) : null;
  const limit = Math.min(500, Math.max(1, Math.floor(Number(body.limit ?? 100))));
  const reset = body.reset === true;
  const now = Date.now();
  let job = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, cursor, processed_sources, projected_units, state
     FROM retrieval_projection_jobs
     WHERE generation_id = ? AND tenant_id = ? AND project_id IS ?`
  ).bind(generationId, tenantId, projectId).first<{
    id: string; cursor: string; processed_sources: number; projected_units: number; state: string;
  }>();
  if (job?.state === "failed" && !reset) {
    throw new HttpError(
      409,
      "retrieval_projection_reset_required",
      "failed projection jobs must be restarted with reset=true"
    );
  }
  if (reset && job) {
    const targetIds = (await env.OPEN_BRAIN_DB.prepare(
      "SELECT id FROM retrieval_units WHERE generation_id = ? AND tenant_id = ? AND (? IS NULL OR project_id = ? OR project_id IS NULL)"
    ).bind(generationId, tenantId, projectId, projectId).all<{ id: string }>()).results;
    if (targetIds.length) {
      for (let offset = 0; offset < targetIds.length; offset += 50) {
        const chunk = targetIds.slice(offset, offset + 50);
        await env.OPEN_BRAIN_DB.prepare(
          `DELETE FROM retrieval_units_fts WHERE unit_id IN (${chunk.map(() => "?").join(",")})`
        ).bind(...chunk.map((item) => item.id)).run();
      }
      await env.OPEN_BRAIN_DB.batch([
        env.OPEN_BRAIN_DB.prepare("DELETE FROM retrieval_units WHERE generation_id = ? AND tenant_id = ? AND (? IS NULL OR project_id = ? OR project_id IS NULL)").bind(generationId, tenantId, projectId, projectId),
        env.OPEN_BRAIN_DB.prepare("DELETE FROM retrieval_projection_jobs WHERE id = ?").bind(job.id)
      ]);
    } else {
      await env.OPEN_BRAIN_DB.prepare("DELETE FROM retrieval_projection_jobs WHERE id = ?").bind(job.id).run();
    }
    job = null;
  }
  const jobId = job?.id ?? ulid(now);
  if (!job) {
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO retrieval_projection_jobs(
         id, generation_id, tenant_id, project_id, cursor, processed_sources,
         projected_units, state, started_at, updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).bind(jobId, generationId, tenantId, projectId, "", 0, 0, "running", now, now).run();
  } else {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE retrieval_projection_jobs
       SET state = 'running', error_code = NULL,
           started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`
    ).bind(now, now, jobId).run();
  }
  try {
  const cursor = job?.cursor ?? "";
  let cursorType = "";
  let cursorSourceId = "";
  if (cursor) {
    try {
      const parsed = JSON.parse(cursor) as unknown;
      if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((value) => typeof value === "string")) {
        [cursorType, cursorSourceId] = parsed;
      } else {
        throw new Error("invalid cursor");
      }
    } catch {
      [cursorType, cursorSourceId] = cursor.split("\0", 2);
    }
  }
  const rows = (await env.OPEN_BRAIN_DB.prepare(
    `WITH next_sources AS (
       SELECT source_type, source_id
       FROM retrieval_units
       WHERE generation_id = ? AND tenant_id = ? AND (? IS NULL OR project_id = ? OR project_id IS NULL)
         AND (? = '' OR source_type > ? OR (source_type = ? AND source_id > ?))
       GROUP BY source_type, source_id
       ORDER BY source_type, source_id LIMIT ?
     )
     SELECT u.* FROM retrieval_units u
     JOIN next_sources s ON s.source_type = u.source_type AND s.source_id = u.source_id
     WHERE u.generation_id = ? AND u.tenant_id = ? AND (? IS NULL OR u.project_id = ? OR u.project_id IS NULL)
     ORDER BY u.source_type, u.source_id, u.id`
  ).bind(
    sourceGenerationId, tenantId, projectId, projectId,
    cursorType, cursorType, cursorType, cursorSourceId, limit,
    sourceGenerationId, tenantId, projectId, projectId
  ).all<StableUnitRow>()).results;
  const sourceKeys = [...new Set(rows.map((row) => `${row.source_type}\0${row.source_id}`))];
  const statements: D1PreparedStatement[] = [];
  for (const sourceKey of sourceKeys) {
    const [sourceType, sourceId] = sourceKey.split("\0");
    const existingIds = (await env.OPEN_BRAIN_DB.prepare(
      "SELECT id FROM retrieval_units WHERE generation_id = ? AND tenant_id = ? AND source_type = ? AND source_id = ?"
    ).bind(generationId, tenantId, sourceType, sourceId).all<{ id: string }>()).results;
    if (existingIds.length) {
      statements.push(env.OPEN_BRAIN_DB.prepare(
        `DELETE FROM retrieval_units_fts WHERE unit_id IN (${existingIds.map(() => "?").join(",")})`
      ).bind(...existingIds.map((item) => item.id)));
    }
    statements.push(env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM retrieval_units WHERE generation_id = ? AND tenant_id = ? AND source_type = ? AND source_id = ?"
    ).bind(generationId, tenantId, sourceType, sourceId));
  }
  const columns = [
    "id", "generation_id", "tenant_id", "project_id", "source_type", "source_id",
    "business_category_id", "work_type", "unit_type", "text", "speaker", "event_at",
    "valid_from", "valid_until", "source_ref_json", "source_span_start", "source_span_end",
    "metadata_json", "segment_id", "content_hash", "extractor_name", "extractor_version",
    "extraction_state", "degraded_reason", "created_at"
  ];
  for (const row of rows) {
    const targetId = `stable_${(await sha256(`${generationId}\0${row.id}`)).slice(0, 40)}`;
    const values = columns.map((column) => {
      if (column === "id") return targetId;
      if (column === "generation_id") return generationId;
      if (column === "extractor_name") return generation.extractor_name;
      if (column === "extractor_version") return generation.extractor_version;
      return row[column] ?? null;
    });
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO retrieval_units(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`
    ).bind(...values));
    statements.push(env.OPEN_BRAIN_DB.prepare(
      "INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text) VALUES(?,?,?,?)"
    ).bind(targetId, generationId, tenantId, row.text));
  }
  for (let offset = 0; offset < statements.length; offset += 50) {
    await env.OPEN_BRAIN_DB.batch(statements.slice(offset, offset + 50));
  }
  const nextCursor = rows.length
    ? JSON.stringify([rows.at(-1)!.source_type, rows.at(-1)!.source_id])
    : cursor;
  const done = sourceKeys.length < limit;
  const digestRows = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT source_type, source_id, unit_type, content_hash FROM retrieval_units
     WHERE generation_id = ? AND tenant_id = ? AND (? IS NULL OR project_id = ? OR project_id IS NULL)
     ORDER BY source_type, source_id, unit_type, content_hash`
  ).bind(generationId, tenantId, projectId, projectId).all<Record<string, unknown>>()).results;
  const recordDigest = await sha256([...new Set(digestRows.map((row) => `${row.source_type}:${row.source_id}`))].join("\0"));
  const unitDigest = await sha256(digestRows.map((row) =>
    `${row.source_type}:${row.source_id}:${row.unit_type}:${row.content_hash}`
  ).join("\0"));
  const sourceDigestRows = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT source_type, source_id, unit_type, content_hash FROM retrieval_units
     WHERE generation_id = ? AND tenant_id = ? AND (? IS NULL OR project_id = ? OR project_id IS NULL)
     ORDER BY source_type, source_id, unit_type, content_hash`
  ).bind(sourceGenerationId, tenantId, projectId, projectId).all<Record<string, unknown>>()).results;
  const sourceRecordDigest = await sha256([...new Set(sourceDigestRows.map((row) => `${row.source_type}:${row.source_id}`))].join("\0"));
  const sourceUnitDigest = await sha256(sourceDigestRows.map((row) =>
    `${row.source_type}:${row.source_id}:${row.unit_type}:${row.content_hash}`
  ).join("\0"));
  const digestMatch = recordDigest === sourceRecordDigest && unitDigest === sourceUnitDigest;
  if (done && !digestMatch) {
    throw new HttpError(409, "retrieval_projection_digest_mismatch", "baseline changed during backfill; restart the job with reset=true");
  }
  const processedSources = Number(job?.processed_sources ?? 0) + sourceKeys.length;
  const projectedUnits = Number(job?.projected_units ?? 0) + rows.length;
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE retrieval_projection_jobs SET cursor = ?, processed_sources = ?, projected_units = ?,
       record_digest = ?, unit_digest = ?, state = ?, updated_at = ?, completed_at = ?
     WHERE id = ?`
  ).bind(nextCursor, processedSources, projectedUnits, recordDigest, unitDigest,
    done ? "completed" : "running", Date.now(), done ? Date.now() : null, jobId).run();
  return {
    job_id: jobId, generation_id: generationId, source_generation_id: sourceGenerationId,
    tenant_id: tenantId, project_id: projectId, processed_sources: sourceKeys.length,
    projected_units: rows.length, total_processed_sources: processedSources,
    total_projected_units: projectedUnits, record_digest: recordDigest,
    unit_digest: unitDigest, source_record_digest: sourceRecordDigest,
    source_unit_digest: sourceUnitDigest, digest_match: digestMatch,
    next_cursor: nextCursor || null, done
  };
  } catch (error) {
    const errorCode = error instanceof HttpError
      ? error.code
      : error instanceof Error ? error.message.slice(0, 128) : "retrieval_projection_failed";
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE retrieval_projection_jobs
       SET state = 'failed', error_code = ?, updated_at = ? WHERE id = ?`
    ).bind(errorCode, Date.now(), jobId).run();
    throw error;
  }
}

export async function resolveRetrievalGenerationAssignment(
  env: Env,
  tenantId: string,
  projectId: string | null
): Promise<RetrievalGenerationAssignment> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT tenant_id, project_scope_key, active_generation_id,
            shadow_generation_id, shadow_sample_rate, updated_at
     FROM retrieval_generation_assignments
     WHERE tenant_id = ? AND project_scope_key IN (?, '*')
     ORDER BY CASE WHEN project_scope_key = ? THEN 0 ELSE 1 END
     LIMIT 1`
  ).bind(tenantId, projectId ?? "", projectId ?? "").all<RetrievalGenerationAssignment>();
  const assignment = result.results[0];
  if (!assignment) {
    throw new HttpError(503, "retrieval_assignment_missing", "no tenant or project retrieval generation assignment exists");
  }
  const ids = [assignment.active_generation_id, assignment.shadow_generation_id].filter(Boolean) as string[];
  const generations = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, status FROM retrieval_generations WHERE id IN (${ids.map(() => "?").join(",")})`
  ).bind(...ids).all<{ id: string; status: string }>();
  const status = new Map(generations.results.map((row) => [row.id, row.status]));
  if (!["active", "fallback"].includes(status.get(assignment.active_generation_id) ?? "")) {
    throw new HttpError(503, "retrieval_assignment_invalid", "active generation is unavailable");
  }
  if (
    assignment.shadow_generation_id &&
    !["building", "shadow", "active", "fallback"].includes(status.get(assignment.shadow_generation_id) ?? "")
  ) {
    throw new HttpError(503, "retrieval_shadow_invalid", "shadow generation is unavailable");
  }
  return assignment;
}

const TRANSITIONS: Record<string, string[]> = {
  building: ["shadow", "failed"],
  shadow: ["active", "fallback", "failed", "retired"],
  active: ["fallback", "retired", "failed"],
  fallback: ["active", "retired", "failed"],
  retired: [],
  failed: ["building", "retired"]
};

export async function transitionRetrievalGeneration(
  env: Env,
  generationId: string,
  status: string,
  raw: unknown = {}
) {
  const current = (await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, status FROM retrieval_generations WHERE id = ?"
  ).bind(generationId).all<{ id: string; status: string }>()).results[0];
  if (!current) throw new HttpError(404, "retrieval_generation_not_found", "retrieval generation not found");
  const previousStatus = current.status;
  if (!(TRANSITIONS[current.status] ?? []).includes(status)) {
    throw new HttpError(409, "invalid_retrieval_generation_transition", `cannot transition ${current.status} to ${status}`);
  }
  if (current.status === "shadow" && status === "active") {
    const body = objectBody(raw);
    const evidence = objectBody(body.promotion_evidence);
    const checks: Array<[boolean, string]> = [
      [Number(evidence.projection_coverage_percent) === 100, "projection coverage must be 100%"],
      [evidence.digest_match === true, "record and unit digests must match"],
      [Number(evidence.tenant_acl_category_violations) === 0, "tenant, ACL, and category violations must be zero"],
      [evidence.offline_benchmark_non_degraded === true, "offline benchmark must be non-degraded"],
      [Number(evidence.candidate_empty_rate_delta_points) <= 0.5, "candidate empty-rate delta exceeds 0.5 points"],
      [Number(evidence.error_rate_delta_points) <= 0.5, "error-rate delta exceeds 0.5 points"],
      [Number(evidence.p95_latency_ratio) <= 1.15, "p95 latency exceeds 1.15x baseline"],
      [Number(evidence.critical_regressions) === 0, "critical regressions must be zero"],
      [Number(evidence.shadow_observation_days) >= 7, "shadow observation must cover at least seven days"],
      [typeof evidence.verification_ref_id === "string" && evidence.verification_ref_id.trim().length > 0, "verification_ref_id is required"]
    ];
    const failed = checks.find(([passed]) => !passed);
    if (failed) throw new HttpError(409, "retrieval_promotion_gate_failed", failed[1]);
    const projection = await env.OPEN_BRAIN_DB.prepare(
      `SELECT COUNT(*) AS total_jobs,
              SUM(CASE WHEN state = 'completed' AND record_digest IS NOT NULL AND unit_digest IS NOT NULL THEN 1 ELSE 0 END) AS completed_jobs
       FROM retrieval_projection_jobs WHERE generation_id = ?`
    ).bind(generationId).first<{ total_jobs: number; completed_jobs: number }>();
    if (!projection || Number(projection.total_jobs) < 1 || Number(projection.completed_jobs) !== Number(projection.total_jobs)) {
      throw new HttpError(409, "retrieval_projection_incomplete", "all generation projection jobs must be completed with digests");
    }
    const missingAssignments = await env.OPEN_BRAIN_DB.prepare(
      `SELECT COUNT(*) AS missing_count
       FROM retrieval_generation_assignments a
       WHERE a.shadow_generation_id = ? AND NOT EXISTS (
         SELECT 1 FROM retrieval_projection_jobs j
         WHERE j.generation_id = a.shadow_generation_id
           AND j.tenant_id = a.tenant_id AND j.state = 'completed'
           AND ((a.project_scope_key = '*' AND j.project_id IS NULL) OR j.project_id = a.project_scope_key)
       )`
    ).bind(generationId).first<{ missing_count: number }>();
    if (Number(missingAssignments?.missing_count ?? 0) > 0) {
      throw new HttpError(409, "retrieval_assignment_projection_incomplete", "every shadow assignment requires a completed matching projection job");
    }
    const shadowStats = await env.OPEN_BRAIN_DB.prepare(
      `SELECT COUNT(*) AS sample_count, MIN(created_at) AS first_sample_at
       FROM retrieval_evaluation_events WHERE candidate_generation_id = ?`
    ).bind(generationId).first<{ sample_count: number; first_sample_at: number | null }>();
    if (
      Number(shadowStats?.sample_count ?? 0) < 1 ||
      Number(shadowStats?.first_sample_at ?? Date.now()) > Date.now() - 7 * 86_400_000
    ) {
      throw new HttpError(409, "retrieval_shadow_window_incomplete", "recorded shadow evaluation must span at least seven days");
    }
  }
  if (["retired", "failed"].includes(status)) {
    const assignment = await env.OPEN_BRAIN_DB.prepare(
      `SELECT tenant_id, project_scope_key FROM retrieval_generation_assignments
       WHERE active_generation_id = ? OR shadow_generation_id = ? LIMIT 1`
    ).bind(generationId, generationId).first<{ tenant_id: string; project_scope_key: string }>();
    if (assignment) {
      throw new HttpError(
        409,
        "retrieval_generation_still_assigned",
        "remove the generation from all active and shadow assignments before retiring or failing it"
      );
    }
  }
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE retrieval_generations
     SET status = ?,
         activated_at = CASE WHEN ? = 'active' THEN ? ELSE activated_at END,
         retired_at = CASE WHEN ? = 'retired' THEN ? ELSE retired_at END
     WHERE id = ?`
  ).bind(status, status, now, status, now, generationId).run();
  return { generation_id: generationId, previous_status: previousStatus, status };
}

export async function assignRetrievalGeneration(
  env: Env,
  tenantId: string,
  raw: unknown
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = raw as Record<string, unknown>;
  const projectScopeKey = typeof body.project_scope_key === "string" && body.project_scope_key.trim()
    ? body.project_scope_key.trim().slice(0, 128)
    : "*";
  const activeGenerationId = typeof body.active_generation_id === "string"
    ? body.active_generation_id.trim()
    : "";
  const shadowGenerationId = typeof body.shadow_generation_id === "string" && body.shadow_generation_id.trim()
    ? body.shadow_generation_id.trim()
    : null;
  const sampleRate = Number(body.shadow_sample_rate ?? 0.1);
  if (!activeGenerationId) throw new HttpError(400, "active_generation_id_required", "active_generation_id is required");
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new HttpError(400, "invalid_shadow_sample_rate", "shadow_sample_rate must be between 0 and 1");
  }
  const generationIds = [activeGenerationId, shadowGenerationId].filter(Boolean) as string[];
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, status FROM retrieval_generations WHERE id IN (${generationIds.map(() => "?").join(",")})`
  ).bind(...generationIds).all<{ id: string; status: string }>();
  const status = new Map(rows.results.map((row) => [row.id, row.status]));
  if (!["active", "fallback"].includes(status.get(activeGenerationId) ?? "")) {
    throw new HttpError(409, "active_generation_not_eligible", "active generation must be active or fallback");
  }
  if (shadowGenerationId && !["building", "shadow", "active", "fallback"].includes(status.get(shadowGenerationId) ?? "")) {
    throw new HttpError(409, "shadow_generation_not_eligible", "shadow generation is not eligible");
  }
  if (status.get(activeGenerationId) === "active") {
    const projectId = projectScopeKey === "*" ? null : projectScopeKey;
    const projection = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM retrieval_projection_jobs
       WHERE generation_id = ? AND tenant_id = ? AND project_id IS ?
         AND state = 'completed' AND record_digest IS NOT NULL AND unit_digest IS NOT NULL
       LIMIT 1`
    ).bind(activeGenerationId, tenantId, projectId).first<{ id: string }>();
    if (!projection) {
      throw new HttpError(
        409,
        "retrieval_assignment_projection_incomplete",
        "the target tenant/project requires a completed projection job with matching digests"
      );
    }
    const evaluation = await env.OPEN_BRAIN_DB.prepare(
      `SELECT COUNT(*) AS sample_count, MIN(created_at) AS first_sample_at
       FROM retrieval_evaluation_events
       WHERE tenant_id = ? AND project_id IS ? AND candidate_generation_id = ?`
    ).bind(tenantId, projectId, activeGenerationId).first<{
      sample_count: number;
      first_sample_at: number | null;
    }>();
    if (
      Number(evaluation?.sample_count ?? 0) < 1 ||
      Number(evaluation?.first_sample_at ?? Date.now()) > Date.now() - 7 * 86_400_000
    ) {
      throw new HttpError(
        409,
        "retrieval_assignment_shadow_window_incomplete",
        "the target tenant/project requires recorded shadow evaluation spanning at least seven days"
      );
    }
  }
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO retrieval_generation_assignments(
       tenant_id, project_scope_key, active_generation_id,
       shadow_generation_id, shadow_sample_rate, updated_at
     ) VALUES(?,?,?,?,?,?)
     ON CONFLICT(tenant_id, project_scope_key) DO UPDATE SET
       active_generation_id = excluded.active_generation_id,
       shadow_generation_id = excluded.shadow_generation_id,
       shadow_sample_rate = excluded.shadow_sample_rate,
       updated_at = excluded.updated_at`
  ).bind(tenantId, projectScopeKey, activeGenerationId, shadowGenerationId, sampleRate, now).run();
  return {
    tenant_id: tenantId,
    project_scope_key: projectScopeKey,
    active_generation_id: activeGenerationId,
    shadow_generation_id: shadowGenerationId,
    shadow_sample_rate: sampleRate,
    updated_at: now
  };
}
