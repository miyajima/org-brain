import { search, searchBase, selectMemorySearchResults, isPublicLocalMemory, canReadMemory } from "./local-memory-search.mjs";
import { captureIntoDatabase, writeRecord, writeVersion, validateBusinessClassification } from "./local-memory-capture.mjs";
import { MEMORY_SCHEMA_VERSION, hasTable, hasLegacyFtsTriggers, tableColumns, addIndexes, dropRebuildIndexes, migrateSchema } from "./local-memory-schema.mjs";
export { MEMORY_SCHEMA_VERSION } from "./local-memory-schema.mjs";
import { WORK_TYPES, normalizeRecord, hashContent, parseJson, parseJsonObject, normalizeStrings, normalizeObjects, json, nullableString, finiteNumber, memoryFromRow } from "./local-memory-record.mjs";
import { rebuildFts, rebuildLocalEmbeddings, rebuildRetrievalUnits, rebuildRetrievalUnitsV4, rebuildStableRetrievalUnits, wipeMemoryProjections } from "./local-memory-projections.mjs";
import { signMemoryUseAttestation } from '@org-brain/shared/runtime/memory-use-attestation';
import { estimateJsonTokens, estimateTextTokens, truncateTextToTokens } from '@org-brain/shared/runtime/token-estimate-core';
import { createLocalMemoryJudge, memoryJudgmentCandidate } from "./local-memory-judge.mjs";
import { localRelevanceSelectorFromSettings } from "./local-relevance-selection.mjs";
import { buildWorkingLlmContext } from "./working-llm-candidates.mjs";
import { createLocalContextSearchJudge, searchContextWithFollowups } from "./context-search-followups.mjs";
import { screenSensitiveMemory } from "@org-brain/shared/runtime/memory-capture-v2-runtime";
import { planEpisodicAging } from "@org-brain/shared/runtime/episodic-aging";
import { attemptSummaryJa, normalizeAttempt, normalizeAttemptConditions, normalizeAttemptMetricEvent, normalizeAttemptUse, preflightAttempt, publicAttempt, rankAttempts } from "@org-brain/shared/runtime/attempt-history-runtime";
import { localUseService, localUseFlags, configureLocalUse } from "./local-memory-use.mjs";
import { localUsageReport, normalizeUsagePurpose } from "./local-usage-report.mjs";
import {
  normalizeAgentActivity
} from "./agent-activity.mjs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { existsSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  LOCAL_EMBEDDING_PROVIDER
} from "./local-embedding.mjs";
import {
  encodeFloat32Vector,
  localDenseEmbeddingProviderFromEnvironment
} from "./local-dense-embedding.mjs";
import {
  answerGuidanceForDisposition,
  deriveEvidenceDisposition,
  evidenceAnswerTemplate,
  requiresMultipleEvidenceSources
} from "@org-brain/shared/runtime/evidence-disposition";

import {
  retrievalQueryTokens,
  retrievalSubjectQueryTokens
} from "./retrieval-units.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

export const DEFAULT_LOCAL_DB = join(homedir(), ".org-brain", "memory.sqlite");

// Hooks, MCP servers and maintenance share one file. Wait for a short writer
// instead of failing the whole hook with "database is locked".
export const DATABASE_BUSY_TIMEOUT_MS = 5_000;

const AVOIDED_LOOKUP_CATEGORIES = new Set(["source_search", "web_search", "past_context", "none"]);

function cloudTelemetryEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.ORGBRAIN_ENABLE_CLOUD_MEMORY ?? "").trim().toLowerCase()
  );
}

function confirmationTokenHash(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

const TOKEN_ESTIMATION_PRIORITY = [
  ["paired_control", "paired_control_tokens"],
  ["safe_replay", "safe_replay_tokens"],
  ["avoided_source_or_context_size", "avoided_source_tokens"],
  ["failure_pattern_historical_median", "failure_pattern_median_tokens"],
  ["business_category_calibrated_median", "category_median_tokens"],
  ["text_size_heuristic", "text_size_heuristic_tokens"]
];

function resolveLocalTokenEstimate(input) {
  if (input.gross_saved_tokens_estimate !== undefined) {
    const value = Number(input.gross_saved_tokens_estimate);
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid_token_estimate");
    return {
      gross: Math.round(value),
      method: nullableString(input.estimation_method, 128) || "reported"
    };
  }
  const candidates = input.token_estimation_candidates;
  if (candidates && typeof candidates === "object" && !Array.isArray(candidates)) {
    for (const [method, field] of TOKEN_ESTIMATION_PRIORITY) {
      const value = Number(candidates[field]);
      if (Number.isFinite(value) && value >= 0) return { gross: Math.round(value), method };
    }
  }
  throw new Error("gross_saved_tokens_estimate_required");
}

function median(values) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function verificationSampled(tenantId, usageId) {
  let hash = 2166136261;
  const input = `${tenantId}\0${usageId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < 10;
}

function normalizedIdentifier(value, field, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field}_required`);
    return null;
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
}

function normalizedQueryHash(value) {
  if (value === undefined || value === null) return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[a-f0-9]{64}$/i.test(normalized)) throw new Error("invalid_query_hash");
  return normalized.toLowerCase();
}

const JSON_COLUMNS = [
  "tags_json",
  "entities_json",
  "source_refs_json",
  "evidence_json",
  "conflicts_json",
  "permissions_json"
];

function stableDigest(rows) {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(`${row.id}\0${row.content_hash || hashContent(row.content)}\0`);
  }
  return hash.digest("hex");
}

function activityFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    schema_version: row.schema_version,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    occurred_at: new Date(Number(row.occurred_at)).toISOString(),
    sequence: Number(row.sequence),
    harness_name: row.harness_name,
    collection_method: row.collection_method,
    fidelity: row.fidelity,
    action: row.action,
    category: row.category,
    session_id: row.session_id,
    tool_call_id: row.tool_call_id,
    model: row.model,
    provider: row.provider,
    tokens: {
      input: row.input_tokens === null ? null : Number(row.input_tokens),
      output: row.output_tokens === null ? null : Number(row.output_tokens),
      cache_read: row.cache_read_tokens === null ? null : Number(row.cache_read_tokens),
      cache_write: row.cache_write_tokens === null ? null : Number(row.cache_write_tokens)
    },
    metadata: parseJsonObject(row.metadata_json, {}),
    content: null,
    source_event_hash: row.source_event_hash,
    created_at: new Date(Number(row.created_at)).toISOString()
  };
}

function activityComparable(activity) {
  return JSON.stringify({
    project_id: activity.project_id,
    harness_name: activity.harness_name,
    collection_method: activity.collection_method,
    fidelity: activity.fidelity,
    action: activity.action,
    category: activity.category,
    session_id: activity.session_id,
    tool_call_id: activity.tool_call_id,
    model: activity.model,
    provider: activity.provider,
    tokens: activity.tokens,
    metadata: activity.metadata
  });
}

// The usage history stores excerpts separately from the main memory record.
function wipeLocalUseCopies(db, tenantId, memoryId) {
  const contexts = `SELECT id FROM memory_use_contexts WHERE tenant_id=? AND source_type='memory' AND source_id=?`;
  const items = `SELECT id FROM memory_usage_items WHERE tenant_id=? AND source_type='memory' AND source_id=?`;
  // A queued create without the tenant marker has never been prepared for
  // transport. Cancel it before the revoke trigger checks for an outbox row.
  db.prepare(`DELETE FROM memory_use_outbox WHERE tenant_id=? AND id IN (${contexts}) AND status='pending'
    AND error IS NULL AND json_extract(payload_json,'$.tenant_id') IS NULL`).run(tenantId, tenantId, memoryId);
  // Fire the existing content-free revocation trigger before erasing the
  // original synchronized context and its payload.
  db.prepare(`UPDATE memory_use_contexts SET revoked_at=unixepoch()*1000
    WHERE tenant_id=? AND source_type='memory' AND source_id=? AND revoked_at IS NULL`).run(tenantId, memoryId);
  for (const [table, selector, column] of [
    ['memory_use_context_fts', contexts, 'context_id'],
    ['memory_use_evaluations', contexts, 'context_id'],
    ['memory_use_evidence', contexts, 'context_id'],
    ['memory_use_feedback', items, 'usage_item_id'],
    ['local_use_deliveries', items, 'usage_item_id'],
    ['local_use_observation_receipts', items, 'usage_item_id'],
    ['local_memory_use_assessments', items, 'usage_item_id'],
    ['local_use_proofs', items, 'usage_item_id']
  ]) {
    if (!hasTable(db, table)) continue;
    if (table === 'memory_use_context_fts') db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${selector})`).run(tenantId, memoryId);
    else db.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND ${column} IN (${selector})`).run(tenantId, tenantId, memoryId);
  }
  db.prepare(`DELETE FROM memory_use_outbox WHERE tenant_id=? AND COALESCE(json_extract(payload_json,'$.operation'),'') <> 'revoke' AND (
     id IN (${contexts}) OR json_extract(payload_json,'$.context_id') IN (${contexts})
     OR json_extract(payload_json,'$.id') IN (${contexts}) OR json_extract(payload_json,'$.usage_item_id') IN (${items})
  )`).run(tenantId, tenantId, memoryId, tenantId, memoryId, tenantId, memoryId, tenantId, memoryId);
  db.prepare(`DELETE FROM memory_use_snapshots WHERE tenant_id=? AND EXISTS(
    SELECT 1 FROM json_each(statistics_json) s WHERE json_extract(s.value,'$.source_type')='memory'
      AND json_extract(s.value,'$.source_id')=?)`).run(tenantId, memoryId);
  db.prepare(`DELETE FROM memory_use_statistics WHERE tenant_id=? AND source_type='memory' AND source_id=?`).run(tenantId, memoryId);
  db.prepare(`DELETE FROM memory_use_contexts WHERE tenant_id=? AND source_type='memory' AND source_id=?`).run(tenantId, memoryId);
  db.prepare(`DELETE FROM memory_quality_feedback WHERE tenant_id=? AND memory_id=?`).run(tenantId, memoryId);
  db.prepare(`DELETE FROM memory_integrity_relations WHERE tenant_id=? AND (from_memory_id=? OR to_memory_id=?)`).run(tenantId, memoryId, memoryId);
  if (hasTable(db, 'local_memory_retention_queue')) {
    db.prepare(`DELETE FROM local_memory_retention_queue WHERE tenant_id=? AND memory_id=?`).run(tenantId, memoryId);
  }
}

function compactErasedSearchIndexes(db, includeShared = false) {
  // FTS5 segment blobs retain deleted postings until merged, even with the
  // database's secure_delete pragma enabled.
  const tables = ['memories_fts', 'memory_retrieval_units_fts', 'memory_retrieval_units_v4_fts', 'retrieval_units_fts', 'memory_use_context_fts'];
  if (includeShared) tables.push('all_memories_fts');
  for (const table of tables) {
    if (hasTable(db, table)) db.exec(`INSERT INTO ${table}(${table}) VALUES('optimize')`);
  }
}

// Called only inside a transaction, including restore of an older backup.
function eraseLocalMemory(db, tenantId, memoryId) {
  const affectedUsageIds = db.prepare(
    "SELECT DISTINCT usage_event_id FROM memory_usage_items WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
  ).all(tenantId, memoryId).map(row => row.usage_event_id);
  wipeLocalUseCopies(db, tenantId, memoryId);
  wipeMemoryProjections(db, tenantId, memoryId);
  db.prepare(
    `DELETE FROM memory_effect_attributions WHERE tenant_id = ? AND usage_item_id IN (
       SELECT id FROM memory_usage_items
       WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?
     )`
  ).run(tenantId, tenantId, memoryId);
  db.prepare(
    "DELETE FROM memory_usage_items WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
  ).run(tenantId, memoryId);
  for (const usageId of affectedUsageIds) {
    db.prepare(
      "DELETE FROM memory_telemetry_outbox WHERE tenant_id = ? AND (aggregate_id = ? OR json_extract(payload_json, '$.usage_event_id') = ?)"
    ).run(tenantId, usageId, usageId);
    const remaining = db.prepare(
      "SELECT 1 FROM memory_usage_items WHERE tenant_id = ? AND usage_event_id = ? LIMIT 1"
    ).get(tenantId, usageId);
    if (!remaining) {
      db.prepare(
        `DELETE FROM memory_effect_attributions WHERE tenant_id = ? AND effect_event_id IN (
           SELECT id FROM memory_effect_events WHERE tenant_id = ? AND usage_event_id = ?
         )`
      ).run(tenantId, tenantId, usageId);
      db.prepare("DELETE FROM memory_effect_events WHERE tenant_id = ? AND usage_event_id = ?").run(tenantId, usageId);
      db.prepare("DELETE FROM memory_usage_events WHERE tenant_id = ? AND id = ?").run(tenantId, usageId);
    }
  }
  db.prepare(
    "DELETE FROM memory_effect_daily_metrics WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
  ).run(tenantId, memoryId);
  db.prepare(
    "DELETE FROM memory_edges WHERE tenant_id = ? AND (from_memory_id = ? OR to_memory_id = ?)"
  ).run(tenantId, memoryId, memoryId);
  db.prepare("DELETE FROM memory_versions WHERE tenant_id = ? AND memory_id = ?").run(tenantId, memoryId);
  db.prepare("DELETE FROM memories WHERE tenant_id = ? AND id = ?").run(tenantId, memoryId);
}

async function enforcePrivatePermissions(dbPath) {
  const directory = dirname(dbPath);
  const directoryExisted = existsSync(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted) await chmod(directory, 0o700);
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) await chmod(path, 0o600);
  }
}

function readMode(path) {
  return stat(path).then((info) => info.mode & 0o777);
}

function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dayBounds(day) {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error("day must be YYYY-MM-DD");
  return { start, end: start + 86_400_000 };
}

function rebuildMemoryImpactDay(db, tenantId, day) {
  const { start, end } = dayBounds(day);
  const rows = db.prepare(
    `SELECT
       ui.*, ue.project_id AS usage_project_id, ue.verification_sampled,
       ee.id AS effect_id, ee.evidence_level, ee.effect_outcome,
       ee.avoided_lookup_categories_json, ee.failure_opportunity_state,
       ee.failure_avoided,
       previous_attribution.gross_saved_tokens AS previous_gross_saved_tokens,
       ea.gross_saved_tokens AS attributed_gross_saved_tokens,
       ea.net_saved_tokens AS attributed_net_saved_tokens,
       ea.failure_saved_tokens AS attributed_failure_saved_tokens
     FROM memory_usage_items ui
     JOIN memory_usage_events ue
       ON ue.tenant_id = ui.tenant_id AND ue.id = ui.usage_event_id
     LEFT JOIN memory_effect_events ee
       ON ee.tenant_id = ui.tenant_id
      AND ee.id = (
        SELECT candidate.id
        FROM memory_effect_events candidate
        WHERE candidate.tenant_id = ui.tenant_id
          AND candidate.usage_event_id = ui.usage_event_id
          AND NOT EXISTS (
            SELECT 1 FROM memory_effect_events child
            WHERE child.tenant_id = candidate.tenant_id
              AND child.supersedes_effect_id = candidate.id
          )
        ORDER BY candidate.created_at DESC, candidate.id DESC
        LIMIT 1
      )
     LEFT JOIN memory_effect_attributions ea
       ON ea.tenant_id = ui.tenant_id
      AND ea.effect_event_id = ee.id
      AND ea.usage_item_id = ui.id
     LEFT JOIN memory_effect_events previous
       ON previous.tenant_id = ee.tenant_id
      AND previous.id = ee.supersedes_effect_id
     LEFT JOIN memory_effect_attributions previous_attribution
       ON previous_attribution.tenant_id = previous.tenant_id
      AND previous_attribution.effect_event_id = previous.id
      AND previous_attribution.usage_item_id = ui.id
     WHERE ui.tenant_id = ? AND ui.created_at >= ? AND ui.created_at < ?`
  ).all(tenantId, start, end);
  const groups = new Map();
  for (const row of rows) {
    const dimensions = [
      row.source_type,
      row.source_id,
      row.usage_project_id ?? "",
      row.business_category_id_snapshot ?? "",
      row.work_type_snapshot ?? "",
      row.quality_category_snapshot ?? ""
    ];
    const key = dimensions.join("\0");
    const metric = groups.get(key) ?? {
      source_type: row.source_type,
      source_id: row.source_id,
      project_id_snapshot: row.usage_project_id ?? null,
      business_category_id_snapshot: row.business_category_id_snapshot ?? null,
      work_type_snapshot: row.work_type_snapshot ?? null,
      quality_category_snapshot: row.quality_category_snapshot ?? null,
      reference_count: 0,
      used_count: 0,
      effect_reported_count: 0,
      positive_count: 0,
      neutral_count: 0,
      negative_count: 0,
      unknown_count: 0,
      avoided_source_search_count: 0,
      avoided_web_search_count: 0,
      avoided_past_context_count: 0,
      avoided_none_count: 0,
      gross_saved_tokens: 0,
      injected_tokens: 0,
      net_saved_tokens: 0,
      failure_opportunity_count: 0,
      failure_avoided_count: 0,
      failure_saved_tokens: 0,
      verification_sampled_count: 0,
      verified_count: 0,
      estimator_absolute_error_sum: 0
    };
    metric.reference_count += 1;
    metric.used_count += row.used_state === "used" ? 1 : 0;
    metric.verification_sampled_count += Number(row.verification_sampled ?? 0);
    if (row.effect_id && row.attributed_gross_saved_tokens !== null) {
      metric.effect_reported_count += 1;
      metric[`${row.effect_outcome}_count`] += 1;
      metric.verified_count += row.evidence_level === "verified" && Number(row.verification_sampled ?? 0) === 1 ? 1 : 0;
      const avoided = parseJson(row.avoided_lookup_categories_json);
      for (const category of avoided) {
        const field = `avoided_${category}_count`;
        if (Object.hasOwn(metric, field)) metric[field] += 1;
      }
      metric.gross_saved_tokens += Number(row.attributed_gross_saved_tokens ?? 0);
      metric.net_saved_tokens += Number(row.attributed_net_saved_tokens ?? 0);
      metric.injected_tokens += Number(row.attributed_gross_saved_tokens ?? 0) -
        Number(row.attributed_net_saved_tokens ?? 0);
      metric.failure_opportunity_count += row.failure_opportunity_state === "applicable" ? 1 : 0;
      metric.failure_avoided_count += Number(row.failure_avoided ?? 0);
      metric.failure_saved_tokens += Number(row.attributed_failure_saved_tokens ?? 0);
      if (row.evidence_level === "verified" && row.previous_gross_saved_tokens !== null) {
        metric.estimator_absolute_error_sum += Math.abs(
          Number(row.attributed_gross_saved_tokens ?? 0) -
          Number(row.previous_gross_saved_tokens ?? 0)
        );
      }
    }
    groups.set(key, metric);
  }
  db.prepare("DELETE FROM memory_effect_daily_metrics WHERE tenant_id = ? AND day = ?").run(tenantId, day);
  const insert = db.prepare(
    `INSERT INTO memory_effect_daily_metrics(
       id, day, tenant_id, source_type, source_id, project_id_snapshot,
       business_category_id_snapshot, work_type_snapshot, quality_category_snapshot,
       reference_count, used_count, effect_reported_count,
       positive_count, neutral_count, negative_count, unknown_count,
       avoided_source_search_count, avoided_web_search_count,
       avoided_past_context_count, avoided_none_count,
       gross_saved_tokens, injected_tokens, net_saved_tokens,
       failure_opportunity_count, failure_avoided_count, failure_saved_tokens,
       verification_sampled_count, verified_count, estimator_absolute_error_sum,
       created_at, updated_at
     ) VALUES(${Array.from({ length: 31 }, () => "?").join(",")})`
  );
  const now = Date.now();
  for (const [key, metric] of groups) {
    const id = createHash("sha256").update(`${day}\0${tenantId}\0${key}`).digest("hex");
    insert.run(
      id, day, tenantId, metric.source_type, metric.source_id,
      metric.project_id_snapshot, metric.business_category_id_snapshot,
      metric.work_type_snapshot, metric.quality_category_snapshot,
      metric.reference_count, metric.used_count, metric.effect_reported_count,
      metric.positive_count, metric.neutral_count, metric.negative_count, metric.unknown_count,
      metric.avoided_source_search_count, metric.avoided_web_search_count,
      metric.avoided_past_context_count, metric.avoided_none_count,
      metric.gross_saved_tokens, metric.injected_tokens, metric.net_saved_tokens,
      metric.failure_opportunity_count, metric.failure_avoided_count, metric.failure_saved_tokens,
      metric.verification_sampled_count, metric.verified_count,
      metric.estimator_absolute_error_sum, now, now
    );
  }
  return { day, row_count: groups.size };
}

function summarizeExecutionImpact(events) {
  const runs = new Map();
  for (const event of events) {
    const run = runs.get(event.external_run_id) ?? {
      eligible: false,
      assessed: false,
      failed: false,
      memoryUsed: false,
      avoidedLookup: "none"
    };
    if (event.event_type === "eligible") run.eligible = true;
    if (event.event_type === "failed") run.failed = true;
    if (event.event_type === "assessed") {
      run.assessed = true;
      run.memoryUsed = event.memory_used === 1;
      run.avoidedLookup = event.avoided_lookup ?? "none";
    }
    runs.set(event.external_run_id, run);
  }
  const values = [...runs.values()];
  const eligibleRuns = values.filter((run) => run.eligible).length;
  const assessedRuns = values.filter((run) => run.assessed).length;
  const failedRuns = values.filter((run) => run.failed).length;
  const memoryUsedRuns = values.filter((run) => run.assessed && run.memoryUsed).length;
  const avoidedRuns = values.filter((run) => run.assessed && run.memoryUsed && run.avoidedLookup !== "none").length;
  const byAvoidedLookup = { source_search: 0, web_search: 0, past_context: 0, none: 0 };
  for (const run of values.filter((item) => item.assessed)) byAvoidedLookup[run.avoidedLookup] += 1;
  const ratio = (numerator, denominator) => denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
  return {
    eligible_runs: eligibleRuns,
    assessed_runs: assessedRuns,
    failed_runs: failedRuns,
    memory_used_runs: memoryUsedRuns,
    avoided_runs: avoidedRuns,
    reporting_rate: ratio(assessedRuns + failedRuns, eligibleRuns),
    memory_usage_rate: ratio(memoryUsedRuns, assessedRuns),
    avoided_lookup_rate: ratio(avoidedRuns, memoryUsedRuns),
    by_avoided_lookup: byAvoidedLookup
  };
}

