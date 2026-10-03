import { describe, expect, it } from 'vitest';
import { searchMemories } from '../src/memory-search-service';
import { applyNaturalTaskSearch } from '../src/natural-task-search-service';
import { memoryD1Fixture } from './fixtures/memory-d1';
import type { MemorySearchResponse } from '@org-brain/shared';

const empty = (q: string): MemorySearchResponse => ({ tenant_id: 'fixture', project_id: 'project-a', q,
  rewrite_query: false, search_mode: 'hybrid_v4', include_history: false, results: [],
  meta: { search_strategy: 'hybrid_v4', matched_count: 0, returned_count: 0, fallback_used: false, variant_count: 1,
    lexical_result_count: 0, doc_result_count: 0, history_result_count: 0, top_result_ids: [], top_result_ranks: [] } });

function seed(sql: any, id: string, content: string, options: { tenant?: string; project?: string; private?: boolean; stale?: boolean } = {}) {
  const tenant = options.tenant ?? 'fixture', project = options.project ?? 'project-a';
  sql.prepare(`INSERT INTO memories(id,tenant_id,project_id,content,summary,source,created_at,scope_type,owner_principal,valid_until)
    VALUES(?,?,?,?,?,'fixture',1,'tenant','user:owner',?)`).run(id, tenant, project, content, content, options.stale ? 1 : null);
  sql.prepare('INSERT INTO memories_fts(memory_id,tenant_id,content) VALUES(?,?,?)').run(id, tenant, content);
  if (options.private) sql.prepare(`INSERT INTO resource_access_policies(id,tenant_id,resource_type,resource_id,scope,owner_principal,created_by_principal,created_at,updated_at)
    VALUES(?,?,'memory',?,'private','user:other','user:other',1,1)`).run(id, tenant, id);
}

describe('Cloud natural task lane on synthetic migrated D1', () => {
  it('recalls a full-subject lesson in v4 while retaining tenant/project/ACL/validity boundaries', async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      const q = 'What rollback checks should we use in this project?';
      for (let i = 0; i < 60; i++) seed(sql, `private-${i}`, 'Rollback check rules require the scoped fixture.', { private: true });
      seed(sql, 'valid', 'Rollback check rules require the scoped fixture.');
      seed(sql, 'other-tenant', 'Rollback check rules require the scoped fixture.', { tenant: 'other' });
      seed(sql, 'other-project', 'Rollback check rules require the scoped fixture.', { project: 'project-b' });
      seed(sql, 'expired', 'Rollback check rules require the scoped fixture.', { stale: true });
      const result = await applyNaturalTaskSearch(env, empty(q), { principal: 'user:owner', limit: 5, at: Date.now() });
      expect(result.results.map(item => item.id)).toEqual(['valid']);
      expect(result.meta.task_query?.basis).toBe('lexical_relevance');
      const unknown = await applyNaturalTaskSearch(env, empty('What rollback checks and UnicornDatabase rules should we use in this project?'),
        { principal: 'user:owner', limit: 5 });
      expect(unknown.results).toEqual([]);
    } finally { sql.close(); }
  });

  it('keeps every repeated question covered and abstains when the delivery limit loses a clause', async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      seed(sql, 'rollback', 'Rollback checks require a fixture.'); seed(sql, 'cache', 'Cache rules require a checksum.');
      const q = 'What rollback checks should we use and what cache rules should we use?';
      const two = await applyNaturalTaskSearch(env, empty(q), { principal: 'user:owner', limit: 2 });
      expect(new Set(two.results.map(item => item.id))).toEqual(new Set(['rollback', 'cache']));
      expect((await applyNaturalTaskSearch(env, empty(q), { principal: 'user:owner', limit: 1 })).results).toEqual([]);
      sql.prepare('DELETE FROM memories_fts WHERE memory_id=?').run('cache');
      expect((await applyNaturalTaskSearch(env, empty(q), { principal: 'user:owner', limit: 5 })).results).toEqual([]);
    } finally { sql.close(); }
  });

  it('applies the lexical gate through the default v4 gateway before recording the actual returned receipt', async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      env.HYBRID_V4_MODE = 'on';
      seed(sql, 'gateway-lesson', 'Rollback checks require a scoped fixture.');
      const request = { tenant_id: 'fixture', project_id: 'project-a', task_id: 'fixture-task',
        q: 'What rollback checks should we use in this project?', limit: 5 };
      const result = await searchMemories(env, request, { actorPrincipal: 'user:owner' });
      expect(result.search_mode).toBe('hybrid_v4');
      expect(result.results.map(item => item.id)).toEqual(['gateway-lesson']);
      expect(result.meta.task_query?.coverage).toBe('covered');
      expect(sql.prepare('SELECT source_id FROM memory_usage_items').all().map((item: any) => item.source_id)).toEqual(['gateway-lesson']);
      const disallowed = await searchMemories(env, request, { actorPrincipal: 'user:owner', allowedProjectId: 'project-b', recordUsage: false });
      expect(disallowed.results).toEqual([]);
      await expect(searchMemories(env, { ...request, q: request.q + ' subject'.repeat(70) }, { actorPrincipal: 'user:owner' })).rejects.toThrow('without dropping subjects');
    } finally { sql.close(); }
  });

  it('abstains if full-row matches are lost from the delivered preview and safely handles legacy malformed references', async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      seed(sql, 'truncated', 'Boilerplate '.repeat(120) + ' Rollback checks require a fixture.');
      sql.prepare('UPDATE memories SET summary=NULL WHERE id=?').run('truncated');
      const q = 'What rollback checks should we use?';
      const hidden = await applyNaturalTaskSearch(env, empty(q), { principal: 'user:owner', limit: 5 });
      expect(hidden.results).toEqual([]);
      expect(hidden.meta.task_query?.coverage).toBe('missing');
      sql.prepare('DELETE FROM memories_fts WHERE memory_id=?').run('truncated');
      seed(sql, 'legacy', 'Rollback checks require a fixture.');
      sql.prepare('UPDATE memories SET source_refs_json=? WHERE id=?').run('{broken', 'legacy');
      const legacy = await applyNaturalTaskSearch(env, empty(q), { principal: 'user:owner', limit: 5 });
      expect(legacy.results.map(item => item.id)).toEqual(['legacy']);
      expect(legacy.results[0].source_references).toEqual([]);
    } finally { sql.close(); }
  });

  it('leaves ordinary keyword and explicit history retrieval unchanged', async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      const keywords = empty('rollback checksum');
      expect(await applyNaturalTaskSearch(env, keywords, { principal: 'user:owner', limit: 5 })).toBe(keywords);
      const history = { ...empty('What rollback checks should we use?'), include_history: true };
      expect(await applyNaturalTaskSearch(env, history, { principal: 'user:owner', limit: 5 })).toBe(history);
    } finally { sql.close(); }
  });
});
