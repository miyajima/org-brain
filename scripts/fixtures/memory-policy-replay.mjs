// Entirely invented component fixtures. These are not actual conversations or a held-out benchmark.
export const replayScope = Object.freeze({ tenant_id: 'policy-fixture', project_id: 'example-project', principal_id: 'fixture-reader' });
export const replayTime = Date.parse('2026-10-01T12:00:00Z');
const before = replayTime - 86400000;
const memory = (key, content, fields = {}) => ({ kind: 'capture', at: before, key,
  fields: { kind: 'constraint', work_type: 'implementation', content, summary: content,
    confidence_score: 0.95, utility_score: 0.8,
    source_references: [{ type: 'file', ref: `synthetic:policy/${key}.md`, content_hash: 'a'.repeat(64) }], ...fields } });
const attempt = (key, trusted, fields = {}) => ({ kind: 'attempt', at: before, key, trusted,
  fields: { id: key, project_id: replayScope.project_id, action_key: 'fixture:sqlite:parallel',
    action_label: 'Parallel SQLite diagnostics', target: 'fixture shared database',
    conditions: { version: 'v1', database: 'shared' }, outcome: 'failure', failure_kind: 'deterministic',
    result_summary: 'Synthetic SQLite fixture rejected concurrent writes.', performed_at: before,
    executed_by_type: 'agent', executed_by: 'fixture-agent', source: 'synthetic-fixture', source_key: key,
    evidence: [{ ref_type: 'task_event', ref_id: `synthetic:${key}`, content_hash: 'b'.repeat(64) }], ...fields } });
export const policyCases = [
  { id: 'source-priority', query: 'Fixture release approval procedure', events: [
    memory('official', 'Fixture release approval procedure requires two reviewers.', { tags: ['policy'], reuse_rule: 'Applies to production releases of the fixture project.' }),
    { ...memory('chatter', 'Fixture release approval procedure might require one reviewer.', { kind: 'fact', confidence_score: 0.95,
      source_references: [{ type: 'conversation', ref: 'synthetic:unconfirmed-chatter' }] }), at: replayTime - 1000 }
  ], oracle: { preferred: 'official', over: 'chatter', required: ['official'] } },
  { id: 'explicit-correction', query: 'Fixture release approval procedure', events: [
    memory('corrected', 'Fixture release approval procedure requires one reviewer.'),
    { kind: 'revise', at: before + 1000, key: 'corrected', fields: { content: 'Fixture release approval procedure requires two reviewers.', summary: 'Fixture release approval procedure requires two reviewers.', rationale: 'Explicit synthetic human correction replaced the earlier requirement.' } },
    { kind: 'revise', at: replayTime + 1000, key: 'corrected', fields: { content: 'FUTURE_ONLY_731 release procedure requires three reviewers.' } }
  ], oracle: { required: ['corrected'], versions: { corrected: 2 }, forbidden_text: ['requires one reviewer', 'FUTURE_ONLY_731'] } },
  { id: 'applicable-exception', query: 'Fixture SQLite diagnostics database lock', events: [
    memory('conditional', 'Run fixture SQLite diagnostics sequentially to avoid database lock errors.',
      { kind: 'pitfall', rationale: 'Concurrent writers contend on the same database.',
        reuse_rule: 'Only serialize diagnostics sharing one database; independent databases may run concurrently.' })
  ], oracle: { required: ['conditional'], required_text: ['Only serialize diagnostics sharing one database; independent databases may run concurrently.'] } },
  { id: 'retracted-procedure', query: 'Fixture SQLite diagnostics database lock', events: [
    memory('retracted', 'Run fixture SQLite diagnostics sequentially to avoid database lock errors.'),
    { kind: 'suppress', at: before + 1000, key: 'retracted', reason: 'Synthetic owner withdrew this procedure.' }
  ], oracle: { forbidden: ['retracted'] } },
  { id: 'future-source', query: 'Fixture SQLite diagnostics database lock', events: [
    { ...memory('future', 'FUTURE_ONLY_731 fixture SQLite diagnostics database lock solution.'), at: replayTime + 1000 }
  ], oracle: { forbidden: ['future'], forbidden_text: ['FUTURE_ONLY_731'] } },
  { id: 'failure-recurrence', query: 'Fixture SQLite diagnostics database lock', events: [
    attempt('prior-failure', true),
    { ...attempt('future-success', true, { outcome: 'success', failure_kind: undefined,
      result_summary: 'Synthetic later success.', performed_at: replayTime + 1000 }), at: replayTime + 1000 }
  ], action: { project_id: replayScope.project_id, action_key: 'fixture:sqlite:parallel', conditions: { version: 'v1', database: 'shared' } }, oracle: { decision: 'block' } },
  { id: 'changed-condition', query: 'Fixture SQLite diagnostics database lock', events: [attempt('prior-failure', true)],
    action: { project_id: replayScope.project_id, action_key: 'fixture:sqlite:parallel', conditions: { version: 'v2', database: 'shared' }, change_hypothesis: 'The synthetic v2 engine serializes its writers.' }, oracle: { decision: 'allow' } },
  { id: 'reported-failure', query: 'Fixture SQLite diagnostics database lock', events: [attempt('reported-failure', false)],
    action: { project_id: replayScope.project_id, action_key: 'fixture:sqlite:parallel', conditions: { version: 'v1', database: 'shared' } }, oracle: { decision: 'warn' } },
  { id: 'project-boundary', query: 'Fixture release approval procedure', events: [
    memory('other-project', 'Fixture release approval procedure requires two reviewers.', { project_id: 'other-project' })
  ], oracle: { forbidden: ['other-project'] } },
  { id: 'permission-boundary', query: 'Fixture release approval procedure', events: [
    memory('private', 'Fixture release approval procedure requires two reviewers.', { permissions: [{ principal_type: 'principal', principal_id: 'other-reader', permissions: ['read'] }] })
  ], oracle: { forbidden: ['private'] } }
];