function rebuildExecutionImpactDay(db, tenantId, projectId, day) {
  const { start, end } = dayBounds(day);
  const projectKey = projectId ?? "";
  const events = db.prepare(
    `SELECT event_type, external_run_id, memory_used, avoided_lookup
     FROM memory_impact_events
     WHERE tenant_id = ? AND COALESCE(project_id, '') = ?
       AND occurred_at >= ? AND occurred_at < ?`
  ).all(tenantId, projectKey, start, end);
  const summary = summarizeExecutionImpact(events);
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_impact_daily_metrics(
       day, tenant_id, project_id, eligible_runs, assessed_runs, failed_runs,
       memory_used_runs, avoided_runs, reporting_rate, memory_usage_rate,
       avoided_lookup_rate, source_search_count, web_search_count,
       past_context_count, none_count, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(day, tenant_id, project_id) DO UPDATE SET
       eligible_runs = excluded.eligible_runs,
       assessed_runs = excluded.assessed_runs,
       failed_runs = excluded.failed_runs,
       memory_used_runs = excluded.memory_used_runs,
       avoided_runs = excluded.avoided_runs,
       reporting_rate = excluded.reporting_rate,
       memory_usage_rate = excluded.memory_usage_rate,
       avoided_lookup_rate = excluded.avoided_lookup_rate,
       source_search_count = excluded.source_search_count,
       web_search_count = excluded.web_search_count,
       past_context_count = excluded.past_context_count,
       none_count = excluded.none_count,
       updated_at = excluded.updated_at`
  ).run(
    day, tenantId, projectKey, summary.eligible_runs, summary.assessed_runs,
    summary.failed_runs, summary.memory_used_runs, summary.avoided_runs,
    summary.reporting_rate, summary.memory_usage_rate, summary.avoided_lookup_rate,
    summary.by_avoided_lookup.source_search, summary.by_avoided_lookup.web_search,
    summary.by_avoided_lookup.past_context, summary.by_avoided_lookup.none, now, now
  );
  return summary;
}

export class LocalMemoryStore {
  constructor(dbPath = DEFAULT_LOCAL_DB, options = {}) {
    this.dbPath = resolve(dbPath);
    this.memoryJudge = options.memoryJudge ?? createLocalMemoryJudge({ dbPath: this.dbPath, env: options.env ?? process.env });
    this.contextSearchJudge = options.contextSearchJudge ?? createLocalContextSearchJudge({ dbPath: this.dbPath, env: options.env ?? process.env });
    this.initialization = null;
    this.denseEmbeddingProvider = options.denseEmbeddingProvider === undefined
      ? localDenseEmbeddingProviderFromEnvironment(options.env ?? process.env, {dbPath: this.dbPath})
      : options.denseEmbeddingProvider;
    this.relevanceSelector = options.relevanceSelector === undefined
      ? localRelevanceSelectorFromSettings(options.env ?? process.env, this.dbPath)
      : options.relevanceSelector;
  }

  async init() {
    if (!this.initialization) {
      this.initialization = this.initialize().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    await this.initialization;
    return this;
  }

  async initialize() {
    await enforcePrivatePermissions(this.dbPath);
    const existed = existsSync(this.dbPath);
    if (existed) {
      const probe = new DatabaseSync(this.dbPath, { timeout: DATABASE_BUSY_TIMEOUT_MS });
      try {
        const currentVersion = Number(probe.prepare("PRAGMA user_version").get().user_version);
        const needsLegacyFtsRepair = hasLegacyFtsTriggers(probe);
        if (
          (currentVersion < MEMORY_SCHEMA_VERSION || needsLegacyFtsRepair) &&
          hasTable(probe, "memories")
        ) {
          const backupDirectory = join(dirname(this.dbPath), "backups");
          await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
          await chmod(backupDirectory, 0o700);
          const backupPath = join(
            backupDirectory,
            `pre-v${MEMORY_SCHEMA_VERSION}-${new Date().toISOString().replaceAll(":", "-")}.sqlite`
          );
          probe.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
          await chmod(backupPath, 0o600);
        }
      } finally {
        probe.close();
      }
    }
    const db = new DatabaseSync(this.dbPath, { timeout: DATABASE_BUSY_TIMEOUT_MS });
    try {
      const currentVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
      if (
        currentVersion !== MEMORY_SCHEMA_VERSION ||
        hasLegacyFtsTriggers(db) ||
        !hasTable(db, "memory_versions") ||
        !hasTable(db, "memory_quality_feedback") ||
        !hasTable(db, "memory_integrity_relations") ||
        !hasTable(db, "memories_fts") ||
        !hasTable(db, "memory_embeddings") ||
        !hasTable(db, "memory_embedding_features") ||
        !hasTable(db, "memory_embedding_feature_stats") ||
        !hasTable(db, "memory_retrieval_units") ||
        !hasTable(db, "memory_retrieval_units_fts") ||
        !hasTable(db, "memory_retrieval_unit_embeddings") ||
        !hasTable(db, "memory_retrieval_unit_features") ||
        !hasTable(db, "memory_retrieval_unit_feature_stats") ||
        !hasTable(db, "memory_retrieval_units_v4") ||
        !hasTable(db, "memory_retrieval_units_v4_fts") ||
        !hasTable(db, "memory_retrieval_unit_embeddings_v4") ||
        !hasTable(db, "memory_retrieval_unit_features_v4") ||
        !hasTable(db, "memory_retrieval_unit_feature_stats_v4") ||
        !hasTable(db, "business_categories") ||
        !hasTable(db, "organizations") ||
        !hasTable(db, "user_profiles") ||
        !hasTable(db, "groups") ||
        !hasTable(db, "group_members") ||
        !hasTable(db, "memory_impact_events") ||
        !hasTable(db, "memory_impact_daily_metrics") ||
        !hasTable(db, "memory_usage_events") ||
        !hasTable(db, "local_use_observation_receipts") ||
        !hasTable(db, "local_use_deliveries") ||
        !hasTable(db, "local_use_collection_runs") ||
        !hasTable(db, "local_memory_use_assessments") ||
        !hasTable(db, "memory_effect_events") ||
        !hasTable(db, "action_attempts") ||
        !hasTable(db, "action_hook_coverage") ||
        !hasTable(db, "action_attempt_use_events") ||
        !hasTable(db, "action_attempt_pattern_links") ||
        !hasTable(db, "action_attempt_metric_events") ||
        !hasTable(db, "local_action_retry_permits") ||
        !hasTable(db, "agent_activity_events") ||
        !hasTable(db, "local_mcp_confirmations") ||
        !hasTable(db, "retrieval_generations") ||
        !hasTable(db, "retrieval_units") ||
        !hasTable(db, "retrieval_units_fts")
      ) {
        migrateSchema(db);
      } else {
        db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
      }
    } finally {
      db.close();
    }
    await enforcePrivatePermissions(this.dbPath);
  }

  open({ readOnly = false } = {}) {
    return new DatabaseSync(this.dbPath, { readOnly, timeout: DATABASE_BUSY_TIMEOUT_MS });
  }

  async recordActivity(input) {
    await this.init();
    const normalized = normalizeAgentActivity(input);
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare(
          "SELECT * FROM agent_activity_events WHERE tenant_id = ? AND source_event_hash = ?"
        ).get(normalized.tenant_id, normalized.source_event_hash);
        if (existing) {
          if (activityComparable(activityFromRow(existing)) !== activityComparable(normalized)) {
            throw new Error("activity_source_conflict");
          }
          db.exec("COMMIT");
          return { ...activityFromRow(existing), deduplicated: true };
        }
        const sequence = normalized.sequence ?? Number(db.prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
           FROM agent_activity_events
           WHERE tenant_id = ? AND session_id IS ?`
        ).get(normalized.tenant_id, normalized.session_id).next_sequence);
        const occurredAt = new Date(normalized.occurred_at).getTime();
        const createdAt = Date.now();
        db.prepare(
          `INSERT INTO agent_activity_events(
             id, schema_version, tenant_id, project_id, occurred_at, sequence,
             harness_name, collection_method, fidelity, action, category,
             session_id, tool_call_id, model, provider, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, metadata_json, content_json,
             source_event_hash, created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`
        ).run(
          normalized.id,
          normalized.schema_version,
          normalized.tenant_id,
          normalized.project_id,
          occurredAt,
          sequence,
          normalized.harness_name,
          normalized.collection_method,
          normalized.fidelity,
          normalized.action,
          normalized.category,
          normalized.session_id,
          normalized.tool_call_id,
          normalized.model,
          normalized.provider,
          normalized.tokens.input,
          normalized.tokens.output,
          normalized.tokens.cache_read,
          normalized.tokens.cache_write,
          JSON.stringify(normalized.metadata),
          normalized.source_event_hash,
          createdAt
        );
        const saved = db.prepare("SELECT * FROM agent_activity_events WHERE id = ?").get(normalized.id);
        db.exec("COMMIT");
        return { ...activityFromRow(saved), deduplicated: false };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  async getActivity(tenantId, eventId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return activityFromRow(db.prepare(
        "SELECT * FROM agent_activity_events WHERE tenant_id = ? AND id = ?"
      ).get(tenantId, eventId));
    } finally {
      db.close();
    }
  }

  async searchActivity(filters = {}) {
    await this.init();
    const tenantId = nullableString(filters.tenant_id, 128) || "default";
    const clauses = ["tenant_id = ?"];
    const bindings = [tenantId];
    for (const [column, value, maxLength] of [
      ["project_id", filters.project_id, 128],
      ["harness_name", filters.harness_name, 64],
      ["action", filters.action, 128],
      ["category", filters.category, 64],
      ["fidelity", filters.fidelity, 32],
      ["session_id", filters.session_id, 256]
    ]) {
      if (value !== undefined && value !== null) {
        clauses.push(`${column} IS ?`);
        bindings.push(nullableString(value, maxLength));
      }
    }
    if (filters.since) {
      const since = new Date(filters.since).getTime();
      if (!Number.isFinite(since)) throw new Error("invalid_activity_since");
      clauses.push("occurred_at >= ?");
      bindings.push(since);
    }
    if (filters.until) {
      const until = new Date(filters.until).getTime();
      if (!Number.isFinite(until)) throw new Error("invalid_activity_until");
      clauses.push("occurred_at <= ?");
      bindings.push(until);
    }
    if (filters.query) {
      const query = `%${String(filters.query).replaceAll("%", "\\%").replaceAll("_", "\\_").slice(0, 200)}%`;
      clauses.push("(action LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR harness_name LIKE ? ESCAPE '\\' OR json_extract(metadata_json, '$.tool_name') LIKE ? ESCAPE '\\')");
      bindings.push(query, query, query, query);
    }
    const limit = Math.max(1, Math.min(500, Number(filters.limit ?? 100) || 100));
    const db = this.open({ readOnly: true });
    try {
      return db.prepare(
        `SELECT * FROM agent_activity_events WHERE ${clauses.join(" AND ")}
         ORDER BY occurred_at DESC, sequence DESC, id DESC LIMIT ?`
      ).all(...bindings, limit).map(activityFromRow);
    } finally {
      db.close();
    }
  }

  async summarizeActivity(filters = {}) {
    const events = await this.searchActivity({ ...filters, limit: filters.limit ?? 500 });
    const countBy = (field) => Object.fromEntries(
      [...events.reduce((counts, event) => counts.set(event[field], (counts.get(event[field]) ?? 0) + 1), new Map())]
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
    );
    const tokens = events.reduce((totals, event) => ({
      input: totals.input + (event.tokens.input ?? 0),
      output: totals.output + (event.tokens.output ?? 0),
      cache_read: totals.cache_read + (event.tokens.cache_read ?? 0),
      cache_write: totals.cache_write + (event.tokens.cache_write ?? 0)
    }), { input: 0, output: 0, cache_read: 0, cache_write: 0 });
    const durations = events
      .map((event) => event.metadata.duration_ms)
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
    const memoryStages = Object.fromEntries(
      [...events.reduce((counts, event) => {
        const stage = event.metadata.memory_stage;
        if (stage) counts.set(stage, (counts.get(stage) ?? 0) + 1);
        return counts;
      }, new Map())].sort(([left], [right]) => left.localeCompare(right))
    );
    return {
      total: events.length,
      observable: events.filter((event) => event.fidelity === "observed").length,
      inferred: events.filter((event) => event.fidelity === "inferred").length,
      coverage: {
        observable: events.filter((event) => event.fidelity === "observed" && event.metadata.coverage !== "opaque").length,
        opaque: events.filter((event) => event.metadata.coverage === "opaque").length,
        missing: null,
        missing_reason: "expected_event_denominator_required"
      },
      by_action: countBy("action"),
      by_category: countBy("category"),
      by_fidelity: countBy("fidelity"),
      by_harness: countBy("harness_name"),
      by_memory_stage: memoryStages,
      tokens,
      duration_ms: {
        samples: durations.length,
        average: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
        p95: durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null
      },
      range: {
        newest: events[0]?.occurred_at ?? null,
        oldest: events.at(-1)?.occurred_at ?? null
      }
    };
  }

  async startMemoryImpact(tenantId, input, principal = "local") {
    await this.init();
    const externalRunId = nullableString(input.external_run_id, 256);
    const idempotencyKey = nullableString(input.idempotency_key, 256);
    if (!externalRunId) throw new Error("external_run_id_required");
    if (!idempotencyKey) throw new Error("idempotency_key_required");
    return this.insertExecutionImpactEvent({
      tenantId,
      projectId: nullableString(input.project_id, 256),
      taskId: nullableString(input.task_id, 256),
      traceId: nullableString(input.trace_id, 256),
      externalRunId,
      eventType: "eligible",
      principal,
      agentName: nullableString(input.agent_name, 256),
      model: nullableString(input.model, 256),
      idempotencyKey,
      occurredAt: finiteNumber(input.occurred_at) ?? Date.now()
    });
  }

  async reportMemoryImpactExecution(tenantId, externalRunIdInput, input, principal = "local") {
    await this.init();
    const externalRunId = nullableString(externalRunIdInput, 256);
    const idempotencyKey = nullableString(input.idempotency_key, 256);
    if (!externalRunId) throw new Error("external_run_id_required");
    if (!idempotencyKey) throw new Error("idempotency_key_required");
    const outcome = input.outcome === "failed" ? "failed" : "assessed";
    const db = this.open({ readOnly: true });
    let eligible;
    try {
      eligible = db.prepare(
        `SELECT * FROM memory_impact_events
         WHERE tenant_id = ? AND external_run_id = ? AND event_type = 'eligible'`
      ).get(tenantId, externalRunId);
    } finally {
      db.close();
    }
    if (!eligible) {
      await this.startMemoryImpact(tenantId, {
        external_run_id: externalRunId,
        idempotency_key: `${idempotencyKey}:auto-start`,
        occurred_at: input.occurred_at
      }, principal);
      const reopened = this.open({ readOnly: true });
      try {
        eligible = reopened.prepare(
          `SELECT * FROM memory_impact_events
           WHERE tenant_id = ? AND external_run_id = ? AND event_type = 'eligible'`
        ).get(tenantId, externalRunId);
      } finally {
        reopened.close();
      }
    }
    if (outcome === "failed") {
      const failureCategory = ["agent_error", "tool_error", "cancelled", "unknown"].includes(input.failure_category)
        ? input.failure_category
        : "unknown";
      return this.insertExecutionImpactEvent({
        tenantId,
        projectId: eligible?.project_id ?? null,
        taskId: eligible?.task_id ?? null,
        traceId: eligible?.trace_id ?? null,
        externalRunId,
        eventType: "failed",
        failureCategory,
        principal,
        agentName: eligible?.agent_name ?? null,
        model: eligible?.model ?? null,
        idempotencyKey,
        occurredAt: finiteNumber(input.occurred_at) ?? Date.now()
      });
    }
    if (typeof input.memory_used !== "boolean") throw new Error("memory_used_required");
    const avoidedLookup = input.avoided_lookup;
    if (!["source_search", "web_search", "past_context", "none"].includes(avoidedLookup)) {
      throw new Error("invalid_avoided_lookup");
    }
    const memoryBasisIds = Array.isArray(input.memory_basis_ids)
      ? [...new Set(input.memory_basis_ids.map((id) => nullableString(id, 256)).filter(Boolean))]
      : [];
    const confidence = input.confidence == null ? null : input.confidence;
    if (!input.memory_used && (avoidedLookup !== "none" || memoryBasisIds.length > 0 || confidence !== null)) {
      throw new Error("invalid_unused_memory_impact");
    }
    if (input.memory_used && (memoryBasisIds.length === 0 || !["low", "medium", "high"].includes(confidence))) {
      throw new Error("memory_basis_and_confidence_required");
    }
    if (memoryBasisIds.length > 20) throw new Error("too_many_memory_basis_ids");
    if (memoryBasisIds.length > 0) {
      const basisDb = this.open({ readOnly: true });
      try {
        const placeholders = memoryBasisIds.map(() => "?").join(",");
        const rows = basisDb.prepare(
          `SELECT id FROM memories WHERE tenant_id = ? AND id IN (${placeholders})`
        ).all(tenantId, ...memoryBasisIds);
        if (new Set(rows.map((row) => row.id)).size !== memoryBasisIds.length) {
          throw new Error("invalid_memory_basis");
        }
      } finally {
        basisDb.close();
      }
    }
    return this.insertExecutionImpactEvent({
      tenantId,
      projectId: eligible?.project_id ?? null,
      taskId: eligible?.task_id ?? null,
      traceId: eligible?.trace_id ?? null,
      externalRunId,
      eventType: "assessed",
      memoryUsed: input.memory_used,
      avoidedLookup,
      memoryBasisIds,
      confidence,
      principal,
      agentName: eligible?.agent_name ?? null,
      model: eligible?.model ?? null,
      idempotencyKey,
      occurredAt: finiteNumber(input.occurred_at) ?? Date.now()
    });
  }

  async insertExecutionImpactEvent(input) {
    const hashable = { ...input };
    delete hashable.occurredAt;
    const payloadHash = hashContent(JSON.stringify(hashable));
    const db = this.open();
    try {
      const existing = db.prepare(
        `SELECT * FROM memory_impact_events
         WHERE tenant_id = ? AND reporter_principal = ? AND idempotency_key = ?`
      ).get(input.tenantId, input.principal, input.idempotencyKey);
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new Error("idempotency_conflict");
        return { event: existing, deduped: true };
      }
      const sameType = db.prepare(
        `SELECT id FROM memory_impact_events
         WHERE tenant_id = ? AND external_run_id = ? AND event_type = ?`
      ).get(input.tenantId, input.externalRunId, input.eventType);
      if (sameType) throw new Error("event_conflict");
      if (input.eventType !== "eligible") {
        const terminal = db.prepare(
          `SELECT id FROM memory_impact_events
           WHERE tenant_id = ? AND external_run_id = ? AND event_type IN ('assessed', 'failed')`
        ).get(input.tenantId, input.externalRunId);
        if (terminal) throw new Error("event_conflict");
      }
      const now = Date.now();
      const id = randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO memory_impact_events(
             id, tenant_id, project_id, task_id, trace_id, external_run_id, event_type,
             memory_used, avoided_lookup, memory_basis_ids_json, confidence, failure_category,
             reporter_principal, agent_name, model, idempotency_key, payload_hash,
             occurred_at, created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          id, input.tenantId, input.projectId ?? null, input.taskId ?? null,
          input.traceId ?? null, input.externalRunId, input.eventType,
          input.memoryUsed == null ? null : input.memoryUsed ? 1 : 0,
          input.avoidedLookup ?? null, JSON.stringify(input.memoryBasisIds ?? []),
          input.confidence ?? null, input.failureCategory ?? null, input.principal,
          input.agentName ?? null, input.model ?? null, input.idempotencyKey,
          payloadHash, input.occurredAt, now
        );
        rebuildExecutionImpactDay(db, input.tenantId, input.projectId ?? null, utcDay(input.occurredAt));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const event = db.prepare("SELECT * FROM memory_impact_events WHERE id = ?").get(id);
      return { event, deduped: false };
    } finally {
      db.close();
    }
  }

  async getMemoryImpactExecution(tenantId, externalRunId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const events = db.prepare(
        `SELECT * FROM memory_impact_events
         WHERE tenant_id = ? AND external_run_id = ? ORDER BY created_at, id`
      ).all(tenantId, externalRunId);
      if (events.length === 0) throw new Error("impact_run_not_found");
      return { external_run_id: externalRunId, events };
    } finally {
      db.close();
    }
  }

  async memoryImpactSummary(tenantId, filters = {}) {
    await this.init();
    const from = finiteNumber(filters.from) ?? Date.now() - 30 * 86_400_000;
    const to = finiteNumber(filters.to) ?? Date.now();
    if (from > to) throw new Error("invalid_range");
    const projectId = nullableString(filters.project_id, 256);
    const db = this.open({ readOnly: true });
    try {
      const events = projectId
        ? db.prepare(
          `SELECT event_type, external_run_id, memory_used, avoided_lookup
           FROM memory_impact_events
           WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at <= ? AND project_id = ?`
        ).all(tenantId, from, to, projectId)
        : db.prepare(
          `SELECT event_type, external_run_id, memory_used, avoided_lookup
           FROM memory_impact_events
           WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at <= ?`
        ).all(tenantId, from, to);
      return summarizeExecutionImpact(events);
    } finally {
      db.close();
    }
  }

  async getProfile(tenantId, principal = "user:local") {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare(
        `SELECT tenant_id, principal, display_name, full_name, email, email_verified,
                avatar_url, status, provision_source, full_name_source, created_at, updated_at
         FROM user_profiles WHERE tenant_id = ? AND principal = ?`
      ).get(tenantId, principal) ?? null;
    } finally {
      db.close();
    }
  }

  async updateProfile(tenantId, principal, input) {
    await this.init();
    const current = await this.getProfile(tenantId, principal);
    const displayName = nullableString(input.display_name, 120) ?? current?.display_name;
    if (!displayName) throw new Error("display_name_required");
    const fullName = input.full_name === undefined ? current?.full_name ?? null : nullableString(input.full_name, 200);
    const email = input.email === undefined ? current?.email ?? null : nullableString(input.email, 254)?.toLowerCase() ?? null;
    const avatarUrl = input.avatar_url === undefined ? current?.avatar_url ?? null : nullableString(input.avatar_url, 2048);
    const now = Date.now();
    const db = this.open();
    try {
      db.prepare(
        `INSERT INTO user_profiles(tenant_id, principal, display_name, full_name, email,
          email_verified, avatar_url, status, provision_source, full_name_source, created_at, updated_at)
         VALUES(?,?,?,?,?,0,?,'active','legacy','legacy',?,?)
         ON CONFLICT(tenant_id, principal) DO UPDATE SET
           display_name=excluded.display_name, full_name=excluded.full_name, email=excluded.email,
           avatar_url=excluded.avatar_url, updated_at=excluded.updated_at`
      ).run(tenantId, principal, displayName, fullName, email, avatarUrl, current?.created_at ?? now, now);
    } finally {
      db.close();
    }
    return this.getProfile(tenantId, principal);
  }

  async getOrganization(tenantId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const row = db.prepare("SELECT * FROM organizations WHERE tenant_id = ?").get(tenantId);
      return row ? {
        ...row,
        allowed_email_domains: JSON.parse(row.allowed_email_domains_json),
        email_self_registration_enabled: Boolean(row.email_self_registration_enabled)
      } : {
        tenant_id: tenantId,
        slug: tenantId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "default",
        display_name: tenantId,
        allowed_email_domains: [],
        email_self_registration_enabled: false,
        configured: false
      };
    } finally {
      db.close();
    }
  }

  async updateOrganization(tenantId, input) {
    await this.init();
    const current = await this.getOrganization(tenantId);
    const slug = (nullableString(input.slug, 80) ?? current.slug).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(slug)) throw new Error("invalid_organization_slug");
    const displayName = nullableString(input.display_name, 160) ?? current.display_name;
    const domains = input.allowed_email_domains === undefined
      ? current.allowed_email_domains
      : [...new Set(input.allowed_email_domains.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
    const selfRegistration = input.email_self_registration_enabled === undefined
      ? current.email_self_registration_enabled
      : Boolean(input.email_self_registration_enabled);
    const now = Date.now();
    const db = this.open();
    try {
      db.prepare(
        `INSERT INTO organizations(tenant_id, slug, display_name, allowed_email_domains_json,
          email_self_registration_enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id) DO UPDATE SET slug=excluded.slug, display_name=excluded.display_name,
          allowed_email_domains_json=excluded.allowed_email_domains_json,
          email_self_registration_enabled=excluded.email_self_registration_enabled, updated_at=excluded.updated_at`
      ).run(tenantId, slug, displayName, JSON.stringify(domains), selfRegistration ? 1 : 0, current.created_at ?? now, now);
    } finally {
      db.close();
    }
    return this.getOrganization(tenantId);
  }

  async listUsers(tenantId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare(
        `SELECT tenant_id, principal, display_name, full_name, email, email_verified,
                avatar_url, status, provision_source, full_name_source, created_at, updated_at
         FROM user_profiles WHERE tenant_id = ? ORDER BY status, display_name, principal`
      ).all(tenantId);
    } finally {
      db.close();
    }
  }

  async createUser(tenantId, input, actorPrincipal = "user:local") {
    const email = nullableString(input.email, 254)?.toLowerCase() ?? null;
    const displayName = nullableString(input.display_name, 120);
    if (!displayName) throw new Error("display_name_required");
    const role = ["reader", "contributor", "tenant_admin", "auditor"].includes(input.role) ? input.role : "reader";
    const principal = nullableString(input.principal, 128) ?? `user:${randomUUID()}`;
    const now = Date.now();
    await this.init();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO user_profiles(tenant_id, principal, display_name, full_name, email,
          email_verified, avatar_url, status, provision_source, full_name_source, created_at, updated_at)
         VALUES(?,?,?,?,?,0,NULL,'invited','email','email',?,?)`
      ).run(tenantId, principal, displayName, nullableString(input.full_name, 200), email, now, now);
      db.prepare(
        `INSERT INTO principal_role_assignments(id, tenant_id, project_id, principal, role,
          source, source_ref, created_by_principal, created_at, updated_at)
         VALUES(?,?,NULL,?,?,'local',NULL,?,?,?)`
      ).run(randomUUID(), tenantId, principal, role, actorPrincipal, now, now);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      db.close();
    }
    return this.getProfile(tenantId, principal);
  }

  async updateUser(tenantId, principal, input) {
    await this.init();
    const allowedStatuses = new Set(["invited", "active", "suspended", "deprovisioned"]);
    const current = await this.getProfile(tenantId, principal);
    if (!current) throw new Error("user_not_found");
    const status = input.status === undefined ? current.status : String(input.status);
    if (!allowedStatuses.has(status)) throw new Error("invalid_user_status");
    const db = this.open();
    try {
      db.prepare(
        `UPDATE user_profiles SET display_name=?, full_name=?, status=?, updated_at=?
         WHERE tenant_id=? AND principal=?`
      ).run(
        nullableString(input.display_name, 120) ?? current.display_name,
        input.full_name === undefined ? current.full_name : nullableString(input.full_name, 200),
        status,
        Date.now(),
        tenantId,
        principal
      );
    } finally {
      db.close();
    }
    return this.getProfile(tenantId, principal);
  }

  async listGroups(tenantId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare("SELECT * FROM groups WHERE tenant_id=? AND deleted_at IS NULL ORDER BY name").all(tenantId);
    } finally {
      db.close();
    }
  }

  async createGroup(tenantId, input, actorPrincipal = "user:local") {
    await this.init();
    const name = nullableString(input.name, 120);
    if (!name) throw new Error("group_name_required");
    const slug = (nullableString(input.slug, 80) ?? name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")).replace(/^-+|-+$/g, "");
    if (!slug) throw new Error("invalid_group_slug");
    const now = Date.now();
    const id = randomUUID();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO groups(id, tenant_id, slug, name, description, source, external_id,
          created_by_principal, created_at, updated_at, deleted_at)
         VALUES(?,?,?,?,?,'local',NULL,?,?,?,NULL)`
      ).run(id, tenantId, slug, name, nullableString(input.description, 500), actorPrincipal, now, now);
      db.prepare(
        `INSERT INTO group_members(tenant_id, group_id, principal, role, source, created_at, updated_at)
         VALUES(?,?,?,'owner','local',?,?)`
      ).run(tenantId, id, actorPrincipal, now, now);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      db.close();
    }
    return { id, tenant_id: tenantId, slug, name, source: "local" };
  }

  async addGroupMember(tenantId, groupId, principal, role = "member") {
    await this.init();
    if (!["owner", "admin", "member"].includes(role)) throw new Error("invalid_group_role");
    const now = Date.now();
    const db = this.open();
    try {
      const group = db.prepare("SELECT source FROM groups WHERE tenant_id=? AND id=? AND deleted_at IS NULL").get(tenantId, groupId);
      if (!group) throw new Error("group_not_found");
      if (group.source === "scim") throw new Error("scim_managed");
      db.prepare(
        `INSERT INTO group_members(tenant_id, group_id, principal, role, source, created_at, updated_at)
         VALUES(?,?,?,?,'local',?,?) ON CONFLICT(tenant_id, group_id, principal)
         DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at`
      ).run(tenantId, groupId, principal, role, now, now);
      return db.prepare("SELECT * FROM group_members WHERE tenant_id=? AND group_id=? ORDER BY role, principal").all(tenantId, groupId);
    } finally {
      db.close();
    }
  }

  async archiveGroup(tenantId, groupId) {
    await this.init();
    const db = this.open();
    try {
      const result = db.prepare(
        "UPDATE groups SET deleted_at=?, updated_at=? WHERE tenant_id=? AND id=? AND source='local' AND deleted_at IS NULL"
      ).run(Date.now(), Date.now(), tenantId, groupId);
      if (!result.changes) throw new Error("group_not_found_or_scim_managed");
      return { archived: true, group_id: groupId };
    } finally {
      db.close();
    }
  }

  async listBusinessCategories(tenantId, { includeInactive = false } = {}) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare(
        `SELECT id, tenant_id, slug, label, description, is_active, created_at, updated_at
         FROM business_categories
         WHERE tenant_id = ? AND (? = 1 OR is_active = 1)
         ORDER BY label, slug`
      ).all(tenantId, includeInactive ? 1 : 0);
    } finally {
      db.close();
    }
  }

  async createBusinessCategory(tenantId, input) {
    await this.init();
    const slug = nullableString(input.slug, 64)?.toLowerCase();
    const label = nullableString(input.label, 160);
    if (!slug || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error("invalid_business_category_slug");
    if (!label) throw new Error("business_category_label_required");
    const now = Date.now();
    const category = {
      id: nullableString(input.id, 128) || randomUUID(),
      tenant_id: tenantId,
      slug,
      label,
      description: nullableString(input.description, 1000),
      is_active: input.is_active === false ? 0 : 1,
      created_at: now,
      updated_at: now
    };
    const db = this.open();
    try {
      db.prepare(
        `INSERT INTO business_categories(
           id, tenant_id, slug, label, description, is_active, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?)`
      ).run(...Object.values(category));
      return category;
    } finally {
      db.close();
    }
  }

  async updateBusinessCategory(tenantId, categoryId, input) {
    await this.init();
    const db = this.open();
    try {
      const current = db.prepare(
        "SELECT * FROM business_categories WHERE tenant_id = ? AND id = ?"
      ).get(tenantId, categoryId);
      if (!current) throw new Error("business_category_not_found");
      const slug = input.slug === undefined ? current.slug : nullableString(input.slug, 64)?.toLowerCase();
      const label = input.label === undefined ? current.label : nullableString(input.label, 160);
      if (!slug || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error("invalid_business_category_slug");
      if (!label) throw new Error("business_category_label_required");
      const updated = {
        ...current,
        slug,
        label,
        description: input.description === undefined ? current.description : nullableString(input.description, 1000),
        is_active: input.is_active === undefined ? current.is_active : input.is_active ? 1 : 0,
        updated_at: Date.now()
      };
      db.prepare(
        `UPDATE business_categories
         SET slug = ?, label = ?, description = ?, is_active = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).run(updated.slug, updated.label, updated.description, updated.is_active, updated.updated_at, tenantId, categoryId);
      return updated;
    } finally {
      db.close();
    }
  }

  async recordAttempt(tenantId, input, { principal = null, trusted = false } = {}) {
    await this.init();
    const row = normalizeAttempt(input, { tenantId, principal, trusted });
    const db = this.open();
    let inTransaction = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      const previous = db.prepare("SELECT * FROM action_attempts WHERE tenant_id=? AND source_key=?")
        .get(tenantId, row.source_key);
      if (previous) {
        const comparable = Object.keys(row).filter((key) => key !== "created_at");
        if (comparable.some((key) => previous[key] !== row[key])) throw new Error("attempt_source_key_conflict");
        db.exec("COMMIT");
        inTransaction = false;
        return { ...publicAttempt(previous), deduplicated: true };
      }
      if (row.supersedes_id) {
        const prior = db.prepare("SELECT id,project_id FROM action_attempts WHERE tenant_id=? AND id=?")
          .get(tenantId, row.supersedes_id);
        if (!prior || prior.project_id !== row.project_id) throw new Error("superseded_attempt_not_found");
        const replacement = db.prepare("SELECT id FROM action_attempts WHERE tenant_id=? AND supersedes_id=?")
          .get(tenantId, row.supersedes_id);
        if (replacement) throw new Error("attempt_already_superseded");
      }
      const fields = Object.keys(row);
      db.prepare(`INSERT INTO action_attempts(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`)
        .run(...Object.values(row));
      if (row.verification_state === "verified" && row.attempt_type === "intervention"
          && row.outcome === "failure" && row.failure_kind === "deterministic" && row.conditions_hash) {
        const patternKey = `attempt:${hashContent(`${row.project_id}\0${row.action_key}\0${row.conditions_hash}`).slice(0, 48)}`;
        db.prepare(`INSERT OR IGNORE INTO memory_failure_patterns(
          id,tenant_id,project_id,business_category_id,work_type,pattern_key,label,
          action_fingerprint,failure_fingerprint,is_active,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          randomUUID(), tenantId, row.project_id, null, null, patternKey, row.action_label,
          hashContent(row.action_key), hashContent(row.result_summary), 1, row.created_at, row.created_at
        );
        const pattern = db.prepare("SELECT id FROM memory_failure_patterns WHERE tenant_id=? AND pattern_key=?")
          .get(tenantId, patternKey);
        db.prepare("INSERT INTO action_attempt_pattern_links(tenant_id,attempt_id,pattern_id) VALUES(?,?,?)")
          .run(tenantId, row.id, pattern.id);
        const laterSuccess = db.prepare(`SELECT 1 FROM action_attempts a
          WHERE a.tenant_id=? AND a.project_id=? AND a.action_key=? AND a.conditions_hash=?
            AND a.verification_state='verified' AND a.outcome='success' AND a.performed_at>=?
            AND NOT EXISTS (SELECT 1 FROM action_attempts next WHERE next.tenant_id=a.tenant_id AND next.supersedes_id=a.id)
          LIMIT 1`).get(tenantId, row.project_id, row.action_key, row.conditions_hash, row.performed_at);
        db.prepare("UPDATE memory_failure_patterns SET is_active=?,updated_at=? WHERE tenant_id=? AND id=?")
          .run(laterSuccess ? 0 : 1, row.created_at, tenantId, pattern.id);
      }
      if (row.verification_state === "verified" && row.outcome === "success" && row.conditions_hash) {
        const patternKey = `attempt:${hashContent(`${row.project_id}\0${row.action_key}\0${row.conditions_hash}`).slice(0, 48)}`;
        const laterFailure = db.prepare(`SELECT 1 FROM action_attempts a
          WHERE a.tenant_id=? AND a.project_id=? AND a.action_key=? AND a.conditions_hash=?
            AND a.verification_state='verified' AND a.attempt_type='intervention'
            AND a.outcome='failure' AND a.failure_kind='deterministic' AND a.performed_at>?
            AND NOT EXISTS (SELECT 1 FROM action_attempts next WHERE next.tenant_id=a.tenant_id AND next.supersedes_id=a.id)
          LIMIT 1`).get(tenantId, row.project_id, row.action_key, row.conditions_hash, row.performed_at);
        if (!laterFailure) db.prepare("UPDATE memory_failure_patterns SET is_active=0,updated_at=? WHERE tenant_id=? AND pattern_key=?")
          .run(row.created_at, tenantId, patternKey);
      }
      if (row.supersedes_id) {
        const links = db.prepare("SELECT pattern_id FROM action_attempt_pattern_links WHERE tenant_id=? AND attempt_id=?")
          .all(tenantId, row.supersedes_id);
        for (const link of links) {
          const unresolved = db.prepare(`SELECT COUNT(*) AS count FROM action_attempt_pattern_links l
            JOIN action_attempts a ON a.tenant_id=l.tenant_id AND a.id=l.attempt_id
            WHERE l.tenant_id=? AND l.pattern_id=? AND a.outcome='failure'
              AND NOT EXISTS (SELECT 1 FROM action_attempts next WHERE next.tenant_id=a.tenant_id AND next.supersedes_id=a.id)`)
            .get(tenantId, link.pattern_id);
          if (unresolved.count === 0) db.prepare("UPDATE memory_failure_patterns SET is_active=0,updated_at=? WHERE tenant_id=? AND id=?")
            .run(row.created_at, tenantId, link.pattern_id);
        }
      }
      db.exec("COMMIT");
      inTransaction = false;
      return publicAttempt(row);
    } catch (error) {
      if (inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }

  async recordAttemptUse(tenantId, input, { trusted = false } = {}) {
    await this.init();
    const row = normalizeAttemptUse(input, { tenantId, trusted });
    const db = this.open();
    try {
      const attempt = db.prepare("SELECT id FROM action_attempts WHERE tenant_id=? AND project_id=? AND id=?")
        .get(tenantId, row.project_id, row.attempt_id);
      if (!attempt) throw new Error("attempt_not_found");
      const existing = db.prepare("SELECT * FROM action_attempt_use_events WHERE tenant_id=? AND id=?")
        .get(tenantId, row.id);
      if (existing) {
        if (Object.keys(row).some((key) => key !== "created_at" && existing[key] !== row[key])) throw new Error("attempt_use_id_conflict");
        return { ...existing, evidence: JSON.parse(existing.evidence_json), deduplicated: true };
      }
      const fields = Object.keys(row);
      db.prepare(`INSERT INTO action_attempt_use_events(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`)
        .run(...Object.values(row));
      return { ...row, evidence: JSON.parse(row.evidence_json) };
    } finally { db.close(); }
  }

  async attemptUseReport(tenantId, projectId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare("SELECT stage,verification_state,COUNT(*) AS count FROM action_attempt_use_events WHERE tenant_id=? AND project_id=? GROUP BY stage,verification_state ORDER BY stage,verification_state")
        .all(tenantId, normalizedIdentifier(projectId, "project_id", true));
    } finally { db.close(); }
  }

  async recordAttemptMetricEvent(tenantId, input, { trusted = false } = {}) {
    await this.init();
    const row = normalizeAttemptMetricEvent(input, { tenantId, trusted });
    const db = this.open();
    try {
      if (row.kind === "feedback") {
        const prior = db.prepare(`SELECT id,decision FROM action_attempt_metric_events
          WHERE tenant_id=? AND project_id=? AND id=? AND kind='preflight'`)
          .get(tenantId, row.project_id, row.related_event_id);
        if (!prior || prior.decision !== "block") throw new Error("blocked_preflight_event_not_found");
      }
      const previous = db.prepare("SELECT * FROM action_attempt_metric_events WHERE tenant_id=? AND id=?")
        .get(tenantId, row.id);
      if (previous) {
        if (Object.keys(row).some((key) => key !== "created_at" && previous[key] !== row[key])) throw new Error("attempt_metric_id_conflict");
        return { ...previous, evidence: JSON.parse(previous.evidence_json), deduplicated: true };
      }
      const fields = Object.keys(row);
      db.prepare(`INSERT INTO action_attempt_metric_events(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`)
        .run(...Object.values(row));
      return { ...row, evidence: JSON.parse(row.evidence_json) };
    } finally { db.close(); }
  }

  async actionAttemptMetricsReport(tenantId, projectId) {
    await this.init();
    const project = normalizedIdentifier(projectId, "project_id", true);
    const db = this.open({ readOnly: true });
    try {
      const eventCounts = db.prepare(`SELECT
        SUM(kind='context_query') AS context_queries,
        SUM(kind='context_query' AND returned_count>0) AS context_queries_with_history,
        SUM(kind='preflight') AS preflight_checks,
        SUM(kind='preflight' AND decision='block') AS preflight_blocks,
        SUM(kind='feedback' AND feedback_verdict='false_block' AND verification_state='reported') AS false_blocks_reported,
        SUM(kind='feedback' AND feedback_verdict='false_block' AND verification_state='verified') AS false_blocks_verified
        FROM action_attempt_metric_events WHERE tenant_id=? AND project_id=?`).get(tenantId, project);
      const coverage = db.prepare(`SELECT coverage,SUM(count) AS count FROM action_hook_coverage
        WHERE tenant_id=? AND project_id=? GROUP BY coverage`).all(tenantId, project);
      const usage = db.prepare(`SELECT stage,verification_state,COUNT(*) AS count FROM action_attempt_use_events
        WHERE tenant_id=? AND project_id=? GROUP BY stage,verification_state`).all(tenantId, project);
      const repeated = db.prepare(`SELECT COUNT(*) AS count FROM action_attempts a
        WHERE a.tenant_id=? AND a.project_id=? AND a.attempt_type='intervention'
          AND a.conditions_hash IS NOT NULL AND EXISTS (
            SELECT 1 FROM action_attempts prior WHERE prior.tenant_id=a.tenant_id AND prior.project_id=a.project_id
              AND prior.action_key=a.action_key AND prior.conditions_hash=a.conditions_hash
              AND prior.verification_state='verified' AND prior.attempt_type='intervention'
              AND prior.outcome='failure' AND prior.failure_kind='deterministic'
              AND prior.performed_at<a.performed_at
              AND NOT EXISTS (SELECT 1 FROM action_attempts correction
                WHERE correction.tenant_id=prior.tenant_id AND correction.supersedes_id=prior.id)
          )`).get(tenantId, project);
      const counts = Object.fromEntries(Object.entries(eventCounts).map(([key, value]) => [key, Number(value ?? 0)]));
      const coverageCounts = Object.fromEntries(coverage.map((row) => [row.coverage, Number(row.count)]));
      const checked = Number(coverageCounts.checked ?? 0) + Number(coverageCounts.blocked ?? 0);
      const opaque = Number(coverageCounts.opaque ?? 0);
      const returned = usage.filter((row) => row.stage === "returned")
        .reduce((sum, row) => sum + Number(row.count), 0);
      const verifiedAdoptions = usage.filter((row) => row.stage === "adopted" && row.verification_state === "verified")
        .reduce((sum, row) => sum + Number(row.count), 0);
      return { project_id: project, ...counts, confirmed_same_condition_reexecutions: Number(repeated.count),
        history_return_rate: counts.context_queries ? counts.context_queries_with_history / counts.context_queries : null,
        verified_adoption_rate: returned ? verifiedAdoptions / returned : null,
        opaque_operation_rate: checked + opaque ? opaque / (checked + opaque) : null,
        coverage: coverageCounts, usage };
    } finally { db.close(); }
  }

  async searchAttempts(tenantId, { project_id, action_key = null, query = null, limit = 20 } = {}) {
    await this.init();
    const projectId = normalizedIdentifier(project_id, "project_id", true);
    const actionKey = normalizedIdentifier(action_key, "action_key");
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const db = this.open({ readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT a.* FROM action_attempts a
         WHERE a.tenant_id=? AND a.project_id=?
           AND (? IS NULL OR a.action_key=?)
           AND NOT EXISTS (SELECT 1 FROM action_attempts next
                           WHERE next.tenant_id=a.tenant_id AND next.supersedes_id=a.id)
         ORDER BY a.performed_at DESC,a.id DESC LIMIT 500`
      ).all(tenantId, projectId, actionKey, actionKey);
      const ranked = rankAttempts(rows, query, safeLimit);
      for (const attempt of ranked) {
        if (attempt.verification_state !== "verified" || attempt.executed_by_type !== "principal" || !attempt.executed_by) continue;
        const profile = db.prepare("SELECT display_name FROM user_profiles WHERE tenant_id=? AND principal=? AND status='active'")
          .get(tenantId, attempt.executed_by);
        if (profile?.display_name) attempt.executed_by_name = profile.display_name;
      }
      for (const attempt of ranked) attempt.summary_ja = attemptSummaryJa(attempt);
      return ranked;
    } finally {
      db.close();
    }
  }

  async preflightAction(tenantId, input, { source = "mcp", consumeRetry = true, command = null } = {}) {
    const projectId = normalizedIdentifier(input.project_id, "project_id", true);
    const actionKey = normalizedIdentifier(input.action_key, "action_key", true);
    const condition = normalizeAttemptConditions(input.conditions);
    const attempts = await this.searchAttempts(tenantId, { project_id: projectId, action_key: actionKey, limit: 100 });
    const hypothesis = nullableString(input.change_hypothesis, 500);
    if (hypothesis && (!screenSensitiveMemory(hypothesis).allowed || /[\r\n]|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/iu.test(hypothesis))) throw new Error('sensitive_retry_reason');
    const taskId = nullableString(input.task_id, 256);
    if (input.retry_once === true && !hypothesis) throw new Error('retry_reason_required');
    if (input.retry_once === true && !taskId) throw new Error('retry_task_required');
    let decision = preflightAttempt(attempts, { action_key: actionKey, conditions_hash: condition.conditions_hash, change_hypothesis: hypothesis, command: source === 'hook' ? command : null });
    let retryPermit;
    if ((source === 'hook' && consumeRetry && decision.reason === 'failed_action_requires_review' && taskId)
        || (source === 'mcp' && input.retry_once === true && decision.reason === 'reviewed_failure_retry')) {
      const retryDb = this.open(), now = Date.now(), attemptId = decision.prior_attempts[0].id;
      try {
        if (source === 'hook') {
          const consumed = retryDb.prepare(`UPDATE local_action_retry_permits SET consumed_at=? WHERE id=(
            SELECT id FROM local_action_retry_permits WHERE tenant_id=? AND project_id=? AND task_id=?
              AND action_key=? AND conditions_hash IS ? AND attempt_id=? AND consumed_at IS NULL AND expires_at>?
            ORDER BY created_at DESC LIMIT 1) AND consumed_at IS NULL RETURNING id`)
            .get(now,tenantId,projectId,taskId,actionKey,condition.conditions_hash,attemptId,now);
          if (consumed) {
            decision = {...decision,decision:'allow',reason:'reviewed_retry_once'};
            retryPermit = {id:consumed.id,status:'consumed'};
          }
        } else {
          const id=randomUUID(), expiresAt=now+600_000;
          retryDb.exec('BEGIN IMMEDIATE');
          try {
            retryDb.prepare(`UPDATE local_action_retry_permits SET expires_at=? WHERE tenant_id=? AND project_id=?
              AND task_id=? AND action_key=? AND consumed_at IS NULL`).run(now,tenantId,projectId,taskId,actionKey);
            retryDb.prepare('INSERT INTO local_action_retry_permits VALUES(?,?,?,?,?,?,?,?,?,?,NULL)')
              .run(id,tenantId,projectId,taskId,actionKey,condition.conditions_hash,attemptId,hypothesis,now,expiresAt);
            retryDb.exec('COMMIT');
          } catch (error) { retryDb.exec('ROLLBACK'); throw error; }
          retryPermit={id,status:'issued',expires_at:expiresAt};
        }
      } finally { retryDb.close(); }
    }
    const alternatives = Array.isArray(input.alternatives) ? input.alternatives.slice(0, 5) : [];
    const db = this.open({ readOnly: true });
    let alternative_candidates;
    try {
      alternative_candidates = alternatives.flatMap((candidate) => {
        const key = normalizedIdentifier(candidate.action_key, "action_key", true);
        const exists = db.prepare("SELECT 1 FROM action_attempts WHERE tenant_id=? AND project_id=? AND action_key=? LIMIT 1")
          .get(tenantId, projectId, key);
        return exists ? [] : [{ action_key: key, label: nullableString(candidate.label, 240) || key, status: "no_accessible_prior_attempt" }];
      });
    } finally { db.close(); }
    const event = await this.recordAttemptMetricEvent(tenantId, {
      project_id: projectId, kind: "preflight", source, action_key: actionKey,
      conditions_hash: condition.conditions_hash, decision: decision.decision, reason: decision.reason,
      matched_attempt_id: decision.prior_attempts[0]?.id ?? null
    });
    return { ...decision, alternative_candidates, preflight_event_id: event.id, ...(retryPermit ? {retry_permit:retryPermit} : {}) };
  }

  async recordActionHookCoverage(tenantId, projectId, toolName, coverage) {
    await this.init();
    if (!["checked", "opaque", "recorded", "blocked"].includes(coverage)) throw new Error("invalid_action_hook_coverage");
    const day = new Date().toISOString().slice(0, 10);
    const db = this.open();
    try {
      db.prepare(`INSERT INTO action_hook_coverage(day,tenant_id,project_id,tool_name,coverage,count)
        VALUES(?,?,?,?,?,1) ON CONFLICT(day,tenant_id,project_id,tool_name,coverage)
        DO UPDATE SET count=count+1`).run(day, tenantId, projectId, String(toolName).slice(0, 128), coverage);
    } finally { db.close(); }
  }

  async listFailurePatterns(tenantId, { projectId = null } = {}) {
    await this.init();
    const db = this.open();
    try {
      return db.prepare(
        `SELECT id, tenant_id, project_id, business_category_id, work_type,
                pattern_key, label, action_fingerprint, failure_fingerprint,
                is_active, created_at, updated_at
         FROM memory_failure_patterns
         WHERE tenant_id = ? AND (? IS NULL OR project_id = ? OR project_id IS NULL)
         ORDER BY is_active DESC, updated_at DESC`
      ).all(tenantId, projectId, projectId);
    } finally {
      db.close();
    }
  }

  async createFailurePattern(tenantId, input) {
    await this.init();
    const db = this.open();
    try {
      const patternKey = normalizedIdentifier(input.pattern_key, "pattern_key", true);
      const label = nullableString(input.label, 240);
      if (!label) throw new Error("label_required");
      const businessCategoryId = nullableString(input.business_category_id, 128);
      const workType = input.work_type ?? null;
      validateBusinessClassification(db, tenantId, businessCategoryId, workType);
      const now = Date.now();
      const pattern = {
        id: nullableString(input.id, 128) || randomUUID(),
        tenant_id: tenantId,
        project_id: nullableString(input.project_id, 128),
        business_category_id: businessCategoryId,
        work_type: workType,
        pattern_key: patternKey,
        label,
        action_fingerprint: normalizedIdentifier(input.action_fingerprint, "action_fingerprint"),
        failure_fingerprint: normalizedIdentifier(input.failure_fingerprint, "failure_fingerprint"),
        is_active: input.is_active === false ? 0 : 1,
        created_at: now,
        updated_at: now
      };
      db.prepare(
        `INSERT INTO memory_failure_patterns(
           id, tenant_id, project_id, business_category_id, work_type,
           pattern_key, label, action_fingerprint, failure_fingerprint,
           is_active, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(...Object.values(pattern));
      return pattern;
    } finally {
      db.close();
    }
  }

  async updateFailurePattern(tenantId, patternId, input) {
    await this.init();
    const db = this.open();
    try {
      const current = db.prepare(
        "SELECT * FROM memory_failure_patterns WHERE tenant_id = ? AND id = ?"
      ).get(tenantId, patternId);
      if (!current) throw new Error("memory_failure_pattern_not_found");
      const businessCategoryId = input.business_category_id === undefined
        ? current.business_category_id
        : nullableString(input.business_category_id, 128);
      const workType = input.work_type === undefined ? current.work_type : input.work_type;
      validateBusinessClassification(db, tenantId, businessCategoryId, workType);
      const label = input.label === undefined ? current.label : nullableString(input.label, 240);
      if (!label) throw new Error("invalid_label");
      const updated = {
        project_id: input.project_id === undefined ? current.project_id : nullableString(input.project_id, 128),
        business_category_id: businessCategoryId,
        work_type: workType,
        pattern_key: input.pattern_key === undefined ? current.pattern_key : normalizedIdentifier(input.pattern_key, "pattern_key", true),
        label,
        action_fingerprint: input.action_fingerprint === undefined ? current.action_fingerprint : normalizedIdentifier(input.action_fingerprint, "action_fingerprint"),
        failure_fingerprint: input.failure_fingerprint === undefined ? current.failure_fingerprint : normalizedIdentifier(input.failure_fingerprint, "failure_fingerprint"),
        is_active: input.is_active === undefined ? current.is_active : input.is_active ? 1 : 0,
        updated_at: Date.now()
      };
      db.prepare(
        `UPDATE memory_failure_patterns SET
           project_id = ?, business_category_id = ?, work_type = ?, pattern_key = ?,
           label = ?, action_fingerprint = ?, failure_fingerprint = ?, is_active = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).run(...Object.values(updated), tenantId, patternId);
      return { ...current, ...updated };
    } finally {
      db.close();
    }
  }

  async updateUsageStates(tenantId, input) {
    await this.init();
    const usageEventId = nullableString(input.usage_event_id, 128);
    if (!usageEventId) throw new Error("usage_event_id_required");
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 128) {
      throw new Error("usage_state_items_required");
    }
    const updates = input.items.map((item) => {
      const usageItemId = nullableString(item.usage_item_id, 128);
      if (!usageItemId) throw new Error("usage_item_id_required");
      if (!["used", "not_used", "unknown"].includes(item.used_state)) throw new Error("invalid_used_state");
      return { usageItemId, usedState: item.used_state };
    });
    if (new Set(updates.map((item) => item.usageItemId)).size !== updates.length) throw new Error("duplicate_usage_item");
    const db = this.open();
    try {
      const event = db.prepare("SELECT created_at FROM memory_usage_events WHERE tenant_id = ? AND id = ?").get(tenantId, usageEventId);
      if (!event) throw new Error("memory_usage_event_not_found");
      db.exec("BEGIN IMMEDIATE");
      try {
        const update = db.prepare(
          "UPDATE memory_usage_items SET used_state = ?, used_state_source = 'reported' WHERE tenant_id = ? AND usage_event_id = ? AND id = ?"
        );
        for (const item of updates) {
          const result = update.run(item.usedState, tenantId, usageEventId, item.usageItemId);
          if (result.changes !== 1) throw new Error("memory_usage_item_not_found");
        }
        rebuildMemoryImpactDay(db, tenantId, utcDay(event.created_at));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { usage_event_id: usageEventId, updated_count: updates.length };
    } finally {
      db.close();
    }
  }

  /**
   * Whether a project-scoped hook search could return anything. Base retrieval
   * filters strictly by project, so a project without stored memories or use
   * contexts cannot produce a hit. An unknown project never reports empty.
   */
  async hasProjectMemories({ tenant_id: tenantId = "default", project_id: projectId = null } = {}) {
    if (!projectId) return true;
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return Boolean(
        db.prepare("SELECT 1 FROM memories WHERE tenant_id = ? AND project_id = ? AND deleted_at IS NULL LIMIT 1").get(tenantId, projectId)
        ?? db.prepare("SELECT 1 FROM memory_use_contexts WHERE tenant_id = ? AND project_id = ? LIMIT 1").get(tenantId, projectId)
      );
    } finally { db.close(); }
  }

  /**
   * Memories worth showing when a hook has no prompt to search with: verified
   * ones and ones with a recorded use in this project. This is a listing, not a
   * relevance judgment; callers still apply their own permission and expiry gates.
   */
  async listProvenMemories({ tenant_id: tenantId = "default", project_id: projectId = null, limit = 2 } = {}) {
    if (!projectId) return [];
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const rows = db.prepare(`SELECT * FROM (
          SELECT m.*, (SELECT COUNT(DISTINCT e.id) FROM memory_usage_items i
            JOIN memory_usage_events e ON e.id = i.usage_event_id AND e.tenant_id = i.tenant_id
            WHERE i.tenant_id = m.tenant_id AND i.source_type = 'memory' AND i.source_id = m.id
              AND i.used_state = 'used' AND e.project_id = m.project_id) AS proven_use_count
          FROM memories m
          WHERE m.tenant_id = ? AND m.project_id = ? AND m.lifecycle_state = 'active'
            AND m.deleted_at IS NULL AND m.suppressed_at IS NULL
        ) WHERE verification_state = 'verified' OR proven_use_count > 0
        ORDER BY (verification_state = 'verified') DESC, proven_use_count DESC, updated_at DESC, id LIMIT ?`)
        .all(tenantId, projectId, Math.max(1, Math.min(10, Number(limit) || 2)));
      return rows.map(({ proven_use_count: provenUseCount, ...row }) => ({
        memory: memoryFromRow(row), score: { total: 1, lexical: 0, semantic: 0 }, proven: true, proven_use_count: provenUseCount
      }));
    } finally { db.close(); }
  }

  /**
   * Current versions explicitly reported as not used in at least `min_tasks`
   * distinct tasks of this project, with no recorded use, and whose latest such
   * report is inside the window. Unknown states are never counted as non-use.
   */
  async nonUseCooldownKeys({ tenant_id: tenantId = "default", project_id: projectId = null, memories = [],
    min_tasks: minTasks = 3, window_ms: windowMs = 14 * 86_400_000, at = Date.now() } = {}) {
    const keys = new Set();
    if (!projectId || memories.length === 0) return keys;
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const statement = db.prepare(`SELECT
          COUNT(DISTINCT CASE WHEN i.used_state = 'not_used' THEN COALESCE(e.task_id, e.id) END) AS not_used_tasks,
          SUM(i.used_state = 'used') AS used_count,
          MAX(CASE WHEN i.used_state = 'not_used' THEN e.created_at END) AS last_not_used_at
        FROM memory_usage_items i
        JOIN memory_usage_events e ON e.id = i.usage_event_id AND e.tenant_id = i.tenant_id
        WHERE i.tenant_id = ? AND i.source_type = 'memory' AND i.source_id = ? AND i.source_version = ? AND e.project_id = ?`);
      for (const { id, current_version: version } of memories) {
        const row = statement.get(tenantId, id, version, projectId);
        if (row && Number(row.not_used_tasks) >= minTasks && !Number(row.used_count)
          && Number(row.last_not_used_at) >= at - windowMs) keys.add(`${id}:${version}`);
      }
      return keys;
    } finally { db.close(); }
  }

  async recordUsage(input) {
    await this.init();
    const tenantId = nullableString(input.tenant_id, 128) || "default";
    const usageId = nullableString(input.id, 128) || randomUUID();
    const accessPath = ["search", "profile", "context", "direct"].includes(input.access_path)
      ? input.access_path
      : "search";
    const requestSource = ["api", "mcp", "cap_runner", "local"].includes(input.request_source)
      ? input.request_source
      : "local";
    const uniqueItems = new Map();
    for (const item of Array.isArray(input.items) ? input.items : []) {
      const key = `${item.source_tenant_id ?? tenantId}:${item.source_type}:${item.source_id}`;
      if (!uniqueItems.has(key)) uniqueItems.set(key, item);
    }
    const items = [...uniqueItems.values()];
    const createdAt = finiteNumber(input.created_at) || Date.now();
    const db = this.open();
    try {
      const existing = db.prepare(
        "SELECT id, verification_sampled FROM memory_usage_events WHERE tenant_id = ? AND id = ?"
      ).get(tenantId, usageId);
      if (existing) {
        const existingItems = db.prepare(
          "SELECT id,source_type,source_id,source_version,COALESCE(source_tenant_id,tenant_id) AS source_tenant_id FROM memory_usage_items WHERE tenant_id = ? AND usage_event_id = ? ORDER BY rank, id"
        ).all(tenantId, usageId);
        return {
          usage_id: usageId,
          usage_item_ids: existingItems.map((item) => item.id),
          usage_items:existingItems.map(({id,...item})=>({usage_item_id:id,...item})),
          verification_sampled: Boolean(existing.verification_sampled),
          created: false
        };
      }
      const externalRunId = nullableString(input.external_run_id, 256);
      let linkedProjectId = nullableString(input.project_id, 128);
      let linkedTaskId = nullableString(input.task_id, 128);
      let linkedTraceId = nullableString(input.trace_id, 128);
      if (externalRunId) {
        const execution = db.prepare(
          `SELECT external_run_id, project_id, task_id, trace_id FROM memory_impact_events
           WHERE tenant_id = ? AND external_run_id = ? AND event_type = 'eligible'`
        ).get(tenantId, externalRunId);
        if (!execution) throw new Error("memory_impact_execution_not_found");
        for (const [field, supplied, expected] of [
          ["project_id", linkedProjectId, execution.project_id],
          ["task_id", linkedTaskId, execution.task_id],
          ["trace_id", linkedTraceId, execution.trace_id]
        ]) {
          if (supplied !== null && supplied !== expected) {
            throw new Error(`memory_impact_context_mismatch:${field}`);
          }
        }
        linkedProjectId ??= execution.project_id;
        linkedTaskId ??= execution.task_id;
        linkedTraceId ??= execution.trace_id;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO memory_usage_events(
             id, tenant_id, project_id, task_id, trace_id, external_run_id, capability,
             access_path, request_source, query_hash,
             requested_business_category_id, requested_work_type,
             retrieval_generation_id, ranking_profile_id,
             actor_principal, verification_sampled, created_at, usage_purpose
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          usageId, tenantId, linkedProjectId,
          linkedTaskId, linkedTraceId,
          externalRunId, nullableString(input.capability, 128), accessPath, requestSource,
          normalizedQueryHash(input.query_hash), nullableString(input.requested_business_category_id, 128),
          WORK_TYPES.has(input.requested_work_type) ? input.requested_work_type : null,
          nullableString(input.retrieval_generation_id, 128),
          nullableString(input.ranking_profile_id, 128),
          nullableString(input.actor_principal, 128) || process.env.ORGBRAIN_USE_PRINCIPAL || "local",
          verificationSampled(tenantId, usageId) ? 1 : 0, createdAt, normalizeUsagePurpose(input.usage_purpose)
        );
        const insert = db.prepare(
          `INSERT INTO memory_usage_items(
             id, usage_event_id, tenant_id, source_type, source_id, source_version,
             rank, score, reference_type, used_state, used_state_source, injected_token_estimate,
             business_category_id_snapshot, work_type_snapshot, quality_category_snapshot,
             created_at, source_tenant_id
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        );
        const itemIds = [];
        const receiptItems=[];
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (!["memory", "decision_memory"].includes(item.source_type)) {
            throw new Error("local_unknown_memory_source_type");
          }
          if (item.injected_token_estimate !== undefined && (!Number.isFinite(Number(item.injected_token_estimate)) || Number(item.injected_token_estimate) < 0)) {
            throw new Error("invalid_injected_token_estimate");
          }
          const sourceTenantId = item.source_tenant_id ?? tenantId;
          if (sourceTenantId !== tenantId && sourceTenantId !== "all") throw new Error("invalid_source_tenant");
          let memory = item.source_type === "memory"
            ? db.prepare(
              "SELECT id, current_version, business_category_id, work_type FROM memories WHERE tenant_id = ? AND id = ?"
            ).get(sourceTenantId, item.source_id)
            : db.prepare(
              `SELECT source_id AS id, NULL AS current_version,
                      business_category_id, work_type
               FROM retrieval_units
               WHERE tenant_id = ? AND source_type = 'decision_memory' AND source_id = ?
               ORDER BY created_at DESC LIMIT 1`
            ).get(sourceTenantId, item.source_id);
          if(item.source_type==='decision_memory') {
            const decision=db.prepare('SELECT id FROM decision_memories_local WHERE tenant_id=? AND id=?').get(sourceTenantId,item.source_id);
            if(decision) {
              const version=db.prepare('SELECT count(*) AS n FROM decision_memory_versions_local WHERE tenant_id=? AND decision_memory_id=?').get(sourceTenantId,item.source_id).n;
              memory={...memory,id:decision.id,current_version:version||null};
            }
          }
          if (!memory) throw new Error("memory_source_not_found");
          const itemId = nullableString(item.id, 128) || randomUUID();
          itemIds.push(itemId);
          receiptItems.push({usage_item_id:itemId,source_type:item.source_type,source_id:memory.id,...(sourceTenantId === tenantId ? {} : {source_tenant_id:sourceTenantId}),source_version:Object.hasOwn(item,"source_version") ? item.source_version ?? null : memory.current_version ?? null});
          insert.run(
            itemId, usageId, tenantId, item.source_type, memory.id,
            Object.hasOwn(item, 'source_version') ? item.source_version ?? null : (memory.current_version ?? null),
            Number.isInteger(item.rank) ? item.rank : index + 1,
            finiteNumber(item.score),
            ["returned", "injected", "direct"].includes(item.reference_type) ? item.reference_type : "returned",
            ["used", "not_used", "unknown"].includes(item.used_state) ? item.used_state : "unknown",
            "reported",
            Math.max(0, Number(item.injected_token_estimate ?? 0)),
            memory.business_category_id ?? null, memory.work_type ?? null,
            nullableString(item.quality_category_snapshot, 128), createdAt, sourceTenantId === tenantId ? null : sourceTenantId
          );
        }
        if (input.enqueue_sync === true || cloudTelemetryEnabled()) {
          const payload = {
            id: usageId,
            tenant_id: tenantId,
            project_id: linkedProjectId,
            task_id: linkedTaskId,
            trace_id: linkedTraceId,
            external_run_id: externalRunId,
            capability: nullableString(input.capability, 128),
            access_path: input.access_path,
            request_source: input.request_source,
            query_hash: normalizedQueryHash(input.query_hash),
            requested_business_category_id: nullableString(input.requested_business_category_id, 128),
            requested_work_type: input.requested_work_type ?? null,
            retrieval_generation_id: nullableString(input.retrieval_generation_id, 128),
            ranking_profile_id: nullableString(input.ranking_profile_id, 128),
            items: items.map((item, index) => ({
              id: itemIds[index],
              source_type: item.source_type,
              source_id: item.source_id,
              source_tenant_id: item.source_tenant_id,
              source_version: finiteNumber(item.source_version),
              rank: finiteNumber(item.rank),
              score: finiteNumber(item.score),
              reference_type: item.reference_type,
              used_state: item.used_state,
              injected_token_estimate: Math.max(0, Number(item.injected_token_estimate ?? 0)),
              quality_category_snapshot: nullableString(item.quality_category_snapshot, 128)
            })),
            created_at: createdAt
          };
          db.prepare(
            `INSERT INTO memory_telemetry_outbox(
               id, tenant_id, event_type, aggregate_id, payload_json,
               idempotency_key, created_at
             ) VALUES(?,?,?,?,?,?,?)`
          ).run(randomUUID(), tenantId, "memory_usage", usageId, JSON.stringify(payload), `usage:${tenantId}:${usageId}`, createdAt);
        }
        rebuildMemoryImpactDay(db, tenantId, utcDay(createdAt));
        db.exec("COMMIT");
        return {
          usage_id: usageId,
          usage_item_ids: itemIds,
          usage_items:receiptItems,
          verification_sampled: verificationSampled(tenantId, usageId),
          created: true
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  async recordEffect(input) {
    const effect=await this.recordEffectBase(input);
    if(!input.use_evaluation) return effect;
    const use_evaluation=await this.useHistory('evaluate',{...input.use_evaluation,tenant_id:input.tenant_id||'default',principal_id:input.principal_id,id:input.use_evaluation.id||`${effect.effect_id}:use`,effect_event_id:effect.effect_id});
    return {...effect,use_evaluation};
  }

  async recordEffectBase(input) {
    await this.init();
    const tenantId = nullableString(input.tenant_id, 128) || "default";
    const usageId = nullableString(input.usage_event_id, 128);
    const idempotencyKey = nullableString(input.idempotency_key, 256);
    if (!usageId) throw new Error("usage_event_id_required");
    if (!idempotencyKey) throw new Error("idempotency_key_required");
    const avoided = [...new Set(Array.isArray(input.avoided_lookup_categories) ? input.avoided_lookup_categories : [])];
    if (input.avoided_lookup_categories !== undefined && !Array.isArray(input.avoided_lookup_categories)) throw new Error("invalid_avoided_lookup_categories");
    if (avoided.some((value) => !AVOIDED_LOOKUP_CATEGORIES.has(value))) throw new Error("invalid_avoided_lookup_category");
    if (avoided.includes("none") && avoided.length > 1) throw new Error("avoided_lookup_none_is_exclusive");
    if (input.evidence_level !== undefined && !["reported", "estimated", "verified", "unverifiable"].includes(input.evidence_level)) throw new Error("invalid_evidence_level");
    const evidenceLevel = input.evidence_level ?? "reported";
    if (input.effect_outcome === undefined) throw new Error("effect_outcome_required");
    if (!["positive", "neutral", "negative", "unknown"].includes(input.effect_outcome)) throw new Error("invalid_effect_outcome");
    const outcome = input.effect_outcome;
    if (input.failure_opportunity_state !== undefined && !["applicable", "not_applicable", "unknown"].includes(input.failure_opportunity_state)) throw new Error("invalid_failure_opportunity_state");
    const opportunity = input.failure_opportunity_state ?? "unknown";
    const actionChanged = Boolean(input.action_changed);
    const alternativeExecuted = Boolean(input.alternative_executed);
    const failureAvoided = Boolean(input.failure_avoided);
    if (failureAvoided && !(opportunity === "applicable" && actionChanged && alternativeExecuted)) {
      throw new Error("invalid_failure_avoidance_evidence");
    }
    const supersedesEffectId = nullableString(input.supersedes_effect_id, 128);
    const failurePatternId = nullableString(input.failure_pattern_id, 128);
    if (evidenceLevel === "verified" && !(input.verification_ref_type && input.verification_ref_id)) {
      throw new Error("verification_reference_required");
    }
    const createdAt = finiteNumber(input.created_at) || Date.now();
    const effectId = nullableString(input.id, 128) || randomUUID();
    const db = this.open();
    try {
      const existing = db.prepare(
        "SELECT id FROM memory_effect_events WHERE tenant_id = ? AND idempotency_key = ?"
      ).get(tenantId, idempotencyKey);
      if (existing) return { effect_id: existing.id, created: false };
      const usage = db.prepare(
        "SELECT id, created_at FROM memory_usage_events WHERE tenant_id = ? AND id = ?"
      ).get(tenantId, usageId);
      if (!usage) throw new Error("memory_usage_event_not_found");
      if (supersedesEffectId) {
        const superseded = db.prepare(
          `SELECT id FROM memory_effect_events
           WHERE tenant_id = ? AND usage_event_id = ? AND id = ?`
        ).get(tenantId, usageId, supersedesEffectId);
        if (!superseded) throw new Error("invalid_supersedes_effect_id");
      }
      const currentEffect = db.prepare(
        `SELECT e.id FROM memory_effect_events e
         WHERE e.tenant_id = ? AND e.usage_event_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM memory_effect_events child
             WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
           )
         ORDER BY e.created_at DESC, e.id DESC LIMIT 1`
      ).get(tenantId, usageId);
      if (currentEffect && supersedesEffectId !== currentEffect.id) throw new Error("effect_supersedes_latest_required");
      if (!currentEffect && supersedesEffectId) throw new Error("effect_supersedes_latest_required");
      if (failurePatternId) {
        const pattern = db.prepare(
          "SELECT id FROM memory_failure_patterns WHERE tenant_id = ? AND id = ? AND is_active = 1"
        ).get(tenantId, failurePatternId);
        if (!pattern) throw new Error("invalid_failure_pattern_id");
      }
      if (opportunity === "applicable" && !failurePatternId) throw new Error("failure_pattern_id_required");
      const failureSavedTokens = Number(input.failure_saved_tokens_estimate ?? 0);
      if (!Number.isFinite(failureSavedTokens) || failureSavedTokens < 0) {
        throw new Error("invalid_failure_saved_tokens_estimate");
      }
      if (failureSavedTokens !== 0 && !failureAvoided) {
        throw new Error("failure_saved_tokens_without_avoidance");
      }
      const usageItems = db.prepare(
        `SELECT id, source_type, source_id, COALESCE(source_tenant_id, tenant_id) AS source_tenant_id,
           business_category_id_snapshot, injected_token_estimate FROM memory_usage_items
         WHERE tenant_id = ? AND usage_event_id = ? ORDER BY rank, id`
      ).all(tenantId, usageId);
      if (usageItems.length === 0) throw new Error("memory_usage_items_required");
      const requestedAttributions = Array.isArray(input.attributions) ? input.attributions : [];
      const usageItemIds = new Set(usageItems.map((item) => item.id));
      const attributionById = new Map();
      for (const item of requestedAttributions) {
        if (!usageItemIds.has(item.usage_item_id)) throw new Error("invalid_usage_item_attribution");
        const weight = Number(item.attribution_weight);
        if (!Number.isFinite(weight) || weight <= 0 || weight > 1) throw new Error("invalid_attribution_weight");
        if (attributionById.has(item.usage_item_id)) throw new Error("duplicate_usage_item_attribution");
        attributionById.set(item.usage_item_id, weight);
      }
      const attributions = usageItems.map((item) => ({
        usage_item_id: item.id,
        attribution_weight: attributionById.size > 0
          ? attributionById.get(item.id) ?? 0
          : 1 / usageItems.length
      })).filter((item) => item.attribution_weight > 0);
      const weightTotal = attributions.reduce((sum, item) => sum + item.attribution_weight, 0);
      if (Math.abs(weightTotal - 1) > 0.000001) throw new Error("attribution_weights_must_sum_to_one");
      const estimationCandidates = input.token_estimation_candidates && typeof input.token_estimation_candidates === "object" && !Array.isArray(input.token_estimation_candidates)
        ? { ...input.token_estimation_candidates }
        : {};
      if (input.gross_saved_tokens_estimate === undefined) {
        let sourceTokenTotal = 0;
        for (const item of usageItems) {
          const row = item.source_type === "memory"
            ? db.prepare("SELECT content AS text FROM memories WHERE tenant_id = ? AND id = ?").get(item.source_tenant_id, item.source_id)
            : db.prepare("SELECT text FROM retrieval_units WHERE tenant_id = ? AND source_type = 'decision_memory' AND source_id = ? ORDER BY created_at DESC LIMIT 1").get(item.source_tenant_id, item.source_id);
          sourceTokenTotal += estimateTextTokens(typeof row?.text === "string" ? row.text : "");
        }
        const sourceTokens = Math.max(1, sourceTokenTotal);
        estimationCandidates.text_size_heuristic_tokens ??= sourceTokens;
        if (avoided.some((category) => category === "source_search" || category === "past_context")) {
          estimationCandidates.avoided_source_tokens ??= sourceTokens;
        }
        if (failurePatternId && estimationCandidates.failure_pattern_median_tokens === undefined) {
          const rows = db.prepare(
            `SELECT e.gross_saved_tokens_estimate AS value FROM memory_effect_events e
             WHERE e.tenant_id = ? AND e.failure_pattern_id = ? AND e.evidence_level IN ('estimated', 'verified')
               AND NOT EXISTS (
                 SELECT 1 FROM memory_effect_events child
                 WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
               )
             ORDER BY e.created_at DESC LIMIT 101`
          ).all(tenantId, failurePatternId);
          const value = median(rows.map((row) => Number(row.value)).filter(Number.isFinite));
          if (value !== undefined) estimationCandidates.failure_pattern_median_tokens = value;
        }
        const categoryIds = [...new Set(usageItems.map((item) => item.business_category_id_snapshot).filter(Boolean))];
        if (categoryIds.length && estimationCandidates.category_median_tokens === undefined) {
          const rows = db.prepare(
            `SELECT ea.gross_saved_tokens AS value
             FROM memory_effect_attributions ea
             JOIN memory_effect_events e ON e.tenant_id = ea.tenant_id AND e.id = ea.effect_event_id
             JOIN memory_usage_items ui ON ui.tenant_id = ea.tenant_id AND ui.id = ea.usage_item_id
             WHERE ea.tenant_id = ? AND e.evidence_level IN ('estimated', 'verified')
               AND ui.business_category_id_snapshot IN (${categoryIds.map(() => "?").join(",")})
               AND NOT EXISTS (
                 SELECT 1 FROM memory_effect_events child
                 WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
               )
             ORDER BY ea.created_at DESC LIMIT 101`
          ).all(tenantId, ...categoryIds);
          const value = median(rows.map((row) => Number(row.value)).filter(Number.isFinite));
          if (value !== undefined) estimationCandidates.category_median_tokens = value;
        }
      }
      const tokenEstimate = resolveLocalTokenEstimate({ ...input, token_estimation_candidates: estimationCandidates });
      const gross = tokenEstimate.gross;
      const attributedIds = new Set(attributions.map((item) => item.usage_item_id));
      if (input.injected_tokens !== undefined && (!Number.isFinite(Number(input.injected_tokens)) || Number(input.injected_tokens) < 0)) {
        throw new Error("invalid_injected_tokens");
      }
      const injected = input.injected_tokens === undefined
        ? usageItems
          .filter((item) => attributedIds.has(item.id))
          .reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.injected_token_estimate ?? 0))), 0)
        : Math.max(0, Math.round(Number(input.injected_tokens)));
      const net = gross - injected;
      if (input.net_saved_tokens_estimate !== undefined && Math.round(Number(input.net_saved_tokens_estimate)) !== net) {
        throw new Error("net_saved_tokens_mismatch");
      }
      if (![gross, injected, net].every(Number.isFinite)) throw new Error("invalid_token_estimate");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO memory_effect_events(
             id, tenant_id, usage_event_id, idempotency_key, evidence_level,
             supersedes_effect_id, effect_outcome, avoided_lookup_categories_json,
             gross_saved_tokens_estimate, injected_tokens, net_saved_tokens_estimate,
             estimate_lower_bound, estimate_upper_bound, estimation_method,
             estimator_version, estimate_confidence, failure_pattern_id,
             failure_opportunity_state, action_changed, alternative_executed,
             failure_avoided, failure_saved_tokens_estimate,
             verification_ref_type, verification_ref_id,
             estimated_tool_calls_saved, estimated_seconds_saved, created_at
           ) VALUES(${Array.from({ length: 27 }, () => "?").join(",")})`
        ).run(
          effectId, tenantId, usageId, idempotencyKey, evidenceLevel,
          supersedesEffectId, outcome, JSON.stringify(avoided),
          gross, injected, net, finiteNumber(input.estimate_lower_bound),
          finiteNumber(input.estimate_upper_bound), tokenEstimate.method,
          nullableString(input.estimator_version, 64), finiteNumber(input.estimate_confidence),
          failurePatternId, opportunity,
          actionChanged ? 1 : 0, alternativeExecuted ? 1 : 0,
          failureAvoided ? 1 : 0, failureSavedTokens,
          nullableString(input.verification_ref_type, 64), nullableString(input.verification_ref_id, 256),
          finiteNumber(input.estimated_tool_calls_saved), finiteNumber(input.estimated_seconds_saved), createdAt
        );
        const insertAttribution = db.prepare(
          `INSERT INTO memory_effect_attributions(
             id, tenant_id, effect_event_id, usage_item_id, attribution_weight,
             gross_saved_tokens, net_saved_tokens, failure_saved_tokens, created_at
           ) VALUES(?,?,?,?,?,?,?,?,?)`
        );
        let allocatedGross = 0;
        let allocatedNet = 0;
        let allocatedFailure = 0;
        for (let index = 0; index < attributions.length; index += 1) {
          const attribution = attributions[index];
          const last = index === attributions.length - 1;
          const attributedGross = last ? gross - allocatedGross : Math.round(gross * attribution.attribution_weight);
          const attributedNet = last ? net - allocatedNet : Math.round(net * attribution.attribution_weight);
          const failureSaved = failureSavedTokens;
          const attributedFailure = last ? failureSaved - allocatedFailure : Math.round(failureSaved * attribution.attribution_weight);
          allocatedGross += attributedGross;
          allocatedNet += attributedNet;
          allocatedFailure += attributedFailure;
          insertAttribution.run(
            randomUUID(), tenantId, effectId, attribution.usage_item_id,
            attribution.attribution_weight, attributedGross, attributedNet,
            attributedFailure, createdAt
          );
        }
        if (supersedesEffectId) {
          db.prepare(
            `UPDATE memory_usage_items SET used_state = 'unknown', used_state_source = 'reported'
             WHERE tenant_id = ? AND usage_event_id = ? AND used_state_source = 'effect'
               AND id IN (
                 SELECT usage_item_id FROM memory_effect_attributions
                 WHERE tenant_id = ? AND effect_event_id = ?
               )`
          ).run(tenantId, usageId, tenantId, supersedesEffectId);
        }
        if (input.used_state === "used" || outcome !== "unknown") {
          db.prepare(
            `UPDATE memory_usage_items SET used_state = 'used', used_state_source = 'effect'
             WHERE tenant_id = ? AND usage_event_id = ?
               AND (used_state_source = 'effect' OR used_state = 'unknown')
               AND id IN (${attributions.map(() => "?").join(",")})`
          ).run(tenantId, usageId, ...attributions.map((item) => item.usage_item_id));
        }
        if (input.enqueue_sync === true || cloudTelemetryEnabled()) {
          const payload = {
            id: effectId,
            tenant_id: tenantId,
            usage_event_id: usageId,
            idempotency_key: idempotencyKey,
            evidence_level: evidenceLevel,
            supersedes_effect_id: supersedesEffectId,
            effect_outcome: outcome,
            avoided_lookup_categories: avoided,
            gross_saved_tokens_estimate: gross,
            injected_tokens: injected,
            net_saved_tokens_estimate: net,
            estimate_lower_bound: finiteNumber(input.estimate_lower_bound),
            estimate_upper_bound: finiteNumber(input.estimate_upper_bound),
            estimation_method: nullableString(input.estimation_method, 128),
            estimator_version: nullableString(input.estimator_version, 64),
            estimate_confidence: finiteNumber(input.estimate_confidence),
            failure_pattern_id: failurePatternId,
            failure_opportunity_state: opportunity,
            action_changed: actionChanged,
            alternative_executed: alternativeExecuted,
            failure_avoided: failureAvoided,
            failure_saved_tokens_estimate: failureSavedTokens,
            verification_ref_type: nullableString(input.verification_ref_type, 64),
            verification_ref_id: nullableString(input.verification_ref_id, 256),
            estimated_tool_calls_saved: finiteNumber(input.estimated_tool_calls_saved),
            estimated_seconds_saved: finiteNumber(input.estimated_seconds_saved),
            attributions,
            created_at: createdAt
          };
          db.prepare(
            `INSERT INTO memory_telemetry_outbox(
               id, tenant_id, event_type, aggregate_id, payload_json,
               idempotency_key, created_at
             ) VALUES(?,?,?,?,?,?,?)`
          ).run(randomUUID(), tenantId, "memory_effect", effectId, JSON.stringify(payload), `effect:${tenantId}:${idempotencyKey}`, createdAt);
        }
        rebuildMemoryImpactDay(db, tenantId, utcDay(usage.created_at));
        db.exec("COMMIT");
        return { effect_id: effectId, created: true, net_saved_tokens_estimate: net };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  async rebuildMemoryImpact(tenantId, day = utcDay(Date.now())) {
    await this.init();
    const db = this.open();
    try {
      return rebuildMemoryImpactDay(db, tenantId, day);
    } finally {
      db.close();
    }
  }

  async syncTelemetryOutbox({ apiBase, apiKey, limit = 100, fetchImpl = fetch } = {}) {
    await this.init();
    if (!cloudTelemetryEnabled()) throw new Error("cloud_memory_sync_not_enabled");
    const base = nullableString(apiBase, 2048)?.replace(/\/+$/u, "");
    const key = nullableString(apiKey, 2048);
    if (!base) throw new Error("ORGBRAIN_API_URL_required");
    if (!key) throw new Error("ORGBRAIN_API_KEY_required");
    const db = this.open();
    const now = Date.now();
    const rows = db.prepare(
      `SELECT id, event_type, payload_json, attempt_count
       FROM memory_telemetry_outbox
       WHERE sent_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY CASE event_type WHEN 'memory_usage' THEN 0 ELSE 1 END, created_at, id
       LIMIT ?`
    ).all(now, Math.max(1, Math.min(1000, Number(limit) || 100)));
    let sent = 0;
    let failed = 0;
    try {
      for (const row of rows) {
        const endpoint = row.event_type === "memory_usage"
          ? "/v1/memory-usages"
          : row.event_type === "memory_effect"
            ? "/v1/memory-effects"
            : null;
        if (!endpoint) {
          failed += 1;
          db.prepare(
            `UPDATE memory_telemetry_outbox
             SET attempt_count = attempt_count + 1, next_attempt_at = ?, last_error_code = ?
             WHERE id = ?`
          ).run(now + 86_400_000, "unsupported_event_type", row.id);
          continue;
        }
        let errorCode = "network_error";
        try {
          const response = await fetchImpl(`${base}${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": key },
            body: row.payload_json
          });
          if (!response.ok) {
            errorCode = `http_${response.status}`;
            throw new Error(errorCode);
          }
          db.prepare(
            `UPDATE memory_telemetry_outbox
             SET sent_at = ?, next_attempt_at = NULL, last_error_code = NULL
             WHERE id = ?`
          ).run(Date.now(), row.id);
          sent += 1;
        } catch (error) {
          failed += 1;
          const attempts = Number(row.attempt_count ?? 0) + 1;
          const delay = Math.min(86_400_000, 1000 * (2 ** Math.min(attempts, 16)));
          db.prepare(
            `UPDATE memory_telemetry_outbox
             SET attempt_count = ?, next_attempt_at = ?, last_error_code = ?
             WHERE id = ?`
          ).run(
            attempts,
            Date.now() + delay,
            errorCode === "network_error" && error instanceof Error && error.message.startsWith("http_")
              ? error.message.slice(0, 64)
              : errorCode,
            row.id
          );
        }
      }
      const pending = db.prepare(
        "SELECT COUNT(*) AS count FROM memory_telemetry_outbox WHERE sent_at IS NULL"
      ).get().count;
      return { attempted: rows.length, sent, failed, pending: Number(pending) };
    } finally {
      db.close();
    }
  }

  async memoryImpactReport(tenantId, filters = {}) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const groupColumns = {
        memory: "ui.source_type || ':' || ui.source_id",
        business_category: "COALESCE(ui.business_category_id_snapshot, 'unclassified')",
        work_type: "COALESCE(ui.work_type_snapshot, 'unclassified')",
        project: "COALESCE(ue.project_id, 'unclassified')",
        day: "date(ui.created_at / 1000, 'unixepoch')"
      };
      const groupBy = Object.hasOwn(groupColumns, filters.group_by) ? filters.group_by : "memory";
      const clauses = ["ui.tenant_id = ?"];
      const bindings = [tenantId];
      if (groupBy === "business_category") clauses.push("ui.business_category_id_snapshot IS NOT NULL");
      for (const [field, value] of [
        ["ui.source_type", filters.source_type],
        ["ui.source_id", filters.source_id],
        ["ui.business_category_id_snapshot", filters.business_category_id],
        ["ui.work_type_snapshot", filters.work_type],
        ["date(ui.created_at / 1000, 'unixepoch')", filters.day]
      ]) {
        if (value) {
          clauses.push(`${field} = ?`);
          bindings.push(value);
        }
      }
      const rows = db.prepare(
        `WITH latest_effect AS (
           SELECT e.* FROM memory_effect_events e
           WHERE e.tenant_id = ? AND NOT EXISTS (
             SELECT 1 FROM memory_effect_events child
             WHERE child.tenant_id = e.tenant_id
               AND child.supersedes_effect_id = e.id
           )
         )
         SELECT ${groupColumns[groupBy]} AS group_key,
           CASE WHEN ea.usage_item_id IS NOT NULL THEN le.evidence_level ELSE 'unreported' END AS evidence_level,
           COUNT(DISTINCT ui.usage_event_id) AS reference_count,
           COUNT(DISTINCT CASE WHEN ui.used_state = 'used' THEN ui.usage_event_id END) AS used_count,
           COUNT(DISTINCT CASE WHEN ui.used_state = 'not_used' THEN ui.usage_event_id END) AS not_used_count,
           COUNT(DISTINCT CASE WHEN ui.used_state = 'unknown' THEN ui.usage_event_id END) AS usage_unknown_count,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL THEN ui.usage_event_id END) AS effect_reported_count,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'positive' THEN ui.usage_event_id END) AS positive_count,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'neutral' THEN ui.usage_event_id END) AS neutral_count,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'negative' THEN ui.usage_event_id END) AS negative_count,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'unknown' THEN ui.usage_event_id END) AS unknown_count,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json LIKE '%source_search%' THEN ui.usage_event_id END) AS avoided_source_search_count,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json LIKE '%web_search%' THEN ui.usage_event_id END) AS avoided_web_search_count,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json LIKE '%past_context%' THEN ui.usage_event_id END) AS avoided_past_context_count,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json = '["none"]' THEN ui.usage_event_id END) AS avoided_none_count,
           COALESCE(SUM(ea.gross_saved_tokens), 0) AS gross_saved_tokens,
           COALESCE(SUM(ea.gross_saved_tokens - ea.net_saved_tokens), 0) AS injected_tokens,
           COALESCE(SUM(ea.net_saved_tokens), 0) AS net_saved_tokens,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.failure_opportunity_state = 'applicable' THEN ui.usage_event_id END) AS failure_opportunity_count,
           COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.failure_avoided = 1 THEN ui.usage_event_id END) AS failure_avoided_count,
           COALESCE(SUM(ea.failure_saved_tokens), 0) AS failure_saved_tokens,
           COUNT(DISTINCT CASE WHEN ue.verification_sampled = 1 THEN ui.usage_event_id END) AS verification_sampled_count,
           COUNT(DISTINCT CASE WHEN ue.verification_sampled = 1 AND ea.usage_item_id IS NOT NULL AND le.evidence_level = 'verified' THEN ui.usage_event_id END) AS verified_count,
           SUM(le.estimated_tool_calls_saved * ea.attribution_weight) AS estimated_tool_calls_saved,
           SUM(le.estimated_seconds_saved * ea.attribution_weight) AS estimated_seconds_saved,
           COALESCE(SUM(CASE
             WHEN le.evidence_level = 'verified' AND previous.id IS NOT NULL
             THEN ABS(COALESCE(ea.gross_saved_tokens, 0) - COALESCE(previous_attribution.gross_saved_tokens, 0))
             ELSE 0 END), 0) AS estimator_absolute_error_sum
         FROM memory_usage_items ui
         JOIN memory_usage_events ue ON ue.tenant_id = ui.tenant_id AND ue.id = ui.usage_event_id
         LEFT JOIN latest_effect le ON le.tenant_id = ui.tenant_id AND le.usage_event_id = ui.usage_event_id
         LEFT JOIN memory_effect_attributions ea
           ON ea.tenant_id = ui.tenant_id AND ea.effect_event_id = le.id AND ea.usage_item_id = ui.id
         LEFT JOIN memory_effect_events previous
           ON previous.tenant_id = le.tenant_id AND previous.id = le.supersedes_effect_id
         LEFT JOIN memory_effect_attributions previous_attribution
           ON previous_attribution.tenant_id = previous.tenant_id
          AND previous_attribution.effect_event_id = previous.id
          AND previous_attribution.usage_item_id = ui.id
         WHERE ${clauses.join(" AND ")}
         GROUP BY group_key, CASE WHEN ea.usage_item_id IS NOT NULL THEN le.evidence_level ELSE 'unreported' END
         ORDER BY group_key, evidence_level`
      ).all(tenantId, ...bindings);
      const rankRows = db.prepare(
        `SELECT rank, COUNT(DISTINCT usage_event_id) AS reference_count,
                COUNT(DISTINCT CASE WHEN used_state = 'used' THEN usage_event_id END) AS used_count,
                COUNT(DISTINCT CASE WHEN used_state = 'not_used' THEN usage_event_id END) AS not_used_count,
                COUNT(DISTINCT CASE WHEN used_state = 'unknown' THEN usage_event_id END) AS usage_unknown_count
         FROM memory_usage_items
         WHERE tenant_id = ? AND rank IS NOT NULL
         GROUP BY rank ORDER BY rank`
      ).all(tenantId);
      return {
        tenant_id: tenantId,
        group_by: groupBy,
        unclassified_excluded: groupBy === "business_category",
        groups: rows.map((row) => ({
          ...row,
          utilization_rate: row.reference_count ? row.used_count / row.reference_count : null,
          positive_effect_rate: row.used_count ? row.positive_count / row.used_count : null,
          negative_effect_rate: row.used_count ? row.negative_count / row.used_count : null,
          failure_avoidance_rate: row.failure_opportunity_count
            ? row.failure_avoided_count / row.failure_opportunity_count
            : null,
          verification_coverage: row.verification_sampled_count
            ? row.verified_count / row.verification_sampled_count
            : null,
          net_saved_tokens_per_1000_injected: row.injected_tokens
            ? row.net_saved_tokens * 1000 / row.injected_tokens
            : null
        })),
        rank_utilization: rankRows.map((row) => ({
          ...row,
          utilization_rate: row.reference_count ? row.used_count / row.reference_count : null
        }))
      };
    } finally {
      db.close();
    }
  }

  captureIntoDatabase(db, input, { updateFeatureStats = true, writeProjections = true } = {}) {
    return captureIntoDatabase(db, input, { updateFeatureStats, writeProjections });
  }

  async capture(input) {
    await this.init();
    const db = this.open();
    let result;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        result = this.captureIntoDatabase(db, input);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
    return this.attachDenseProjection(result, nullableString(input.tenant_id, 128) || "default");
  }

  async saveMcpConfirmation({ token, tenant_id: tenantId = "default", payload, created_at: createdAt, expires_at: expiresAt }) {
    await this.init();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM local_mcp_confirmations WHERE expires_at <= ?").run(createdAt);
        db.prepare(
          `INSERT INTO local_mcp_confirmations(token_hash, tenant_id, payload_json, created_at, expires_at)
           VALUES(?,?,?,?,?)`
        ).run(
          confirmationTokenHash(token),
          tenantId,
          JSON.stringify(payload),
          createdAt,
          expiresAt
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  async mcpConfirmationStatus({token, tenant_id:tenantId='default'}) {
    await this.init();
    const db=this.open({readOnly:true});
    try {
      const tokenHash=confirmationTokenHash(token);
      const receipt=db.prepare('SELECT result_json FROM local_mcp_confirmation_receipts WHERE tenant_id=? AND token_hash=?').get(tenantId,tokenHash);
      if(receipt) return {...JSON.parse(receipt.result_json),status:'completed'};
      const row=db.prepare('SELECT payload_json,expires_at FROM local_mcp_confirmations WHERE tenant_id=? AND token_hash=?').get(tenantId,tokenHash);
      if(!row) throw new Error('confirmation_not_found');
      return {tenant_id:tenantId,candidate_id:JSON.parse(row.payload_json).review_context?.candidate_id??null,
        status:row.expires_at<=Date.now()?'expired':'pending',expires_at:row.expires_at,saved:null};
    } finally {db.close();}
  }

  async consumeMcpConfirmation({ token, tenant_id: tenantId = "default", approved, buildCaptureInput, requestHash, validateConfirmation, buildReceipt }) {
    await this.init();
    const db = this.open();
    let transactionOpen = false;
    let expired = false;
    let payload;
    let saved = null;
    let captureInput = null;
    let receipt=null;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const tokenHash = confirmationTokenHash(token);
      const existing=db.prepare('SELECT request_hash,result_json FROM local_mcp_confirmation_receipts WHERE tenant_id=? AND token_hash=?').get(tenantId,tokenHash);
      if(existing) {
        if(existing.request_hash!==requestHash) throw new Error('confirmation_answer_changed');
        db.exec('COMMIT');transactionOpen=false;
        return {receipt:JSON.parse(existing.result_json),replayed:true};
      }
      const row = db.prepare(
        `SELECT payload_json, expires_at
         FROM local_mcp_confirmations
         WHERE token_hash = ? AND tenant_id = ?`
      ).get(tokenHash, tenantId);
      if (!row) throw new Error("confirmation_not_found");
      payload = JSON.parse(row.payload_json);
      if (validateConfirmation) validateConfirmation(payload);
      if (Number(row.expires_at) <= Date.now()) {
        db.prepare("DELETE FROM local_mcp_confirmations WHERE token_hash = ?").run(tokenHash);
        expired = true;
      } else if (approved !== true) {
        db.prepare("DELETE FROM local_mcp_confirmations WHERE token_hash = ?").run(tokenHash);
      } else {
        if (typeof buildCaptureInput !== "function") throw new Error("confirmation_capture_builder_required");
        captureInput = buildCaptureInput(payload);
        saved = this.captureIntoDatabase(db, captureInput);
        db.prepare("DELETE FROM local_mcp_confirmations WHERE token_hash = ?").run(tokenHash);
      }
      if(!expired && buildReceipt) {
        receipt=buildReceipt(payload,saved);
        db.prepare('INSERT INTO local_mcp_confirmation_receipts VALUES(?,?,?,?,?,?)').run(tokenHash,tenantId,requestHash,JSON.stringify(receipt),JSON.stringify(payload),Date.now());
      }
      db.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
    if (expired) throw new Error("confirmation_expired");
    if (saved && captureInput) {
      saved = await this.attachDenseProjection(saved, nullableString(captureInput.tenant_id, 128) || "default");
    }
    return { payload, saved, receipt };
  }

  async captureBatch(inputs) {
    if (!Array.isArray(inputs)) throw new Error("captureBatch inputs must be an array");
    if (inputs.length === 0) return [];
    await this.init();
    const db = this.open();
    let results;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        results = inputs.map((input) =>
          this.captureIntoDatabase(db, input, {
            updateFeatureStats: false,
            writeProjections: false
          })
        );
        rebuildFts(db);
        rebuildLocalEmbeddings(db);
        rebuildRetrievalUnits(db);
        rebuildRetrievalUnitsV4(db);
        rebuildStableRetrievalUnits(db);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
    if (!this.denseEmbeddingProvider) return results;
    const byTenant = new Map();
    results.forEach((result, index) => {
      const tenantId = nullableString(inputs[index].tenant_id, 128) || "default";
      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), { result, index }]);
    });
    const augmented = [...results];
    for (const [tenantId, entries] of byTenant) {
      try {
        const projection = await this.rebuildDenseEmbeddings({
          tenant_id: tenantId,
          memory_ids: [...new Set(entries.map((entry) => entry.result.memory_id))]
        });
        for (const entry of entries) {
          augmented[entry.index] = {
            ...entry.result,
            embedding_projection: { state: "indexed", ...projection }
          };
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const entry of entries) {
          augmented[entry.index] = {
            ...entry.result,
            embedding_projection: { state: "failed", reason }
          };
        }
      }
    }
    return augmented;
  }

  async attachDenseProjection(result, tenantId) {
    if (!this.denseEmbeddingProvider) return result;
    try {
      const projection = await this.rebuildDenseEmbeddings({
        tenant_id: tenantId,
        memory_ids: [result.memory_id]
      });
      return { ...result, embedding_projection: { state: "indexed", ...projection } };
    } catch (error) {
      return {
        ...result,
        embedding_projection: {
          state: "failed",
          reason: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  async revise(tenantId, memoryId, input) {
    return this.mutate(tenantId, memoryId, "revise", (current) => ({
      ...current,
      ...input,
      id: current.id,
      tenant_id: current.tenant_id,
      source: current.source,
      external_key: current.external_key,
      created_at: current.created_at,
      lifecycle_state: current.lifecycle_state
    }));
  }

  async suppress(tenantId, memoryId, reason, actor = {}) {
    return this.mutate(tenantId, memoryId, "suppress", (current) => ({
      ...current,
      lifecycle_state: "suppressed",
      summary: current.summary || nullableString(reason, 1000),
      tags: normalizeStrings([...current.tags, "compacted"]),
      actor_type: actor.actor_type ?? current.actor_type,
      actor_id: actor.actor_id ?? current.actor_id
    }));
  }

  async restoreMemoryVersion(tenantId, memoryId, version, reviewer) {
    if (!Number.isInteger(version) || version < 1 || !reviewer) throw new Error("invalid_restore_request");
    return this.mutate(tenantId, memoryId, "restore", (current, db) => {
      if (current.lifecycle_state !== "suppressed") throw new Error("memory_not_suppressed");
      const pending = hasTable(db, "local_memory_retention_queue")
        && db.prepare(`SELECT 1 FROM local_memory_retention_queue
          WHERE tenant_id=? AND memory_id=? AND version=?`)
          .get(tenantId, memoryId, current.current_version);
      const localOwner = process.env.ORGBRAIN_USE_PRINCIPAL || "local";
      if (reviewer !== (current.owner_principal || (pending ? localOwner : current.actor_id) || "local")) {
        throw new Error("reviewer_not_authorized");
      }
      const historical = db.prepare("SELECT snapshot_json FROM memory_versions WHERE tenant_id=? AND memory_id=? AND version=?")
        .get(tenantId, memoryId, version);
      if (!historical) throw new Error("memory_version_not_found");
      const snapshot = JSON.parse(historical.snapshot_json);
      if (snapshot.lifecycle_state === "suppressed") throw new Error("restore_version_suppressed");
      if (pending) db.prepare(`UPDATE local_memory_retention_queue SET reason='keep',purge_after=NULL,content_hash=?
        WHERE tenant_id=? AND memory_id=?`).run(snapshot.content_hash, tenantId, memoryId);
      return {
        ...current, ...snapshot, id: current.id, tenant_id: current.tenant_id,
        source: current.source, external_key: current.external_key, created_at: current.created_at,
        project_id: current.project_id, scope_type: current.scope_type, scope_key: current.scope_key,
        permissions: current.permissions, owner_principal: current.owner_principal,
        lifecycle_state: "active", actor_type: "principal", actor_id: reviewer
      };
    });
  }

  async reportMemoryFeedback(input) {
    await this.init();
    const tenantId = nullableString(input.tenant_id, 128) || "default";
    const memoryId = nullableString(input.memory_id, 128);
    const version = Number(input.memory_version);
    const reporter = nullableString(input.reporter_principal, 128);
    const reason = nullableString(input.reason, 1000);
    if (!memoryId || !Number.isInteger(version) || version < 1 || !reporter || !reason
      || !["stale", "wrong"].includes(input.kind)) throw new Error("invalid_memory_feedback");
    const evidence = Array.isArray(input.evidence) ? input.evidence.slice(0, 16).map((item) => ({
      type: nullableString(item?.type, 32), ref: nullableString(item?.ref, 256)
    })).filter((item) => item.type && item.ref) : [];
    if (evidence.length === 0) throw new Error("memory_feedback_evidence_required");
    if (!screenSensitiveMemory(JSON.stringify({ reason, evidence })).allowed) throw new Error("sensitive_memory_denied");
    const db = this.open();
    try {
      const memory = db.prepare("SELECT current_version FROM memories WHERE tenant_id = ? AND id = ?").get(tenantId, memoryId);
      const historical = db.prepare("SELECT 1 FROM memory_versions WHERE tenant_id = ? AND memory_id = ? AND version = ?")
        .get(tenantId, memoryId, version);
      if (!memory || (Number(memory.current_version) !== version && !historical)) throw new Error("memory_version_not_found");
      const report = { id: randomUUID(), tenant_id: tenantId, memory_id: memoryId, memory_version: version,
        kind: input.kind, reason, evidence, reporter_principal: reporter, status: "reported", created_at: Date.now() };
      db.prepare(`INSERT INTO memory_quality_feedback(id,tenant_id,memory_id,memory_version,kind,reason,evidence_json,reporter_principal,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(report.id, tenantId, memoryId, version, report.kind, reason,
        JSON.stringify(evidence), reporter, report.status, report.created_at);
      return report;
    } finally { db.close(); }
  }

  async reviewMemoryFeedback(input) {
    await this.init();
    const tenantId = nullableString(input.tenant_id, 128) || "default";
    const reviewer = nullableString(input.reviewer_principal, 128);
    if (!reviewer || !["confirm", "reject"].includes(input.decision)) throw new Error("invalid_memory_feedback_review");
    const db = this.open();
    let feedback;
    try {
      feedback = db.prepare("SELECT * FROM memory_quality_feedback WHERE tenant_id = ? AND id = ?")
        .get(tenantId, input.feedback_id);
      if (!feedback || feedback.status !== "reported") throw new Error("memory_feedback_not_reported");
      const memory = db.prepare("SELECT owner_principal, actor_id, current_version FROM memories WHERE tenant_id = ? AND id = ?")
        .get(tenantId, feedback.memory_id);
      if (!memory) throw new Error("memory_not_found");
      if (reviewer !== (memory.owner_principal || memory.actor_id || "local")) throw new Error("reviewer_not_authorized");
      const status = input.decision === "confirm" ? "confirmed" : "rejected";
      const reviewedAt = Date.now();
      if (status === "confirmed" && feedback.kind === "wrong" && Number(memory.current_version) === feedback.memory_version) {
        // A failed suppression must leave the report pending for a safe retry.
        await this.mutate(tenantId, feedback.memory_id, "suppress", (current) => ({
          ...current, lifecycle_state: "suppressed", actor_type: "principal", actor_id: reviewer
        }));
      }
      db.prepare("UPDATE memory_quality_feedback SET status = ?, reviewer_principal = ?, reviewed_at = ? WHERE tenant_id = ? AND id = ?")
        .run(status, reviewer, reviewedAt, tenantId, feedback.id);
      feedback = { ...feedback, status, reviewer_principal: reviewer, reviewed_at: reviewedAt };
      return feedback;
    } finally { db.close(); }
  }

  async proposeMemoryRelation(input) {
    await this.init();
    const tenantId = nullableString(input.tenant_id, 128) || "default";
    const fromId = nullableString(input.from_memory_id, 128);
    const toId = nullableString(input.to_memory_id, 128);
    const fromVersion = Number(input.from_version);
    const toVersion = Number(input.to_version);
    const proposer = nullableString(input.proposer_principal, 128);
    if (!fromId || !toId || fromId === toId || !Number.isInteger(fromVersion) || !Number.isInteger(toVersion)
      || fromVersion < 1 || toVersion < 1 || !proposer || !["contradicts", "fixes"].includes(input.relation)) {
      throw new Error("invalid_memory_relation");
    }
    const evidence = Array.isArray(input.evidence) ? input.evidence.slice(0, 16).map((item) => ({
      type: nullableString(item?.type, 32), ref: nullableString(item?.ref, 256)
    })).filter((item) => item.type && item.ref) : [];
    if (evidence.length === 0) throw new Error("memory_relation_evidence_required");
    if (!screenSensitiveMemory(JSON.stringify(evidence)).allowed) throw new Error("sensitive_memory_denied");
    const db = this.open();
    try {
      const rows = [[fromId, fromVersion], [toId, toVersion]].map(([memoryId, version]) => {
        const row = db.prepare("SELECT current_version,project_id FROM memories WHERE tenant_id = ? AND id = ?")
          .get(tenantId, memoryId);
        if (!row || Number(row.current_version) !== version) throw new Error("memory_version_not_found");
        return row;
      });
      if (rows[0].project_id !== rows[1].project_id) throw new Error("relation_scope_or_version_mismatch");
      const relation = { id: randomUUID(), tenant_id: tenantId, from_memory_id: fromId, from_version: fromVersion,
        to_memory_id: toId, to_version: toVersion, relation: input.relation, evidence,
        proposer_principal: proposer, status: "proposed", created_at: Date.now() };
      db.prepare(`INSERT INTO memory_integrity_relations(id,tenant_id,from_memory_id,from_version,to_memory_id,to_version,relation,evidence_json,proposer_principal,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(relation.id, tenantId, fromId, fromVersion, toId, toVersion,
        relation.relation, JSON.stringify(evidence), proposer, relation.status, relation.created_at);
      return relation;
    } finally { db.close(); }
  }

  async reviewMemoryRelation(input) {
    await this.init();
    const tenantId = nullableString(input.tenant_id, 128) || "default";
    const reviewer = nullableString(input.reviewer_principal, 128);
    if (!reviewer || !["confirm", "reject", "resolve"].includes(input.decision)) throw new Error("invalid_memory_relation_review");
    const db = this.open();
    try {
      const relation = db.prepare("SELECT * FROM memory_integrity_relations WHERE tenant_id = ? AND id = ?")
        .get(tenantId, input.relation_id);
      if (!relation) throw new Error("memory_relation_not_found");
      const owners = db.prepare("SELECT owner_principal, actor_id FROM memories WHERE tenant_id = ? AND id IN (?,?)")
        .all(tenantId, relation.from_memory_id, relation.to_memory_id);
      if (owners.length !== 2 || owners.some((row) => reviewer !== (row.owner_principal || row.actor_id || "local"))) {
        throw new Error("reviewer_not_authorized");
      }
      if (input.decision === "resolve" ? relation.status !== "confirmed" : relation.status !== "proposed") {
        throw new Error("memory_relation_invalid_state");
      }
      if (input.decision === "confirm") {
        const current = db.prepare("SELECT id,current_version FROM memories WHERE tenant_id=? AND id IN (?,?)")
          .all(tenantId, relation.from_memory_id, relation.to_memory_id);
        if (current.length !== 2 || current.some((row) => Number(row.current_version) !== Number(
          row.id === relation.from_memory_id ? relation.from_version : relation.to_version
        ))) throw new Error("relation_version_changed");
      }
      const status = input.decision === "resolve" ? "resolved" : input.decision === "confirm" ? "confirmed" : "rejected";
      const now = Date.now();
      db.prepare("UPDATE memory_integrity_relations SET status = ?, reviewer_principal = ?, reviewed_at = ?, resolved_at = ? WHERE tenant_id = ? AND id = ?")
        .run(status, reviewer, now, status === "resolved" ? now : null, tenantId, relation.id);
      return { ...relation, status, reviewer_principal: reviewer, reviewed_at: now };
    } finally { db.close(); }
  }

  async listMemoryIntegrityIssues(tenantId, projectId = null) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const feedback = db.prepare(`SELECT f.id,f.memory_id,f.memory_version,f.kind,f.status,f.created_at
        FROM memory_quality_feedback f JOIN memories m ON m.tenant_id=f.tenant_id AND m.id=f.memory_id
        WHERE f.tenant_id=? AND (f.status='reported' OR (f.status='confirmed' AND f.kind='stale'))
          AND m.current_version=f.memory_version
          AND (? IS NULL OR m.project_id=?)`).all(tenantId, projectId, projectId);
      const contradictions = db.prepare(`SELECT r.id,r.from_memory_id,r.to_memory_id,r.relation,r.status,r.created_at FROM memory_integrity_relations r
        JOIN memories a ON a.tenant_id = r.tenant_id AND a.id = r.from_memory_id
        JOIN memories b ON b.tenant_id = r.tenant_id AND b.id = r.to_memory_id
        WHERE r.tenant_id = ? AND r.status = 'confirmed' AND r.relation = 'contradicts'
          AND a.current_version = r.from_version AND b.current_version = r.to_version
          AND (? IS NULL OR (a.project_id = ? AND b.project_id = ?))`).all(tenantId, projectId, projectId, projectId);
      return { feedback, contradictions };
    } finally { db.close(); }
  }

  async planEpisodicAging(tenantId = "default", projectId = null, now = Date.now()) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const rows = db.prepare(`SELECT m.id,m.kind,m.lifecycle_state,m.current_version,m.created_at,m.deleted_at,
          m.expires_at,m.valid_until,
          COALESCE((SELECT p.legal_hold FROM retention_policies p WHERE p.tenant_id=m.tenant_id
            AND (p.project_id=m.project_id OR p.project_id IS NULL) ORDER BY (p.project_id IS NOT NULL) DESC LIMIT 1),0) AS legal_hold,
          (SELECT MAX(e.created_at) FROM memory_use_contexts c
            JOIN memory_use_evaluations e ON e.tenant_id=c.tenant_id AND e.context_id=c.id
            WHERE c.tenant_id=m.tenant_id AND c.source_type='memory' AND c.source_id=m.id
              AND c.source_version=m.current_version AND c.revoked_at IS NULL
              AND c.verification_state='verified' AND e.verification_state='verified'
              AND e.outcome IN ('positive','negative')
              AND NOT EXISTS(SELECT 1 FROM memory_use_contexts newer WHERE newer.tenant_id=c.tenant_id AND newer.supersedes_id=c.id)
              AND NOT EXISTS(SELECT 1 FROM memory_use_evaluations newer WHERE newer.tenant_id=e.tenant_id AND newer.supersedes_id=e.id)) AS last_verified_use_at,
          (EXISTS(SELECT 1 FROM memory_quality_feedback f WHERE f.tenant_id=m.tenant_id AND f.memory_id=m.id
            AND f.memory_version=m.current_version AND f.status IN ('reported','confirmed'))
           OR EXISTS(SELECT 1 FROM memory_integrity_relations r WHERE r.tenant_id=m.tenant_id AND r.status='confirmed'
             AND r.relation='contradicts' AND ((r.from_memory_id=m.id AND r.from_version=m.current_version)
               OR (r.to_memory_id=m.id AND r.to_version=m.current_version)))) AS unresolved_integrity
        FROM memories m WHERE m.tenant_id=? AND (? IS NULL OR m.project_id=?) ORDER BY m.id`)
        .all(tenantId, projectId, projectId);
      return planEpisodicAging(rows, { now });
    } finally { db.close(); }
  }

  async delete(tenantId, memoryId, actor = {}, { guard = null } = {}) {
    await this.init();
    const db = this.open();
    try {
      db.exec("PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
      try {
        const current = db.prepare("SELECT * FROM memories WHERE tenant_id = ? AND id = ?").get(tenantId, memoryId);
        if (guard && (!current || !guard(db, current))) {
          db.exec("COMMIT");
          return { operation: "skipped" };
        }
        if (!current) throw new Error(`memory not found: ${memoryId}`);
        const version = Number(current.current_version || 1) + 1;
        db.prepare(
          "INSERT INTO memory_deletions(id, tenant_id, memory_id, actor_type, actor_id, deleted_at) VALUES(?,?,?,?,?,?)"
        ).run(randomUUID(), tenantId, memoryId, actor.actor_type ?? null, actor.actor_id ?? null, Date.now());
        eraseLocalMemory(db, tenantId, memoryId);
        compactErasedSearchIndexes(db, tenantId === "all");
        db.exec("COMMIT");
        return { memory_id: memoryId, version, operation: "delete", created: false };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  normalizeRecord(input, fallback = null) {
    return normalizeRecord(input, fallback);
  }

  writeRecord(db, record, exists, updateFeatureStats = true, writeProjections = true) {
    return writeRecord(db, record, exists, updateFeatureStats, writeProjections);
  }

  writeVersion(db, record, operation) {
    return writeVersion(db, record, operation);
  }

  async mutate(tenantId, memoryId, operation, transform) {
    await this.init();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT * FROM memories WHERE tenant_id = ? AND id = ?").get(tenantId, memoryId);
        if (!row) throw new Error(`memory not found: ${memoryId}`);
        const current = memoryFromRow(row);
        const record = this.normalizeRecord(
          {
            ...transform(current, db),
            updated_at: Date.now(),
            current_version: current.current_version + 1
          },
          current
        );
        validateBusinessClassification(db, tenantId, record.business_category_id, record.work_type);
        this.writeRecord(db, record, true);
        this.writeVersion(db, record, operation);
        db.exec("COMMIT");
        return { memory_id: memoryId, version: record.current_version, operation, created: false };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  async get(tenantId, memoryId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return memoryFromRow(db.prepare("SELECT * FROM memories WHERE tenant_id = ? AND id = ?").get(tenantId, memoryId));
    } finally {
      db.close();
    }
  }

  async getMemoryDetail({tenant_id:tenantId="default", target_tenant_id:targetTenantId, memory_id:memoryId, expected_version:expectedVersion,
    principal_id:principalId=null, project_id:projectId=null, business_category_id:categoryId=null, work_type:workType=null} = {}) {
    const unavailable = () => { throw new Error("memory_detail_unavailable"); };
    if (typeof memoryId !== "string" || !memoryId.trim() || !Number.isInteger(expectedVersion) || expectedVersion < 1
      || typeof tenantId !== "string" || !tenantId.trim()
      || [principalId,projectId,categoryId,workType].some(value => value !== null && typeof value !== "string")) return unavailable();
    if (targetTenantId !== undefined && targetTenantId !== "all") return unavailable();
    const memory = await this.get(targetTenantId ?? tenantId, memoryId);
    const at = Date.now();
    if (!memory || (memory.tenant_id === "all" && !isPublicLocalMemory(memory)) || memory.current_version !== expectedVersion || memory.lifecycle_state !== "active"
      || (memory.permissions?.length && !principalId) || !canReadMemory(memory, principalId)
      || (projectId && memory.project_id != null && memory.project_id !== projectId)
      || (categoryId && memory.business_category_id !== categoryId)
      || (workType && memory.work_type !== workType && memory.work_type !== "other")
      || (memory.valid_from != null && memory.valid_from > at)
      || (memory.valid_until != null && memory.valid_until <= at)
      || (memory.expires_at != null && memory.expires_at <= at)) return unavailable();
    return {memory};
  }

  async getVersionByExternalKey({ tenant_id: tenantId = "default", source, external_key: externalKey, version = null }) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const current = db.prepare(
        "SELECT id, current_version FROM memories WHERE tenant_id = ? AND source = ? AND external_key = ?"
      ).get(tenantId, source, externalKey);
      if (!current) throw new Error("memory_not_found");
      const requestedVersion = version ?? Number(current.current_version);
      const historical = db.prepare(
        `SELECT version, operation, snapshot_json, content_hash, created_at
         FROM memory_versions
         WHERE tenant_id = ? AND memory_id = ? AND version = ?`
      ).get(tenantId, current.id, requestedVersion);
      if (!historical) throw new Error("memory_version_not_found");
      return {
        tenant_id: tenantId,
        source,
        external_key: externalKey,
        memory_id: current.id,
        version: Number(historical.version),
        current_version: Number(current.current_version),
        is_current: Number(historical.version) === Number(current.current_version),
        operation: historical.operation,
        content_hash: historical.content_hash,
        created_at: historical.created_at,
        memory: JSON.parse(historical.snapshot_json)
      };
    } finally {
      db.close();
    }
  }

  async syncMemoryUse({apiBase, apiKey, limit=50, tenantId='default', attestationKey=process.env.ORGBRAIN_USE_ATTESTATION_KEY, fetchImpl=fetch}={}) {
    await this.init();
    const db=this.open();
    try {
      if (!localUseFlags(db).sync) throw new Error('memory_use_sync_disabled');
      if (!apiBase || !apiKey) throw new Error('memory_use_sync_credentials_required');
      const url=new URL('/v1/memory-use-contexts',apiBase);
      if (url.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('memory_use_sync_https_required');
      if (!Number.isInteger(limit)||limit<1||limit>100) throw new Error('invalid_use_limit');
      const rows=db.prepare(`SELECT * FROM memory_use_outbox WHERE tenant_id=? AND status='pending'
        ORDER BY (error IS NOT NULL),COALESCE(json_extract(payload_json,'$._local_last_attempt_at'),0),created_at,id LIMIT ?`).all(tenantId,limit);
      let sent=0,failed=0;
      for (const row of rows) {
        const attemptedAt=Date.now();
        try {
          const {_local_last_attempt_at:_retryState,...request}=JSON.parse(row.payload_json);
          const payload={...request,tenant_id:tenantId};
          if (attestationKey && payload.evidence) {
            payload.evidence=await Promise.all(payload.evidence.map(async evidence=>{
              if(evidence.ref_type!=='local_event') return evidence;
              const proof=db.prepare('SELECT * FROM local_use_proofs WHERE tenant_id=? AND id=? AND revoked_at IS NULL').get(tenantId,evidence.ref_id);
              if(!proof) return evidence;
              const {revoked_at:_revoked,...signed}=proof;
              return {...evidence,ref_type:'local_attestation',ref_id:await signMemoryUseAttestation({...signed,expires_at:proof.created_at+90*86400000},attestationKey)};
            }));
          }
          // Preserve the exact signed request across retries and key rotation.
          const prepared = db.prepare("UPDATE memory_use_outbox SET payload_json=? WHERE id=? AND tenant_id=? AND status='pending'")
            .run(JSON.stringify({...payload,_local_last_attempt_at:attemptedAt}),row.id,tenantId);
          if (!prepared.changes) continue;
          if(!payload.operation && payload.usage_item_id) {
            const usage=db.prepare('SELECT e.* FROM memory_usage_events e JOIN memory_usage_items i ON i.tenant_id=e.tenant_id AND i.usage_event_id=e.id WHERE i.tenant_id=? AND i.id=?').get(tenantId,payload.usage_item_id);
            if(usage) {
              const items=db.prepare('SELECT id,source_type,source_id,source_version,source_tenant_id,rank,score,reference_type,injected_token_estimate FROM memory_usage_items WHERE tenant_id=? AND usage_event_id=? ORDER BY rank,id').all(tenantId,usage.id);
              const usagePayload={id:usage.id,tenant_id:tenantId,project_id:usage.project_id,task_id:usage.task_id,trace_id:usage.trace_id,capability:usage.capability,access_path:usage.access_path,request_source:'local',requested_work_type:usage.requested_work_type,created_at:usage.created_at,items};
              const prerequisite=await fetchImpl(new URL('/v1/memory-usages',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-api-key':apiKey},body:JSON.stringify(usagePayload)});
              if(!prerequisite.ok) throw new Error(`http_${prerequisite.status}`);
              const receipt=await prerequisite.json();
              if((receipt.usage_id??receipt.data?.usage_id)!==usage.id) throw new Error('invalid_usage_sync_receipt');
            }
          }
          if (!db.prepare("SELECT 1 FROM memory_use_outbox WHERE id=? AND tenant_id=? AND status='pending'").get(row.id,tenantId)) continue;
          const target=payload.operation==='revoke'?new URL(`/v1/memory-use-contexts/${encodeURIComponent(payload.id)}/revoke`,url):payload.operation==='evaluate'?new URL('/v1/memory-use-evaluations',url):url;
          const response=await fetchImpl(target,{method:'POST' ,redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-api-key':apiKey},body:JSON.stringify(payload)});
          if (!response.ok) throw new Error(`http_${response.status}`);
          const receipt=await response.json();
          if ((receipt.id??receipt.data?.id)!==payload.id) throw new Error('invalid_sync_receipt');
          db.prepare("UPDATE memory_use_outbox SET status='sent',error=NULL WHERE id=? AND tenant_id=?").run(row.id,tenantId);sent++;
        } catch(error) {
          const code=/^http_[0-9]+$/.test(error.message)?error.message:'sync_failed';
          db.prepare(`UPDATE memory_use_outbox SET error=?,payload_json=json_set(payload_json,'$._local_last_attempt_at',?)
            WHERE id=? AND tenant_id=?`).run(code,attemptedAt,row.id,tenantId);failed++;
        }
      }
      return {sent,failed,remaining:db.prepare("SELECT count(*) AS n FROM memory_use_outbox WHERE tenant_id=? AND status='pending'").get(tenantId).n};
    } finally {db.close();}
  }

  async useHistory(operation, input = {}) {
    await this.init();
    const db = this.open();
    try {
      if (operation === "configure") return configureLocalUse(db, input);
      const flags = localUseFlags(db);
      if (operation === "status") return { flags, schema_version: MEMORY_SCHEMA_VERSION };
      if (operation === "report") {
        db.exec("BEGIN"); // One snapshot across events, receipts and live proofs.
        return await localUsageReport(db, input);
      }
      if (operation !== "history" && !flags.collect) throw new Error("memory_use_disabled");
      const service = localUseService(db, input.tenant_id || "default", input.principal_id || process.env.ORGBRAIN_USE_PRINCIPAL || "local");
      if (operation === "record") return await service.record(input);
      if (operation === "evaluate") {
        const result=await service.evaluate(input);
        if(flags.sync) {
          const context=db.prepare('SELECT id FROM memory_use_contexts WHERE tenant_id=? AND id=?').get(input.tenant_id||'default',input.context_id);
          if(context) db.prepare("INSERT OR IGNORE INTO memory_use_outbox(id,tenant_id,payload_json,status,created_at) VALUES(?,?,?,'pending',?)").run(`${input.id}:evaluate`,input.tenant_id||'default',JSON.stringify({...input,operation:'evaluate'}),Date.now());
        }
        return result;
      }
      if (operation === "revoke") return await service.revoke(input.id);
      if (operation === "rebuild") return await service.rebuild(input.project_id, input.work_type);
      return await service.history(input);
    } finally { db.close(); }
  }

  #searchDependencies() {
    return {
      openDb: (options) => this.open(options),
      getMemory: (tenantId, memoryId) => this.get(tenantId, memoryId),
      memoryJudge: this.memoryJudge,
      denseEmbeddingProvider: this.denseEmbeddingProvider,
      relevanceSelector: this.relevanceSelector
    };
  }

  async search(input) {
    await this.init();
    return search(input, this.#searchDependencies());
  }

  async searchBase(input) {
    await this.init();
    return searchBase(input, this.#searchDependencies());
  }

  async selectMemorySearchResults(results, options = {}) {
    await this.init();
    return selectMemorySearchResults(results, options, this.#searchDependencies());
  }

  async retrieveContext({
    tenant_id: tenantId,
    project_id: projectId = null,
    business_category_id: businessCategoryId = null,
    work_type: workType = null,
    query,
    top_k = undefined,
    task_id: taskId = null,
    usage_purpose: usagePurpose = 'unclassified',
    use_context: useContext = undefined,
    use_snapshot_id: useSnapshotId = null,
    minimum_total_score: minimumTotalScore = null,
    token_budget = 8_000,
    context_format = "full",
    principal_id: principalId = null,
    at: queryAt = null,
    search_mode: searchMode = "hybrid_v4",
    context_envelope: contextEnvelope = {},
    answer_ux_projection: answerUxProjection = false
  }) {
    const at = queryAt ?? Date.now();
    const safeTokenBudget = Math.max(512, Math.min(16_000, Number(token_budget) || 8_000));
    const safeTopK = Math.max(1, Math.min(50, Number(top_k) || (this.relevanceSelector?.provider === "working-llm" && !answerUxProjection ? 20 : 5)));
    const retrievalMetadata = {};
    const searchInput = {
      tenant_id: tenantId,
      project_id: projectId,
      business_category_id: businessCategoryId,
      work_type: workType,
      query,
      task_id: taskId, use_context: useContext,use_snapshot_id:useSnapshotId,
      minimum_total_score: minimumTotalScore,
      limit: Math.min(50, Math.max(safeTopK * 2, this.relevanceSelector?.candidateLimit ?? 0)),
      principal_id: principalId,
      at,
      search_mode: searchMode,
      retrieval_metadata: retrievalMetadata
    };
    const relevant = (results) => results.filter((result) => {
      const score = result.score;
      return [score?.lexical, score?.semantic, score?.graph, result.use_history?.examples?.length ? result.use_history.base_score : 0]
        .some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
    });
    const initialResults = relevant(await this.search(searchInput));
    const refreshResults = async (results) => {
        const fresh = []; let changed = false;
        for (const result of results) {
          const memory = await this.get(result.memory.tenant_id === "all" ? "all" : tenantId, result.memory.id);
          const currentAt = queryAt ?? Date.now();
          if (!memory || (memory.tenant_id === "all" && !isPublicLocalMemory(memory)) || memory.lifecycle_state !== "active" || !canReadMemory(memory, principalId)
            || (projectId && memory.project_id != null && memory.project_id !== projectId)
            || (businessCategoryId && memory.business_category_id !== businessCategoryId)
            || (workType && memory.work_type !== workType && memory.work_type !== "other")
            || (memory.valid_from != null && memory.valid_from > currentAt)
            || (memory.valid_until != null && memory.valid_until <= currentAt)
            || (memory.expires_at != null && memory.expires_at <= currentAt)) { changed = true; continue; }
          if (JSON.stringify(memoryJudgmentCandidate(memory)) !== JSON.stringify(memoryJudgmentCandidate(result.memory))) changed = true;
          fresh.push({ ...result, memory });
        }
        return { results: fresh, changed };
    };
    const expanded = answerUxProjection || this.relevanceSelector?.provider === "working-llm" ? {results:initialResults, report:{mode:"off"}} : await searchContextWithFollowups({ initialResults, searchInput, context: useContext ?? {}, usagePurpose,
      judge: this.contextSearchJudge, search: async (input) => relevant(await this.search(input)), refresh: refreshResults });
    // A failed/timed-out judgment must not bypass ACL, expiry or version checks.
    const fresh = await refreshResults(expanded.results);
    let results = fresh.results;
    const contextSearch = expanded.report.mode !== "off" ? { ...expanded.report,
      ...(fresh.changed ? { reason_code: "source_changed", coverage: "uncertain" } : {}) } : null;
    const selection = await this.selectMemorySearchResults(results, { tenant_id: tenantId, project_id: projectId,
      business_category_id: businessCategoryId, work_type: workType,
      principal_id: principalId, query, use_context: useContext ?? null, usage_purpose: usagePurpose, at: queryAt,
      apply_selection: false, answer_ux_projection:answerUxProjection });
    if (selection.local_relevance?.status === "pending_host_selection") {
      const usageId = randomUUID();
      const packed = buildWorkingLlmContext({candidates:selection.candidates,topK:safeTopK,tokenBudget:safeTokenBudget,
        at,usageId,sharedSearch:retrievalMetadata.shared_search,localRelevance:selection.local_relevance,envelope:contextEnvelope,contextFormat:context_format});
      await this.recordUsage({id:usageId,tenant_id:tenantId,project_id:projectId,task_id:taskId,usage_purpose:usagePurpose,
        actor_principal:principalId || process.env.ORGBRAIN_USE_PRINCIPAL || "local",capability:"memory_retrieve_context",
        access_path:"context",request_source:"local",requested_business_category_id:businessCategoryId,
        requested_work_type:workType,items:packed.items});
      return packed.response;
    }
    results = selection.results;
    let judgment = selection.memory_judgment;
    if (context_format === "compact") {
      const { buildCompactMemoryContext } = await import("./compact-memory-context.mjs");
      const usageId = randomUUID();
      const protectedIds = judgment.applied ? results.filter(({ memory }) => {
        const candidate = memoryJudgmentCandidate(memory);
        return candidate.protected_reasons.length || candidate.conflicts.length;
      }).map(({ memory }) => memory.id) : [];
      const candidates = judgment.applied ? results.filter(({ memory }) => protectedIds.includes(memory.id)
        || judgment.decisions.find((item) => item.id === memory.id)?.action !== "omit")
        .sort((a, b) => Number(protectedIds.includes(b.memory.id)) - Number(protectedIds.includes(a.memory.id))) : results;
      const packed = buildCompactMemoryContext({ results: candidates, query, topK: safeTopK,
        tokenBudget: safeTokenBudget, at, usageId, verificationSampled: verificationSampled(tenantId, usageId), judgment, protectedIds, contextSearch,
        retrieval: retrievalMetadata, localRelevance: selection.local_relevance, envelope: contextEnvelope });
      await this.recordUsage({ id: usageId, tenant_id: tenantId, project_id: projectId, task_id: taskId,
        usage_purpose: usagePurpose,
        actor_principal: principalId || process.env.ORGBRAIN_USE_PRINCIPAL || "local",
        capability: "memory_retrieve_context", access_path: "context", request_source: "local",
        requested_business_category_id: businessCategoryId, requested_work_type: workType, items: packed.items });
      return packed.response;
    }
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      // Budget in estimated tokens; 200 tokens stay reserved for the answer guidance (it renders at about 135-165 tokens; the old reserve was 600 characters = 150).
      const envelopeTokens = Object.keys(contextEnvelope).length ? estimateJsonTokens(contextEnvelope) : 0;
      const tokenLimit = Math.max(0, safeTokenBudget - 200 - envelopeTokens);
      const decisionById = new Map(judgment.decisions.map((item) => [item.id, item]));
      const protectedResults = results.filter(({ memory }) => {
        const candidate = memoryJudgmentCandidate(memory);
        return candidate.protected_reasons.length || candidate.conflicts.length
          || decisionById.get(memory.id)?.reason_codes?.includes("conflicting_evidence");
      });
      const fullText = (memory) => [memory.content, memory.rationale, memory.reuse_rule].filter(Boolean).join("\n");
      // The whole evidence entry (text and provenance fields) is what gets injected, so its JSON is the charged cost.
      const buildEvidenceEntry = (result, chosen, text) => {
        const memory = result.memory;
        let sourceReference = memory.source_references[0] ?? null;
        try {
          sourceReference = !judgment.applied && chosen?.source_ref_json ? JSON.parse(chosen.source_ref_json) : sourceReference;
        } catch {
          // Preserve the canonical source reference when a projection row is malformed.
        }
        return {
          memory_id: memory.id,
          ...(memory.tenant_id === "all" ? { tenant_id: "all" } : {}),
          text,
          speaker: judgment.applied ? null : chosen?.speaker ?? null,
          session_date: (judgment.applied ? null : chosen?.event_at) ?? sourceReference?.captured_at ?? memory.created_at,
          source_reference: sourceReference,
          source_span: {
            start: judgment.applied ? null : chosen?.source_span_start ?? null,
            end: judgment.applied ? null : chosen?.source_span_end ?? null
          },
          score: result.score.total,
          extraction_state: chosen?.extraction_state ?? "degraded",
          ...(judgment.applied ? { judgment: decisionById.get(memory.id), text_basis: "canonical_memory_with_conditions" } : {})
        };
      };
      // Charged cost of an applied (never truncated) entry: the injected entry only. Its text already carries the content,
      // rationale and reuse rule, and the returned results[].memory is a compact projection reported outside the evidence bundle.
      const appliedCost = (result) => estimateJsonTokens(buildEvidenceEntry(result, null, fullText(result.memory)));
      if (judgment.applied && (protectedResults.length > safeTopK || protectedResults.reduce((sum, item) => sum + appliedCost(item), 0) > tokenLimit)) {
        judgment = { ...judgment, applied: false, status: "fallback", reason_code: "protected_budget_exceeded" };
      }
      const ranked = judgment.applied ? [...protectedResults, ...results.filter((item) => !protectedResults.includes(item))]
        .filter((item) => decisionById.get(item.memory.id)?.action !== "omit") : results;
      const selected = ranked.slice(0, safeTopK);
      let usedTokens = 0;
      // Charged cost per delivered item, computed once and reused for enforcement and reporting.
      const chargedCost = new WeakMap();
      const evidence = [];
      const timeline = [];
      const state = [];
      const conflicts = [];
      for (const result of selected) {
        if (usedTokens >= tokenLimit) break;
        const memory = result.memory;
        const units = db.prepare(
          `SELECT unit_type, speaker, text, event_at, source_ref_json,
                  source_span_start, source_span_end, metadata_json, extraction_state
           FROM retrieval_units
           WHERE generation_id = 'gen_structured_context'
             AND tenant_id = ? AND source_type = 'memory' AND source_id = ?
           ORDER BY
             CASE unit_type
               WHEN 'atomic' THEN 0 WHEN 'profile' THEN 1 WHEN 'timeline' THEN 2
               WHEN 'ledger' THEN 3 ELSE 4
             END,
             event_at DESC
           LIMIT 8`
        ).all(memory.tenant_id, memory.id);
        const versions = db.prepare(
          `SELECT version, operation, snapshot_json, created_at
           FROM memory_versions
           WHERE tenant_id = ? AND memory_id = ?
           ORDER BY version DESC
           LIMIT 4`
        ).all(memory.tenant_id, memory.id);
        const chosen = units.find((unit) =>
          retrievalSubjectQueryTokens(query).some((token) =>
            retrievalQueryTokens(unit.text).includes(token)
          )
        ) ?? units[0];
        const remaining = Math.max(0, tokenLimit - usedTokens);
        let entry;
        let cost;
        if (judgment.applied) {
          entry = buildEvidenceEntry(result, chosen, fullText(memory));
          cost = estimateJsonTokens(entry);
          // Never truncate a condition or an evidence block to squeeze it in.
          if (cost > remaining) continue;
        } else {
          const raw = String(chosen?.text ?? memory.content);
          const excerptLimit = Math.min(remaining - estimateJsonTokens(buildEvidenceEntry(result, chosen, "")), 1_000);
          if (excerptLimit <= 0) continue;
          entry = buildEvidenceEntry(result, chosen, truncateTextToTokens(raw, excerptLimit));
          cost = estimateJsonTokens(entry);
          // JSON escaping can cost more than the plain text estimate; shrink until the whole entry fits.
          for (let limit = excerptLimit; cost > remaining && limit > 0;) {
            limit = Math.min(limit - 1, Math.floor(limit * remaining / cost));
            entry = buildEvidenceEntry(result, chosen, truncateTextToTokens(raw, limit));
            cost = estimateJsonTokens(entry);
          }
          if (cost > remaining) continue;
        }
        usedTokens += cost;
        chargedCost.set(entry, cost);
        evidence.push(entry);
        for (const unit of judgment.applied ? [] : units) {
          let metadata = {};
          try {
            metadata = JSON.parse(unit.metadata_json || "{}");
          } catch {
            metadata = {};
          }
          if (unit.unit_type === "timeline") {
            const entry = {
              memory_id: memory.id,
              event_at: unit.event_at,
              delta_from_question_ms: unit.event_at === null ? null : at - unit.event_at,
              ...metadata
            };
            const cost = estimateJsonTokens(entry);
            if (usedTokens + cost <= tokenLimit) {
              usedTokens += cost;
              chargedCost.set(entry, cost);
              timeline.push(entry);
            }
          }
          if (unit.unit_type === "profile" || unit.unit_type === "ledger") {
            const entry = {
              memory_id: memory.id,
              current: unit.text,
              previous_values: versions.slice(1).flatMap((version) => {
                try {
                  const snapshot = JSON.parse(version.snapshot_json);
                  return snapshot?.content ? [snapshot.content] : [];
                } catch {
                  return [];
                }
              }),
              ...metadata
            };
            const cost = estimateJsonTokens(entry);
            if (usedTokens + cost <= tokenLimit) {
              usedTokens += cost;
              chargedCost.set(entry, cost);
              state.push(entry);
            }
          }
        }
        for (const conflict of memory.conflicts) {
          conflicts.push({ memory_id: memory.id, conflict });
        }
        if (judgment.applied && decisionById.get(memory.id)?.reason_codes?.includes("conflicting_evidence")) {
          conflicts.push({ memory_id: memory.id, conflict: "Jev predicted conflicting evidence; verify both sources before use.", basis: "prediction" });
        }
      }
      const multiEvidence = requiresMultipleEvidenceSources(query);
      const derive = () => {
        const disposition = deriveEvidenceDisposition({
          evidenceCount: evidence.length,
          independentSourceCount: new Set(
            evidence.map((item) => item.source_reference?.ref ?? item.memory_id)
          ).size,
          requiresMultipleSources: multiEvidence,
          conflictCount: conflicts.length,
          hasDegradedExtraction: evidence.some((item) => item.extraction_state !== "ready"),
          hasLowConfidence: selected.some((item) => Number(item.memory.confidence_score ?? 0.5) < 0.5)
            || (judgment.applied && evidence.some((item) => item.judgment?.requires_review)),
          degradedReasons: ["onnx_embedding_not_configured", "cross_encoder_not_configured"]
        });
        const template = evidenceAnswerTemplate(disposition, {
          hasTimeline: timeline.length > 0,
          hasCurrentState: state.length > 0,
          requiresMultipleSources: multiEvidence
        });
        const injectedEvidence = disposition.abstention_recommended ? [] : evidence;
        const injectedState = disposition.abstention_recommended ? [] : state;
        const injectedTimeline = disposition.abstention_recommended ? [] : timeline;
        // Exactly the costs the packer charged against the budget; zero when abstaining or nothing was delivered.
        const injectedPayloadTokens = [...injectedEvidence, ...injectedState, ...injectedTimeline]
          .reduce((sum, item) => sum + (chargedCost.get(item) ?? 0), 0);
        const answerGuidance = answerGuidanceForDisposition(
          disposition,
          injectedEvidence.map((item) => item.source_reference)
        );
        return { disposition, template, injectedEvidence, injectedState, injectedTimeline, injectedPayloadTokens, answerGuidance,
          total: injectedPayloadTokens + estimateTextTokens(answerGuidance.instructions) + envelopeTokens };
      };
      let derived = derive();
      // The guidance embeds up to 3 source refs (500 chars each), so it can outgrow the fixed 200-token reserve.
      // Drop the lowest-priority (last-packed) memory, with its state, timeline and conflicts, until everything fits.
      // With no evidence left the guidance carries no refs and has a fixed small size.
      while (derived.total > safeTokenBudget && evidence.length > 0) {
        const dropped = evidence.pop().memory_id;
        for (const list of [state, timeline, conflicts]) {
          for (let index = list.length - 1; index >= 0; index -= 1) {
            if (list[index].memory_id === dropped) list.splice(index, 1);
          }
        }
        derived = derive();
      }
      const { disposition, template, injectedEvidence, injectedState, injectedTimeline, injectedPayloadTokens, answerGuidance } = derived;
      const usage = await this.recordUsage({
        tenant_id: tenantId,
        project_id: projectId,
        task_id: taskId,
        usage_purpose: usagePurpose,
        actor_principal: principalId || process.env.ORGBRAIN_USE_PRINCIPAL || "local",
        capability: "memory_retrieve_context",
        access_path: "context",
        request_source: "local",
        requested_business_category_id: businessCategoryId,
        requested_work_type: workType,
        items: injectedEvidence.map((item, index) => ({
          source_type: "memory",
          source_id: item.memory_id,
          source_tenant_id: item.tenant_id,
          source_version: selected.find(x=>x.memory.id===item.memory_id)?.memory.current_version ?? null,
          rank: index + 1,
          score: item.score,
          reference_type: "injected",
          used_state: "unknown",
          injected_token_estimate: chargedCost.get(item) ?? estimateJsonTokens(item)
        }))
      });
      const injectedIds = new Set(injectedEvidence.map((item) => item.memory_id));
      return {
        results: selected.filter((item) => injectedIds.has(item.memory.id)).map((item) => ({
          memory: {
            id: item.memory.id,
            ...(item.memory.tenant_id === "all" ? {tenant_id: "all"} : {}),
            project_id: item.memory.project_id,
            summary: item.memory.summary,
            kind: item.memory.kind,
            work_type: item.memory.work_type,
            business_category_id: item.memory.business_category_id,
            lifecycle_state: item.memory.lifecycle_state,
            current_version: item.memory.current_version,
            source_references: item.memory.source_references
          },
          score: item.score
        })),
        meta: {
          shared_search: retrievalMetadata.shared_search,
          ...(selection.local_relevance ? {local_relevance:selection.local_relevance} : {}),
          ...(contextSearch ? { context_search: contextSearch } : {}),
          ...(judgment.mode !== "off" ? { memory_judgment: judgment } : {}),
          usage_id: usage.usage_id,
          usage_item_ids: usage.usage_item_ids,
          usage_items:usage.usage_items,
          verification_sampled: usage.verification_sampled,
          retrieval: {
            generation_id: "gen_structured_context",
            unit_schema_version: "2",
            extractor_name: "local-structured-projector",
            extractor_version: "4",
            ranking_profile_id: "rank_default",
            embedding_profile_id: retrievalMetadata.dense_scored_unit_count > 0 ? retrievalMetadata.dense_provider : "local-sparse-v1",
            ...retrievalMetadata
          }
        },
        evidence_bundle: {
          query_at: at,
          token_budget: safeTokenBudget,
          estimated_tokens: derived.total,
          ...(envelopeTokens ? { token_count_basis: 'evidence_guidance_and_context_envelope' } : {}),
          evidence_status: disposition.evidence_status,
          answer_template: template,
          evidence: injectedEvidence,
          current_state: injectedState,
          timeline: injectedTimeline,
          conflicts,
          missing_evidence: disposition.missing_evidence,
          abstention_recommended: disposition.abstention_recommended,
          degraded_reasons: disposition.degraded_reasons,
          answer_guidance: answerGuidance
        }
      };
    } finally {
      db.close();
    }
  }

  async versions(tenantId, memoryId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare(
        "SELECT snapshot_json FROM memory_versions WHERE tenant_id = ? AND memory_id = ? ORDER BY version ASC"
      ).all(tenantId, memoryId).map((row) => JSON.parse(row.snapshot_json));
    } finally {
      db.close();
    }
  }

  async *export(tenantId = "default", projectId = null) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT * FROM memories
         WHERE tenant_id = ? AND (? IS NULL OR project_id = ?)
         ORDER BY updated_at DESC, id ASC`
      ).all(tenantId, projectId, projectId);
      for (const row of rows) yield memoryFromRow(row);
    } finally {
      db.close();
    }
  }

  async rebuildIndex({ includeLegacyV3 = true } = {}) {
    // Isolated v4 scale runs may skip rebuilding the additive legacy projection;
    // normal maintenance keeps v3 and v4 available for rollback.
    await this.init();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      dropRebuildIndexes(db);
      rebuildFts(db);
      rebuildLocalEmbeddings(db);
      if (includeLegacyV3) rebuildRetrievalUnits(db);
      rebuildRetrievalUnitsV4(db);
      addIndexes(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  async rebuildDenseEmbeddings({
    tenant_id: tenantId = "default",
    project_id: projectId = null,
    memory_ids: memoryIds = null
  } = {}) {
    await this.init();
    if (!this.denseEmbeddingProvider) throw new Error("local_dense_embedding_not_configured");
    const uniqueMemoryIds = Array.isArray(memoryIds)
      ? [...new Set(memoryIds.map((value) => nullableString(value, 128)).filter(Boolean))]
      : null;
    if (Array.isArray(memoryIds) && uniqueMemoryIds.length === 0) {
      return {
        provider: this.denseEmbeddingProvider.provider,
        dimensions: this.denseEmbeddingProvider.dimensions,
        indexed: 0,
        tenant_id: tenantId,
        project_id: projectId
      };
    }
    const db = this.open();
    try {
      const rows = db.prepare(
        `SELECT u.id, u.text
         FROM memory_retrieval_units_v4 u
         JOIN memories m ON m.id = u.memory_id AND m.tenant_id = u.tenant_id
         WHERE u.tenant_id = ?
           AND (? IS NULL OR u.project_id = ?)
           AND m.lifecycle_state != 'suppressed'
           ${uniqueMemoryIds ? `AND u.memory_id IN (${uniqueMemoryIds.map(() => "?").join(",")})` : ""}
         ORDER BY u.id`
      ).all(tenantId, projectId, projectId, ...(uniqueMemoryIds ?? []));
      let indexed = 0;
      for (let offset = 0; offset < rows.length; offset += 16) {
        const batch = rows.slice(offset, offset + 16);
        const vectors = await this.denseEmbeddingProvider.embedDocuments(batch.map((row) => row.text));
        db.exec("BEGIN IMMEDIATE");
        try {
          const upsert = db.prepare(
            `INSERT INTO memory_retrieval_unit_embeddings_v4(
               unit_id, tenant_id, provider, feature_count, vector_format, vector_blob, updated_at
             ) VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(tenant_id, unit_id) DO UPDATE SET
               provider = excluded.provider,
               feature_count = excluded.feature_count,
               vector_format = excluded.vector_format,
               vector_blob = excluded.vector_blob,
               updated_at = excluded.updated_at`
          );
          for (let index = 0; index < batch.length; index += 1) {
            upsert.run(
              batch[index].id,
              tenantId,
              this.denseEmbeddingProvider.provider,
              vectors[index].length,
              "dense-f32",
              encodeFloat32Vector(vectors[index]),
              Date.now()
            );
            indexed += 1;
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      return {
        provider: this.denseEmbeddingProvider.provider,
        dimensions: this.denseEmbeddingProvider.dimensions,
        indexed,
        tenant_id: tenantId,
        project_id: projectId
      };
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  async verify() {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const errors = [];
      const quickCheck = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
      if (quickCheck.length !== 1 || quickCheck[0] !== "ok") errors.push(`quick_check: ${quickCheck.join(", ")}`);
      const rows = db.prepare("SELECT id, content, content_hash FROM memories ORDER BY id").all();
      for (const row of rows) {
        if (hashContent(row.content) !== row.content_hash) errors.push(`content hash mismatch: ${row.id}`);
      }
      const recordCount = rows.length;
      const versionCount = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_versions").get().count);
      const ftsCount = Number(db.prepare("SELECT COUNT(*) AS count FROM memories_fts").get().count);
      const searchableCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM memories WHERE lifecycle_state != 'suppressed'").get().count
      );
      if (ftsCount !== searchableCount) errors.push(`FTS count ${ftsCount} != searchable record count ${searchableCount}`);
      const embeddingCount = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get().count);
      if (embeddingCount !== searchableCount) {
        errors.push(`embedding count ${embeddingCount} != searchable record count ${searchableCount}`);
      }
      const retrievalUnits = db.prepare(
        `SELECT id, text, content_hash
         FROM memory_retrieval_units
         ORDER BY id`
      ).all();
      for (const unit of retrievalUnits) {
        if (hashContent(unit.text) !== unit.content_hash) {
          errors.push(`retrieval unit content hash mismatch: ${unit.id}`);
        }
      }
      const retrievalUnitCount = retrievalUnits.length;
      const retrievalUnitFtsCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_units_fts").get().count
      );
      const retrievalUnitEmbeddingCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_unit_embeddings").get().count
      );
      const retrievalUnitsV4 = db.prepare(
        `SELECT id, text, content_hash
         FROM memory_retrieval_units_v4
         ORDER BY id`
      ).all();
      for (const unit of retrievalUnitsV4) {
        if (hashContent(unit.text) !== unit.content_hash) {
          errors.push(`retrieval v4 unit content hash mismatch: ${unit.id}`);
        }
      }
      const retrievalUnitV4Count = retrievalUnitsV4.length;
      const retrievalUnitV4FtsCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_units_v4_fts").get().count
      );
      const retrievalUnitV4EmbeddingCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_unit_embeddings_v4").get().count
      );
      if (retrievalUnitFtsCount !== retrievalUnitCount) {
        errors.push(
          `retrieval unit FTS count ${retrievalUnitFtsCount} != retrieval unit count ${retrievalUnitCount}`
        );
      }
      if (retrievalUnitEmbeddingCount !== retrievalUnitCount) {
        errors.push(
          `retrieval unit embedding count ${retrievalUnitEmbeddingCount} != retrieval unit count ${retrievalUnitCount}`
        );
      }
      if (retrievalUnitV4FtsCount !== retrievalUnitV4Count) {
        errors.push(
          `retrieval v4 unit FTS count ${retrievalUnitV4FtsCount} != retrieval v4 unit count ${retrievalUnitV4Count}`
        );
      }
      if (retrievalUnitV4EmbeddingCount !== retrievalUnitV4Count) {
        errors.push(
          `retrieval v4 unit embedding count ${retrievalUnitV4EmbeddingCount} != retrieval v4 unit count ${retrievalUnitV4Count}`
        );
      }
      const userVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
      if (userVersion !== MEMORY_SCHEMA_VERSION) errors.push(`schema version ${userVersion} != ${MEMORY_SCHEMA_VERSION}`);
      const activityCount = Number(db.prepare("SELECT COUNT(*) AS count FROM agent_activity_events").get().count);
      const activityContentCount = Number(db.prepare(
        "SELECT COUNT(*) AS count FROM agent_activity_events WHERE content_json IS NOT NULL"
      ).get().count);
      if (activityContentCount > 0) errors.push(`activity content must be null: ${activityContentCount} rows`);
      return {
        ok: errors.length === 0,
        schema_version: userVersion,
        record_count: recordCount,
        version_count: versionCount,
        fts_count: ftsCount,
        embedding_count: embeddingCount,
        embedding_provider: LOCAL_EMBEDDING_PROVIDER,
        retrieval_unit_count: retrievalUnitCount,
        retrieval_unit_fts_count: retrievalUnitFtsCount,
        retrieval_unit_embedding_count: retrievalUnitEmbeddingCount,
        retrieval_unit_digest: stableDigest(retrievalUnits),
        retrieval_unit_v4_count: retrievalUnitV4Count,
        retrieval_unit_v4_fts_count: retrievalUnitV4FtsCount,
        retrieval_unit_v4_embedding_count: retrievalUnitV4EmbeddingCount,
        retrieval_unit_v4_digest: stableDigest(retrievalUnitsV4),
        content_digest: stableDigest(rows),
        activity_event_count: activityCount,
        activity_content_count: activityContentCount,
        errors
      };
    } finally {
      db.close();
    }
  }

  async createBackup(destination) {
    await this.init();
    const target = resolve(destination);
    const targetDirectory = dirname(target);
    const targetDirectoryExisted = existsSync(targetDirectory);
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    if (!targetDirectoryExisted) await chmod(targetDirectory, 0o700);
    const db = this.open();
    try {
      db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    await chmod(target, 0o600);
    return { path: target, ...(await this.verifyBackup(target)) };
  }

  async verifyBackup(path) {
    const target = resolve(path);
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      const check = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
      const schemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
      const rows = hasTable(db, "memories")
        ? db.prepare("SELECT id, content, content_hash FROM memories ORDER BY id").all()
        : [];
      const errors = [];
      for (const row of rows) {
        if (hashContent(row.content) !== row.content_hash) errors.push(`content hash mismatch: ${row.id}`);
      }
      const recordCount = rows.length;
      const ftsCount = hasTable(db, "memories_fts")
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM memories_fts").get().count)
        : 0;
      const searchableCount = hasTable(db, "memories")
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM memories WHERE lifecycle_state != 'suppressed'").get().count)
        : 0;
      if (ftsCount !== searchableCount) errors.push(`FTS count ${ftsCount} != searchable record count ${searchableCount}`);
      const embeddingCount = hasTable(db, "memory_embeddings")
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get().count)
        : 0;
      if (embeddingCount !== searchableCount) {
        errors.push(`embedding count ${embeddingCount} != searchable record count ${searchableCount}`);
      }
      const retrievalUnits = hasTable(db, "memory_retrieval_units")
        ? db.prepare("SELECT id, text, content_hash FROM memory_retrieval_units ORDER BY id").all()
        : [];
      for (const unit of retrievalUnits) {
        if (hashContent(unit.text) !== unit.content_hash) {
          errors.push(`retrieval unit content hash mismatch: ${unit.id}`);
        }
      }
      const retrievalUnitCount = retrievalUnits.length;
      const retrievalUnitFtsCount = hasTable(db, "memory_retrieval_units_fts")
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_units_fts").get().count)
        : 0;
      const retrievalUnitEmbeddingCount = hasTable(db, "memory_retrieval_unit_embeddings")
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_unit_embeddings").get().count)
        : 0;
      if (retrievalUnitFtsCount !== retrievalUnitCount) {
        errors.push(
          `retrieval unit FTS count ${retrievalUnitFtsCount} != retrieval unit count ${retrievalUnitCount}`
        );
      }
      if (retrievalUnitEmbeddingCount !== retrievalUnitCount) {
        errors.push(
          `retrieval unit embedding count ${retrievalUnitEmbeddingCount} != retrieval unit count ${retrievalUnitCount}`
        );
      }
      return {
        ok:
          check.length === 1 &&
          check[0] === "ok" &&
          schemaVersion === MEMORY_SCHEMA_VERSION &&
          errors.length === 0,
        schema_version: schemaVersion,
        record_count: recordCount,
        fts_count: ftsCount,
        embedding_count: embeddingCount,
        embedding_provider: LOCAL_EMBEDDING_PROVIDER,
        retrieval_unit_count: retrievalUnitCount,
        retrieval_unit_fts_count: retrievalUnitFtsCount,
        retrieval_unit_embedding_count: retrievalUnitEmbeddingCount,
        retrieval_unit_digest: stableDigest(retrievalUnits),
        content_digest: stableDigest(rows),
        errors
      };
    } finally {
      db.close();
    }
  }

  async restoreBackup(path) {
    const source = resolve(path);
    const verification = await this.verifyBackup(source);
    if (!verification.ok) throw new Error("backup verification failed");
    const safetyBackup = `${this.dbPath}.pre-restore-${Date.now()}`;
    const staged = `${this.dbPath}.restore-${randomUUID()}`;
    let deletionLedger = [];
    let pendingRevocations = [];
    let current = null;
    try {
      await copyFile(source, staged);
      await chmod(staged, 0o600);
      if (existsSync(this.dbPath)) {
        current = this.open();
        // No purge may commit between reading the ledger and switching the file.
        // DELETE journal mode also keeps an old WAL from being opened on the new file.
        current.prepare("PRAGMA journal_mode=DELETE").get();
        current.exec("PRAGMA locking_mode=EXCLUSIVE");
        current.exec(`VACUUM INTO '${safetyBackup.replaceAll("'", "''")}'`);
        await chmod(safetyBackup, 0o600);
        current.exec("BEGIN EXCLUSIVE");
        if (current.prepare("PRAGMA journal_mode").get().journal_mode !== "delete") throw new Error("restore_requires_exclusive_database");
        if (hasTable(current, "memory_deletions")) {
          deletionLedger = current.prepare(`SELECT id, tenant_id, memory_id, actor_type, actor_id, deleted_at
            FROM memory_deletions ORDER BY deleted_at, id`).all();
        }
        if (hasTable(current, "memory_use_outbox")) {
          pendingRevocations = current.prepare(`SELECT id,tenant_id,created_at,json_extract(payload_json,'$.id') AS context_id
            FROM memory_use_outbox WHERE status='pending' AND json_extract(payload_json,'$.operation')='revoke'
            AND id=json_extract(payload_json,'$.id')||':revoke'`).all();
        }
      }
      const restored = new DatabaseSync(staged, { timeout: DATABASE_BUSY_TIMEOUT_MS });
      try {
        restored.exec("PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
        try {
          const insertDeletion = restored.prepare(
            `INSERT OR IGNORE INTO memory_deletions(
               id, tenant_id, memory_id, actor_type, actor_id, deleted_at
             ) VALUES(?,?,?,?,?,?)`
          );
          for (const deletion of deletionLedger) {
            eraseLocalMemory(restored, deletion.tenant_id, deletion.memory_id);
            insertDeletion.run(deletion.id, deletion.tenant_id, deletion.memory_id,
              deletion.actor_type, deletion.actor_id, deletion.deleted_at);
          }
          if (deletionLedger.length) compactErasedSearchIndexes(restored, deletionLedger.some(row => row.tenant_id === "all"));
          if (pendingRevocations.length) {
            const preserve = restored.prepare(`INSERT OR IGNORE INTO memory_use_outbox(id,tenant_id,payload_json,created_at)
              VALUES(?,?,json_object('operation','revoke','id',?),?)`);
            for (const entry of pendingRevocations) preserve.run(entry.id, entry.tenant_id, entry.context_id, entry.created_at);
          }
          // A restored snapshot cannot reactivate an older retention approval.
          if (hasTable(restored, "local_memory_retention_policy")) {
            restored.exec("UPDATE local_memory_retention_policy SET enabled = 0");
          }
          restored.exec("COMMIT");
        } catch (error) {
          restored.exec("ROLLBACK");
          throw error;
        }
        restored.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
      } finally {
        restored.close();
      }
      if (!(await this.verifyBackup(staged)).ok) throw new Error("restored backup verification failed");
      renameSync(staged, this.dbPath);
    } finally {
      if (current) current.close();
      if (existsSync(staged)) await unlink(staged);
    }
    await this.init();
    return {
      restored: this.dbPath,
      safety_backup: existsSync(safetyBackup) ? safetyBackup : null,
      reapplied_deletions: deletionLedger.length
    };
  }

  async doctor() {
    const verification = await this.verify();
    const directoryMode = await readMode(dirname(this.dbPath));
    const dbMode = await readMode(this.dbPath);
    const errors = [...verification.errors];
    const recoveries = [];
    if (directoryMode !== 0o700) {
      errors.push(`directory mode is ${directoryMode.toString(8)}, expected 700`);
      recoveries.push({
        id: "directory-permissions",
        command: `chmod 700 ${JSON.stringify(dirname(this.dbPath))}`
      });
    }
    if (dbMode !== 0o600) {
      errors.push(`database mode is ${dbMode.toString(8)}, expected 600`);
      recoveries.push({
        id: "database-permissions",
        command: `chmod 600 ${JSON.stringify(this.dbPath)}`
      });
    }
    return {
      ...verification,
      ok: errors.length === 0,
      db_path: this.dbPath,
      directory_mode: directoryMode.toString(8).padStart(3, "0"),
      database_mode: dbMode.toString(8).padStart(3, "0"),
      errors,
      recoveries
    };
  }

  async importLegacy(sourcePath) {
    const source = resolve(sourcePath);
    const before = await this.verify();
    const legacy = new DatabaseSync(source, { readOnly: true });
    try {
      if (!hasTable(legacy, "memories")) throw new Error("source has no memories table");
      const columns = tableColumns(legacy, "memories");
      const rows = legacy.prepare("SELECT * FROM memories ORDER BY id").all();
      for (const row of rows) {
        await this.capture({
          id: row.id,
          tenant_id: columns.has("tenant_id") ? row.tenant_id : "default",
          project_id: row.project_id,
          kind: columns.has("kind") ? row.kind : "episodic",
          lifecycle_state: columns.has("lifecycle_state") ? row.lifecycle_state : "active",
          scope_type: columns.has("scope_type") ? row.scope_type : row.project_id ? "project" : "tenant",
          scope_key: columns.has("scope_key") ? row.scope_key : row.project_id || "default",
          content: row.content,
          summary: row.summary,
          tags: parseJson(row.tags_json),
          entities: columns.has("entities_json") ? parseJson(row.entities_json) : [],
          source: row.source || "legacy",
          source_references: columns.has("source_refs_json") ? parseJson(row.source_refs_json) : [],
          external_key: row.external_key || `legacy:${row.id}`,
          actor_type: columns.has("actor_type") ? row.actor_type : "migration",
          actor_id: columns.has("actor_id") ? row.actor_id : source,
          created_at: row.created_at,
          updated_at: columns.has("updated_at") ? row.updated_at : row.created_at,
          valid_from: columns.has("valid_from") ? row.valid_from : null,
          valid_until: columns.has("valid_until") ? row.valid_until : null,
          confidence_score: columns.has("confidence_score") ? row.confidence_score : null,
          utility_score: columns.has("utility_score") ? row.utility_score : null,
          rationale: columns.has("rationale") ? row.rationale : null,
          reuse_rule: columns.has("reuse_rule") ? row.reuse_rule : null,
          evidence: columns.has("evidence_json") ? parseJson(row.evidence_json) : [],
          conflicts: columns.has("conflicts_json") ? parseJson(row.conflicts_json) : [],
          permissions: columns.has("permissions_json") ? parseJson(row.permissions_json) : []
        });
      }
      const after = await this.verify();
      return {
        source,
        source_count: rows.length,
        before,
        after,
        imported: Math.max(0, after.record_count - before.record_count)
      };
    } finally {
      legacy.close();
    }
  }
}
