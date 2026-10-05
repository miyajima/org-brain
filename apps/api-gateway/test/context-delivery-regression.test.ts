import { it, expect, vi } from 'vitest';
import { memoryD1Fixture } from './fixtures/memory-d1';
import { countContextTokens } from '@org-brain/shared';
vi.mock('../src/memory-search-service', () => ({ searchMemories: vi.fn(), bestEffortMarkMemoryResultsAccessed: vi.fn() }));
vi.mock('../src/agent-loadout-service', () => ({ resolveAgentLoadoutContext: vi.fn() }));
import { searchMemories } from '../src/memory-search-service';
import { resolveAgentLoadoutContext } from '../src/agent-loadout-service';
import { retrieveMemoryContext } from '../src/memory-context-service';
import { createDecisionMemory, confirmDecisionMemory, enrichContext } from '../src/context-engine-service';
async function decision(env: any) { const result = await createDecisionMemory(env, { tenant_id: 'fixture', project_id: 'project-a', title: 'fixture policy', decision: 'Use synthetic fixture policy.', rationale: 'Keep conditions.', constraints: ['Synthetic only.'], source_refs: [{ type: 'official_doc', id: 'fixture-doc' }], confirmation_state: 'user_confirmed', confidence: .8 }); await confirmDecisionMemory(env, 'fixture', result.decisionMemory.id, {}); return result.decisionMemory.id; }
function eligible(sql: any) { sql.prepare("INSERT INTO memory_impact_events(id,tenant_id,project_id,task_id,trace_id,external_run_id,event_type,reporter_principal,idempotency_key,payload_hash,occurred_at,created_at) VALUES('run-event','fixture','project-a','task-a','trace-a','run-a','eligible','fixture','key','hash',1,1)").run(); }
it('uses full decision history count beyond the review display limit', async () => { const { env, sql } = memoryD1Fixture(); try {
    const id = await decision(env);
    const row = sql.prepare('SELECT * FROM decision_memory_versions WHERE decision_memory_id=? LIMIT 1').get(id);
    for (let i = 2; i < 31; i++)
        sql.prepare('INSERT INTO decision_memory_versions(id,decision_memory_id,tenant_id,operation,snapshot_json,created_at) VALUES(?,?,?,?,?,?)').run('extra-' + i, id, 'fixture', 'update', row.snapshot_json, i);
    const result = await enrichContext(env, { tenant_id: 'fixture', project_id: 'project-a', task: { title: 'fixture policy' }, max_tokens: 4000 });
    const actual = sql.prepare('SELECT count(*) n FROM decision_memory_versions WHERE decision_memory_id=?').get(id).n;
    expect(actual).toBe(31);
    expect(result.meta.usage_items![0].source_version).toBe(31);
}
finally {
    sql.close();
} });
it('inherits omitted eligible trace while preserving the task scope', async () => { const { env, sql } = memoryD1Fixture(); try {
    eligible(sql);
    const response = await enrichContext(env, { tenant_id: 'fixture', project_id: 'project-a', task_id: 'task-a', external_run_id: 'run-a', task: { title: 'fixture' }, max_tokens: 2000 });
    expect(sql.prepare('SELECT task_id,trace_id FROM memory_usage_events WHERE id=?').get(response.meta.usage_id)).toMatchObject({ task_id: 'task-a', trace_id: 'trace-a' });
}
finally {
    sql.close();
} });
it('returns completed memory delivery when auxiliary asset bookkeeping fails', async () => { const { env, sql } = memoryD1Fixture(); try {
    await decision(env);
    vi.mocked(resolveAgentLoadoutContext).mockImplementationOnce(async (_env, args: any) => { args.deferUsage([env.OPEN_BRAIN_DB.prepare('INSERT INTO nonexistent_review_table(id) VALUES(1)')]); return { injected_skills: [{ id: 'fixture-skill' }] } as never; });
    const response = await enrichContext(env, { tenant_id: 'fixture', project_id: 'project-a', agent_key: 'fixture-agent', task: { title: 'fixture policy' }, max_tokens: 4000 });
    expect(response.decisionContext).toHaveLength(1);
    const rows = sql.prepare('SELECT source_id,reference_type FROM memory_usage_items').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].reference_type).toBe('injected');
}
finally {
    sql.close();
} });
it('omits an oversized partial answer and returns the fitting covered pair', async () => { const { env, sql } = memoryD1Fixture(); try {
    const q = 'What rollback checks should we use and what cache rules should we use?';
    const texts = ['Rollback checks require a fixture. ' + '停止条件と適用条件を確認する。'.repeat(130), 'Rollback checks require a fixture.', 'Cache rules require a checksum.'];
    const hits = texts.map((text, i) => ({ kind: 'memory', id: 'm' + i, score: .7, content_preview: text, current_version: 1, created_at: 1, source_references: [{ ref: 'fixture:' + i }], conflicts: [], score_breakdown: { lexical: 1 } }));
    for (const [i, text] of texts.entries())
        sql.prepare("INSERT INTO memories(id,tenant_id,project_id,content,summary,source,created_at) VALUES(?,?,?,?,'fixture','fixture',1)").run('m' + i, 'fixture', 'project-a', text);
    const payload = (results: any) => ({ tenant_id: 'fixture', project_id: 'project-a', q, search_mode: 'hybrid_v4', results, meta: { returned_count: results.length, top_result_ids: results.map((x: any) => x.id), top_result_ranks: results.map(() => .7), retrieval: { generation_id: null, ranking_profile_id: 'rank_default', degraded_reasons: [] }, task_query: { applied: true, coverage: 'covered', subject_query: q } } });
    vi.mocked(searchMemories).mockResolvedValueOnce(payload(hits) as never);
    const result = await retrieveMemoryContext(env, { tenant_id: 'fixture', project_id: 'project-a', q, top_k: 3, token_budget: 1600 });
    vi.mocked(searchMemories).mockResolvedValueOnce(payload(hits.slice(1)) as never);
    const small = await retrieveMemoryContext(env, { tenant_id: 'fixture', project_id: 'project-a', q, top_k: 3, token_budget: 1600 });
    expect(result.results.map(item => item.id)).toEqual(['m1', 'm2']);
    expect(small.results).toHaveLength(2);
    expect(countContextTokens(small)).toBeLessThanOrEqual(1600);
}
finally {
    sql.close();
} });
it('binds the delivered content and source version before a concurrent update', async () => { const { env, sql } = memoryD1Fixture(); try {
    const id = await decision(env);
    const database = env.OPEN_BRAIN_DB as any;
    const originalPrepare = database.prepare.bind(database);
    let changed = false;
    database.prepare = (query: string) => { if (!changed && query.includes('SELECT id, NULL AS source_version') && query.includes('FROM decision_memories')) {
        changed = true;
        sql.prepare("UPDATE decision_memories SET decision='NEWER replacement decision' WHERE id=?").run(id);
        const prior = sql.prepare('SELECT snapshot_json FROM decision_memory_versions WHERE decision_memory_id=? ORDER BY created_at DESC LIMIT 1').get(id);
        const snapshot = JSON.parse(prior.snapshot_json);
        snapshot.decision = 'NEWER replacement decision';
        sql.prepare('INSERT INTO decision_memory_versions(id,decision_memory_id,tenant_id,operation,snapshot_json,created_at) VALUES(?,?,?,?,?,?)').run('concurrent-version', id, 'fixture', 'update', JSON.stringify(snapshot), Date.now() + 1000);
    } return originalPrepare(query); };
    const result = await enrichContext(env, { tenant_id: 'fixture', project_id: 'project-a', task: { title: 'fixture policy' }, max_tokens: 4000 });
    expect(result.decisionContext[0].decision).toBe('Use synthetic fixture policy.');
    expect(result.meta.usage_items![0].source_version).toBe(2);
    expect(sql.prepare('SELECT decision FROM decision_memories WHERE id=?').get(id).decision).toBe('NEWER replacement decision');
}
finally {
    sql.close();
} });
