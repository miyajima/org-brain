import { it, expect, vi } from 'vitest';
import { memoryD1Fixture } from './fixtures/memory-d1';
vi.mock('../src/memory-search-service', () => ({ searchMemories: vi.fn(), bestEffortMarkMemoryResultsAccessed: vi.fn() }));
import { searchMemories } from '../src/memory-search-service';
import { retrieveMemoryContext } from '../src/memory-context-service';
import { captureMemoryItems, reviseMemory } from '../src/memory-lifecycle-service';
it('omits an ordinary candidate revised after search instead of mislabelling its new projection', async () => { const { env, sql } = memoryD1Fixture(); try {
    const captured = await captureMemoryItems(env, { tenantId: 'fixture', source: 'synthetic', items: [{ external_key: 'ordinary-race', project_id: 'project-a', kind: 'fact', content: 'Synthetic fixture cache policy OLD version.', confidence_score: .9, source_references: [{ type: 'file', ref: 'synthetic:policy', captured_at: 1 }] }] });
    const id = captured.items[0].memory_id;
    vi.mocked(searchMemories).mockResolvedValue({ tenant_id: 'fixture', project_id: 'project-a', q: 'cache policy', results: [{ kind: 'memory', id, score: .9, current_version: 1, content_preview: 'Synthetic fixture cache policy OLD version.', created_at: 1, source_references: [{ ref: 'synthetic:policy' }], conflicts: [], score_breakdown: { lexical: 1 } }], meta: { returned_count: 1, top_result_ids: [id], top_result_ranks: [.9], retrieval: { generation_id: null, ranking_profile_id: 'rank_default', degraded_reasons: [] } } } as never);
    const db = env.OPEN_BRAIN_DB as any;
    const originalPrepare = db.prepare.bind(db);
    let revised = false;
    db.prepare = (query: string) => { const statement = originalPrepare(query); if (!revised && query.includes('FROM memory_retrieval_units_v4')) {
        const originalAll = statement.all.bind(statement);
        statement.all = async () => { revised = true; await reviseMemory(env, { tenantId: 'fixture', memoryId: id, content: 'Synthetic fixture cache policy NEW version.' }); return originalAll(); };
    } return statement; };
    const result = await retrieveMemoryContext(env, { tenant_id: 'fixture', project_id: 'project-a', q: 'cache policy', token_budget: 3000 });
    const evidence = result.evidence_bundle.evidence;
    expect(evidence).toEqual([]);
    expect(result.meta.usage_items).toEqual([]);
    expect(sql.prepare('SELECT COUNT(*) n FROM memory_usage_items WHERE usage_event_id=?').get(result.meta.usage_id).n).toBe(0);
    expect(sql.prepare('SELECT current_version FROM memories WHERE id=?').get(id).current_version).toBe(2);
}
finally {
    sql.close();
} });
it.each(['legacy', 'stale'])('uses current canonical content when %s projection has no matching version anchor', async (state) => {
    const { env, sql } = memoryD1Fixture();
    try {
        const capture = await captureMemoryItems(env, { tenantId: 'fixture', source: 'synthetic', items: [{ external_key: 'anchor', project_id: 'project-a', kind: 'fact',
                    content: 'Fixture cache OLD policy.', confidence_score: 0.9, source_references: [{ type: 'file', ref: 'synthetic:anchor', captured_at: 1 }] }] });
        const id = capture.items[0].memory_id;
        await reviseMemory(env, { tenantId: 'fixture', memoryId: id, content: 'Fixture cache NEW policy.' });
        sql.prepare('UPDATE memory_retrieval_units_v4 SET text=?, metadata_json=? WHERE memory_id=?').run('Unusable OLD projection.', state === 'legacy' ? '{}' : JSON.stringify({ source_memory_id: id, source_version: 1 }), id);
        vi.mocked(searchMemories).mockResolvedValue({ tenant_id: 'fixture', project_id: 'project-a', q: 'cache policy', results: [{ kind: 'memory', id, score: 0.9,
                    current_version: 2, content_preview: 'Old preview must not be trusted.', created_at: 1, source_references: [{ ref: 'synthetic:anchor' }], conflicts: [], score_breakdown: { lexical: 1 } }],
            meta: { returned_count: 1, top_result_ids: [id], top_result_ranks: [0.9], retrieval: { generation_id: null, ranking_profile_id: 'rank_default', degraded_reasons: [] } } } as never);
        const result = await retrieveMemoryContext(env, { tenant_id: 'fixture', project_id: 'project-a', q: 'cache policy', token_budget: 3000 });
        expect(result.evidence_bundle.evidence[0].text).toBe('Fixture cache NEW policy.');
        expect(result.evidence_bundle.evidence[0].extraction_state).toBe('degraded');
        expect(result.meta.usage_items[0].source_version).toBe(2);
    }
    finally {
        sql.close();
    }
});
