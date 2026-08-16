import { HttpError } from "@org-brain/shared";
import type { Env } from "./types";

type QualityRunRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  corpus_id: string;
  prompt_contract_id: string;
  verifier_version: string;
  judge_profile_id: string | null;
  manifest_hash: string;
  status: "running" | "passed" | "failed" | "insufficient_evidence";
  input_source: "synthetic" | "real";
  ground_truth_basis: string;
  capture_routes_json: string;
  privacy_json: string;
  hard_violation_count: number;
  started_at: number;
  completed_at: number | null;
};

type QualityMeasurementRow = {
  id: string;
  run_id: string;
  axis: string;
  cohort: string;
  numerator: number;
  denominator: number;
  point_estimate: number | null;
  wilson_lower: number | null;
  wilson_upper: number | null;
  hard_violation_count: number;
  created_at: number;
};

type QualityCaseRow = {
  id: string;
  run_id: string;
  case_hash: string;
  session_hash: string | null;
  project_hash: string | null;
  split: string;
  lesson_type: string | null;
  capture_route: string;
  expected_route: string | null;
  actual_route: string;
  candidate_hash: string | null;
  memory_id: string | null;
  candidate_id: string | null;
  reason_codes_json: string;
  hard_violation_count: number;
  parity_mismatch: number;
  created_at: number;
};

const runColumns = `id, tenant_id, project_id, corpus_id, prompt_contract_id, verifier_version,
  judge_profile_id, manifest_hash, status, input_source, ground_truth_basis, capture_routes_json,
  privacy_json, hard_violation_count, started_at, completed_at`;

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function serializeRun(row: QualityRunRow) {
  return {
    ...row,
    capture_routes: parseJson<string[]>(row.capture_routes_json, []),
    privacy: parseJson<Record<string, unknown>>(row.privacy_json, {}),
    capture_routes_json: undefined,
    privacy_json: undefined
  };
}

export async function listMemoryQualityRuns(env: Env, tenantId: string, options: { limit?: number } = {}) {
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT ${runColumns} FROM memory_quality_runs WHERE tenant_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`
  ).bind(tenantId, limit).all<QualityRunRow>();
  return { tenant_id: tenantId, items: rows.results.map(serializeRun), meta: { limit, returned_count: rows.results.length } };
}

export type MemoryQualityRunFilters = {
  route?: string;
  lessonType?: string;
  actualRoute?: string;
  issue?: string;
  projectHash?: string;
  parityMismatch?: boolean;
  limit?: number;
  offset?: number;
};

export async function getMemoryQualityRun(env: Env, tenantId: string, runId: string, filters: MemoryQualityRunFilters = {}) {
  const run = await env.OPEN_BRAIN_DB.prepare(
    `SELECT ${runColumns} FROM memory_quality_runs WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, runId).first<QualityRunRow>();
  if (!run) throw new HttpError(404, "quality_run_not_found", "Memory quality run was not found");
  const measurements = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, run_id, axis, cohort, numerator, denominator, point_estimate, wilson_lower,
      wilson_upper, hard_violation_count, created_at
     FROM memory_quality_measurements WHERE run_id = ? ORDER BY axis, cohort`
  ).bind(runId).all<QualityMeasurementRow>();

  const clauses = ["run_id = ?", "tenant_id = ?"];
  const args: unknown[] = [runId, tenantId];
  const add = (sql: string, value: unknown) => { clauses.push(sql); args.push(value); };
  if (filters.route) add("capture_route = ?", filters.route);
  if (filters.lessonType) add("lesson_type = ?", filters.lessonType);
  if (filters.actualRoute) add("actual_route = ?", filters.actualRoute);
  if (filters.issue) {
    const escapedIssue = filters.issue
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    add("reason_codes_json LIKE ? ESCAPE '\\'", `%${escapedIssue}%`);
  }
  if (filters.projectHash) add("project_hash = ?", filters.projectHash);
  if (filters.parityMismatch !== undefined) add("parity_mismatch = ?", filters.parityMismatch ? 1 : 0);
  const limit = Math.min(200, Math.max(1, filters.limit ?? 100));
  const offset = Math.max(0, filters.offset ?? 0);
  const cases = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, run_id, case_hash, session_hash, project_hash, split, lesson_type, capture_route,
      expected_route, actual_route, candidate_hash, memory_id, candidate_id, reason_codes_json,
      hard_violation_count, parity_mismatch, created_at
     FROM memory_quality_cases WHERE ${clauses.join(" AND ")}
     ORDER BY created_at, id LIMIT ? OFFSET ?`
  ).bind(...args, limit, offset).all<QualityCaseRow>();

  const memoryIds = [...new Set(cases.results
    .filter((item) => item.actual_route !== "excluded" && item.memory_id)
    .map((item) => item.memory_id as string))];
  const summaries = new Map<string, string>();
  if (memoryIds.length > 0) {
    const placeholders = memoryIds.map(() => "?").join(",");
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, summary FROM memories WHERE tenant_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`
    ).bind(tenantId, ...memoryIds).all<{ id: string; summary: string | null }>();
    for (const row of rows.results) if (row.summary) summaries.set(row.id, row.summary.slice(0, 240));
  }

  return {
    tenant_id: tenantId,
    run: serializeRun(run),
    dimensions: measurements.results,
    cases: cases.results.map((item) => {
      const privacySafe = {
        case_hash: item.case_hash,
        actual_route: item.actual_route,
        reason_codes: parseJson<string[]>(item.reason_codes_json, []),
        hard_violation_count: item.hard_violation_count,
        parity_mismatch: item.parity_mismatch === 1
      };
      if (item.actual_route === "excluded") return privacySafe;
      return {
        ...privacySafe,
        id: item.id,
        run_id: item.run_id,
        session_hash: item.session_hash,
        project_hash: item.project_hash,
        split: item.split,
        lesson_type: item.lesson_type,
        capture_route: item.capture_route,
        expected_route: item.expected_route,
        candidate_hash: item.candidate_hash,
        memory_id: item.memory_id,
        candidate_id: item.candidate_id,
        created_at: item.created_at,
        summary: item.memory_id ? summaries.get(item.memory_id) ?? null : null
      };
    }),
    meta: { limit, offset, returned_count: cases.results.length }
  };
}
