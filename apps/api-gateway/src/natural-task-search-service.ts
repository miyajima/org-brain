import { localTaskQueryPlan, matchesLocalTaskQuery, coversLocalTaskQuery, memoryReadAccessSql,
  type MemorySearchResponse, type MemorySearchResult, type MemoryReadAccess, type TaskQueryClause } from '@org-brain/shared';
import type { Env } from './types';
import type { MemoryRow } from './memory-service-types';

function readReferences(raw: string | null | undefined): NonNullable<MemorySearchResult['source_references']> {
  try { const value = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
}

const deliveredText = (result: MemorySearchResult) => ({ content: result.content_preview, summary: result.summary });

export function isResumeInstruction(query: string) {
  return /^(?:再開して(?:ください)?|resume(?:\s+(?:this|the)\s+task)?)[。.!！\s]*$/iu.test(query.trim());
}

export function isNaturalTaskQuestion(query: string) {
  return (/^\s*(?:what|which|how|why|when|where)\b/iu.test(query)
    && /\b(?:should|could|can|must|would)\s+(?:i|we|you)\b/iu.test(query))
    || /(?:教えて|確認|調査|説明)(?:して)?ください[。？！?!.\s]*$/u.test(query);
}

// This is bounded lexical relevance, not answerability, a QA decision or verified
// usefulness. Existing v4 ranking remains the base; permissions precede LIMIT.
export async function applyNaturalTaskSearch(env: Env, response: MemorySearchResponse, options: {
  principal: string | null; limit: number; at?: number; readAccess?: MemoryReadAccess;
  taskContext?: unknown; taskId?: string | null; unsupportedContext?: boolean;
  workType?: string | null; businessCategoryId?: string | null; includeSuppressed?: boolean;
}) {
  const resume = isResumeInstruction(response.q);
  if (!resume && (!options.principal || !response.project_id || response.include_history || options.includeSuppressed
    || !isNaturalTaskQuestion(response.q))) return response;
  let subjectQuery = response.q;
  let contextTaskKey: string | undefined;
  if (resume) {
    const context = options.taskContext as { project_id?: unknown; task_key?: unknown; subject_query?: unknown } | null;
    if (!options.principal || !response.project_id || response.include_history || options.includeSuppressed || options.unsupportedContext
      || !context || Array.isArray(context) || Object.keys(context).some(key => !['project_id','task_key','subject_query'].includes(key))
      || context.project_id !== response.project_id || typeof context.task_key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(context.task_key)
      || options.taskId && options.taskId !== context.task_key || typeof context.subject_query !== 'string' || !context.subject_query.trim() || context.subject_query.length>500
      || isResumeInstruction(context.subject_query)) subjectQuery = '';
    else { subjectQuery = context.subject_query; contextTaskKey = context.task_key; }
  }
  const plan = localTaskQueryPlan(subjectQuery);
  const finish = (results: MemorySearchResult[], candidateCount: number, coverage: 'covered' | 'missing' | 'uncertain') => ({
    ...response, results, meta: { ...response.meta, returned_count: results.length, matched_count: candidateCount,
      top_result_ids: results.map(result => result.id), top_result_ranks: results.map(result => result.score),
      task_query: { applied: true as const, basis: 'lexical_relevance' as const, coverage,
        candidate_count: candidateCount, requires_parent_review: true as const,
        ...(resume ? { subject_query: subjectQuery,context_task_key:contextTaskKey,context_basis:'caller_supplied' as const } : {}) } }
  });
  if (!plan || !options.principal || !response.project_id) return finish([], 0, 'uncertain');
  const at = options.at ?? Date.now();
  const filters = ['m.tenant_id = ?', 'memories_fts MATCH ?', 'm.project_id = ?', 'm.deleted_at IS NULL',
    "(m.lifecycle_state IS NULL OR m.lifecycle_state = 'active')", "COALESCE(m.verification_state, 'unverified') != 'rejected'",
    '(m.valid_from IS NULL OR m.valid_from <= ?)', '(m.valid_until IS NULL OR m.valid_until > ?)',
    '(m.expires_at IS NULL OR m.expires_at > ?)',
    "CASE WHEN json_valid(m.conflicts_json) THEN json_array_length(m.conflicts_json) = 0 ELSE m.conflicts_json IS NULL END",
    "(m.tags_json IS NULL OR m.tags_json NOT LIKE '%\"source-drift\"%')",
    memoryReadAccessSql('m', options.readAccess ?? { principal: options.principal })];
  const bindings: unknown[] = [response.tenant_id, plan.fts, response.project_id, at, at, at];
  if (options.workType) { filters.push('m.work_type = ?'); bindings.push(options.workType); }
  if (options.businessCategoryId) { filters.push('m.business_category_id = ?'); bindings.push(options.businessCategoryId); }
  const rows = (await env.OPEN_BRAIN_DB.prepare(`SELECT m.* FROM memories_fts
    JOIN memories m ON m.id = memories_fts.memory_id AND m.tenant_id = memories_fts.tenant_id
    WHERE ${filters.join(' AND ')} ORDER BY bm25(memories_fts), m.id LIMIT 50`).bind(...bindings).all<MemoryRow>()).results
    .filter(row => matchesLocalTaskQuery(row, plan));
  const existing = new Map(response.results.map(result => [result.id, result]));
  const delivered = rows.map(row => existing.get(row.id) ?? { kind: 'memory' as const, id: row.id, summary: row.summary,
    content_preview: row.content.slice(0, 1000), score: null, source: row.source, created_at: row.created_at,
    current_version: row.current_version ?? 1, source_references: readReferences(row.source_refs_json),
    permission_decision: { allowed: true, principal_id: options.principal } })
    .filter(result => matchesLocalTaskQuery(deliveredText(result), plan));
  if (!coversLocalTaskQuery(delivered.map(deliveredText), plan)) return finish([], rows.length, 'missing');
  const byId = new Map(delivered.map(result => [result.id, result]));
  const rankedIds = [...new Set([...response.results.filter(result => result.kind === 'memory' && byId.has(result.id)).map(result => result.id),
    ...delivered.map(result => result.id)])];
  // Reserve a source for each explicit repeated question before packing.
  const requiredIds = plan.clauses.map((clause: TaskQueryClause) => rankedIds.find(id => matchesLocalTaskQuery(deliveredText(byId.get(id)!), clause))!);
  const ids = [...new Set([...requiredIds, ...rankedIds])].slice(0, Math.min(50, options.limit));
  const results = ids.map(id => byId.get(id)!);
  if (!coversLocalTaskQuery(results.map(deliveredText), plan)) return finish([], rows.length, 'missing');
  return finish(results, rows.length, 'covered');
}
