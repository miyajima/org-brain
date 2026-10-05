import { it, expect, vi } from 'vitest';
import { memoryD1Fixture } from './fixtures/memory-d1';
vi.mock('../src/memory-search-service', () => ({ searchMemories: vi.fn(), bestEffortMarkMemoryResultsAccessed: vi.fn() }));
import { searchMemories } from '../src/memory-search-service';
import { retrieveMemoryContext } from '../src/memory-context-service';
import { captureMemoryItems, reviseMemory } from '../src/memory-lifecycle-service';
it('retains independently stored conditions after a conversation memory content revision', async () => { const { env, sql } = memoryD1Fixture(); try {
    const captured = await captureMemoryItems(env, { tenantId: 'fixture', source: 'conversation-event', items: [{ external_key: 'conversation-condition', project_id: 'p', kind: 'semantic', content: 'Use fixture cache policy.\n理由: It is bounded.\n再利用条件: Never use production inputs.', rationale: 'It is bounded.', reuse_rule: 'Never use production inputs.', learning: { conversation_provenance: { evidence_status: 'supplied_unverified' } }, confidence_score: .9, source_references: [{ type: 'conversation', ref: 'synthetic:conversation' }] }] });
    const id = captured.items[0].memory_id;
    await reviseMemory(env, { tenantId: 'fixture', memoryId: id, content: 'Use the corrected fixture cache policy.' });
    vi.mocked(searchMemories).mockResolvedValue({ tenant_id: 'fixture', project_id: 'p', q: 'cache policy', results: [{ kind: 'memory', id, score: .9, current_version: 2, content_preview: 'Use the corrected fixture cache policy.', created_at: 1, source_references: [{ ref: 'synthetic:conversation' }], conflicts: [], score_breakdown: { lexical: 1 } }], meta: { returned_count: 1, top_result_ids: [id], top_result_ranks: [.9], retrieval: { generation_id: null, degraded_reasons: [] } } } as never);
    const response = await retrieveMemoryContext(env, { tenant_id: 'fixture', project_id: 'p', q: 'cache policy', token_budget: 3000 });
    expect(JSON.stringify(response.evidence_bundle.evidence)).toContain('Never use production inputs.');
}
finally {
    sql.close();
} });
