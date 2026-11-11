import { z } from 'zod';
import { countWikiTokens } from './wiki-service.mjs';
import { recallWiki } from './wiki-recall.mjs';

const text = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = text.max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const path = text.max(512).regex(/^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\).*\.md$/);
const scalar = z.union([z.string().max(256), z.number().finite(), z.boolean()]);
const key = text.max(80).regex(/^(?!__proto__$|constructor$|prototype$)[A-Za-z][A-Za-z0-9_.-]*$/);
const condition = z.strictObject({ key, equals: scalar });
const conditions = z.array(condition).max(12);
const aliases = z.array(text.max(120)).max(12);
const reference = /^source:([A-Za-z0-9][A-Za-z0-9._-]*)@([1-9]\d*)#L([1-9]\d*)-L([1-9]\d*)$/;
const evidence = z.strictObject({ ref: text.regex(reference), sha256: hash });
const common = { protocol: z.literal('amp/0.1'), id, revision: z.number().int().min(1), title: text.max(200), aliases };
const memorySchema = z.strictObject({
  ...common, kind: z.literal('memory'), status: z.enum(['draft', 'active', 'superseded']),
  basis: z.enum(['implementation', 'observed_execution', 'reported_execution', 'proposal']),
  claim: text.max(1200), rationale: text.max(800), reuse_when: text.max(600),
  conditions, exceptions: z.array(z.strictObject({ when: conditions.min(1), reason: text.max(400) })).max(8),
  procedure: z.array(text.max(500)).max(12), limitations: z.array(text.max(500)).max(12),
  evidence: z.array(evidence).min(1).max(8),
  event: z.strictObject({ date: text.regex(/^\d{4}-\d{2}-\d{2}$/), environment: text.max(600), outcome: text.max(1200) }).optional(),
});
const indexSchema = z.strictObject({
  ...common, kind: z.literal('index'), question: text.max(300), summary: text.max(600),
  entries: z.array(z.strictObject({ question: text.max(200), aliases, summary: text.max(300),
    memory: z.strictObject({ id, path, hash }) })).min(1).max(12),
});
const documentSchema = z.discriminatedUnion('kind', [indexSchema, memorySchema]);
const inputCommon = { wiki_id: z.literal('personal').optional(), project_id: text.max(256).optional(), token_budget: z.number().int().min(256).max(16000).optional() };
const readingCommon = { ...inputCommon, facts: z.record(key, scalar).optional(), mode: z.enum(['explain', 'apply']).default('explain'), path_prefix: text.max(512).optional() };
const searchSchema = z.strictObject({ ...readingCommon, query: text.max(2000),
  path: path.optional(), limit: z.number().int().min(1).max(20).optional(),
  detail: z.enum(['summary', 'memory', 'evidence']).default('summary'), fallback: z.boolean().default(true) });
const readSchema = z.strictObject({ ...readingCommon, path, expected_hash: hash, include_evidence: z.boolean().default(false) });
const validateSchema = z.strictObject({ ...inputCommon, path: path.optional(), page_id: text.max(256).optional() });

export const AMP_TOOLS = [
  { name: 'orgbrain_wiki_amp_search', description: 'Search AMP/0.1 and stored Wiki originals. Default explain mode returns compact candidates, including reasons a memory does not apply. Follow next_read before answering; detail=memory returns full qualifications, detail=evidence also verifies originals. Apply mode withholds non-applicable records and never uses unvalidated legacy fallback. No model calls or writes.', inputSchema: z.toJSONSchema(searchSchema, { io: 'input' }) },
  { name: 'orgbrain_wiki_amp_read', description: 'Read the selected AMP memory at its expected hash, preserving all conditions and exceptions. include_evidence=true additionally reads and verifies pinned originals. Summary is not sufficient for execution; hash verification is not semantic verification.', inputSchema: z.toJSONSchema(readSchema, { io: 'input' }) },
  { name: 'orgbrain_wiki_amp_validate', description: 'Validate one AMP page, every index target and immutable source pin. Structural and hash checks do not verify meaning or historical execution.', inputSchema: z.toJSONSchema(validateSchema, { io: 'input' }) },
];
export function ampJsonSchema() {
  const schema = z.toJSONSchema(documentSchema);
  const variant = (schema.oneOf ?? schema.anyOf).find(s => s.properties.kind.const === 'memory');
  variant.allOf = [{ if: { properties: { basis: { enum: ['observed_execution', 'reported_execution'] } } }, then: { required: ['event'] } }];
  return schema;
}

export function parseAmpPage(content) {
  if (typeof content !== 'string' || content.length > 64000) throw Error('amp_page_too_large');
  const blocks = [...content.matchAll(/^```amp\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (!blocks.length) throw Error('amp_no_block');
  if (blocks.length !== 1) throw Error('amp_block_required_once');
  let value;
  try { value = JSON.parse(blocks[0][1]); } catch { throw Error('amp_invalid_json'); }
  const result = documentSchema.safeParse(value);
  if (!result.success) throw Error(`amp_invalid_document:${result.error.issues.map(i => i.path.join('.')).join(',')}`);
  const doc = result.data;
  if (doc.kind === 'memory') {
    if (['observed_execution', 'reported_execution'].includes(doc.basis) && !doc.event) throw Error('amp_event_required');
    for (const e of doc.evidence) {
      const [, , version, start, end] = e.ref.match(reference);
      if (![version, start, end].every(n => Number.isSafeInteger(Number(n))) || Number(start) > Number(end)) throw Error('amp_invalid_evidence_range');
    }
  } else if (new Set(doc.entries.map(e => e.memory.id)).size !== doc.entries.length || new Set(doc.entries.map(e => e.memory.path)).size !== doc.entries.length) {
    throw Error('amp_duplicate_entry');
  }
  return doc;
}

function parseInput(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw Error(`amp_invalid_input:${result.error.issues.map(i => i.path.join('.')).join(',')}`);
  return result.data;
}
const normalize = value => value.normalize('NFKC').toLowerCase();
const stopwords = new Set(['は', 'が', 'の', 'に', 'を', 'と', 'で', 'も', 'から', 'まで', 'です', 'ます', 'する', 'なる', 'こと', 'いつ', 'どう', 'どこ', '？', '?']);
function queryTerms(query) {
  const normalized = normalize(query);
  const supplied = normalized.trim().split(/\s+/);
  // Preserve compound keywords explicitly supplied by the caller; segment prose.
  const words = supplied.length > 1 && supplied.every(s => s.length <= 24 && !/[。！？?]/.test(s)) ? supplied :
    [...new Intl.Segmenter('ja', { granularity: 'word' }).segment(normalized)]
      .filter(s => s.isWordLike && !stopwords.has(s.segment)).map(s => s.segment);
  const terms = [...new Set(words)];
  if (!terms.length || terms.length > 64) throw Error('amp_query_terms_out_of_range');
  return terms;
}
const score = (value, terms) => terms.reduce((n, term) => n + Number(normalize(value).includes(term)), 0);

function matches(conditions, facts) {
  const missing = conditions.filter(c => !Object.hasOwn(facts, c.key)).map(c => c.key);
  if (conditions.some(c => Object.hasOwn(facts, c.key) && facts[c.key] !== c.equals)) return { state: false, missing: [] };
  return { state: missing.length ? null : true, missing };
}
function applicability(memory, facts) {
  const required = matches(memory.conditions, facts);
  const except = memory.exceptions.map(e => matches(e.when, facts));
  const missing = [...new Set([...required.missing, ...except.flatMap(e => e.missing)])];
  const mismatches = memory.conditions.filter(c => Object.hasOwn(facts, c.key) && facts[c.key] !== c.equals);
  const exceptions = memory.exceptions.filter((_, i) => except[i].state === true).map(e => e.reason);
  if (mismatches.length || exceptions.length) return { applicability: 'not_applicable', missing_facts: missing,
    reason: mismatches.length ? 'conditions_mismatch' : 'exception_matches', explanation: { conditions: mismatches, exceptions } };
  return { applicability: missing.length ? 'unknown' : 'matched', missing_facts: missing };
}

const memoryText = doc => [doc.title, ...doc.aliases, doc.claim, doc.rationale, doc.reuse_when,
  ...doc.conditions.map(c => `${c.key} ${c.equals}`), ...doc.exceptions.map(e => e.reason), ...doc.procedure, ...doc.limitations,
  ...(doc.event ? Object.values(doc.event) : [])].join(' ');

function nextRead(page, input, include_evidence = false) {
  return { tool: 'orgbrain_wiki_amp_read', arguments: { path: page.path, expected_hash: page.hash,
    mode: input.mode, facts: input.facts ?? {}, include_evidence,
    ...Object.fromEntries(['project_id', 'path_prefix'].filter(k => input[k] !== undefined).map(k => [k, input[k]])) } };
}

async function presentMemory(loaded, input, readEvidence, attempt, via = []) {
  const { page, doc } = loaded, match = applicability(doc, input.facts ?? {});
  if (input.mode === 'apply' && match.reason) return { withheld: match.reason };
  const withEvidence = input.detail === 'evidence' || input.mode === 'apply';
  const evidence = [];
  if (withEvidence) for (const e of doc.evidence) {
    const value = await attempt(e.ref, () => readEvidence(e));
    if (value) evidence.push(value);
  }
  if (withEvidence && evidence.length !== doc.evidence.length) return { withheld: 'evidence_unavailable' };
  const shared = { kind: 'amp', path: page.path, hash: page.hash, ...match,
    evidence_integrity: withEvidence ? 'verified' : 'not_checked' };
  if (input.detail === 'summary') return { ...shared, id: doc.id, title: doc.title,
    summary: doc.claim.slice(0, 200), detail: 'summary', requires_read: true, next_read: nextRead(page, input) };
  return { ...shared, via, memory: doc, detail: withEvidence ? 'evidence' : 'memory', requires_read: false,
    ...(withEvidence ? { evidence } : { next_read: nextRead(page, input, true) }) };
}

function reader(wiki, input, gaps) {
  const pages = new Map(), sources = new Map();
  async function readPage(selector) {
    const cacheKey = selector.path ?? selector.page_id;
    if (pages.has(cacheKey)) return pages.get(cacheKey);
    const promise = (async () => {
      const value = await wiki.request({ op: 'read', wiki_id: 'personal', ...selector, max_chars: 64000 });
      if (input.project_id !== undefined && value.project_id !== input.project_id) throw Error('project_scope_mismatch');
      if (input.path_prefix !== undefined && !value.path.startsWith(input.path_prefix)) throw Error('amp_path_scope_mismatch');
      if (value.truncated) throw Error('amp_page_truncated');
      const doc = parseAmpPage(value.content);
      return { page: value, doc };
    })();
    pages.set(cacheKey, promise);
    return promise;
  }
  async function readEvidence(e) {
    const cacheKey = `${e.ref}:${e.sha256}`;
    if (sources.has(cacheKey)) return sources.get(cacheKey);
    const promise = (async () => {
      const [, source_id, version, start, end] = e.ref.match(reference);
      const result = await wiki.request({ op: 'source_read', wiki_id: 'personal', source_id, version: Number(version), start_line: Number(start), end_line: Number(end), max_chars: 12000 });
      if (result.source_id !== source_id || result.version !== Number(version) || result.hash !== e.sha256) throw Error('evidence_identity_mismatch');
      if (result.truncated || result.start_line !== Number(start) || result.end_line !== Number(end) || !result.text?.trim()) throw Error('evidence_incomplete');
      return { ...e, text: result.text, integrity: 'verified' };
    })();
    sources.set(cacheKey, promise);
    return promise;
  }
  async function attempt(location, action) {
    try { return await action(); } catch (error) {
      if (/feature_disabled|wiki_operation_cancelled|wiki_binding_mismatch/.test(error.message)) throw error;
      // Do not return engine paths or raw parser payloads in retrieval diagnostics.
      const reason = /^(amp_[a-z_]+|page_not_found|page_deleted|project_scope_mismatch|evidence_[a-z_]+|source_not_found|source_corrupt|invalid_line_range)(?::|$)/.exec(error.message)?.[1] ?? 'read_failed';
      gaps.push({ location, reason }); return null;
    }
  }
  return { readPage, readEvidence, attempt };
}

function bounded(result, budget) {
  result.truncated ||= false;
  while (countWikiTokens(result) > budget - 24 && result.results?.length) {
    result.results.pop(); result.truncated = true; result.omitted_results = (result.omitted_results ?? 0) + 1;
  }
  while (countWikiTokens(result) > budget - 24 && result.gaps.length) {
    result.gaps.pop(); result.truncated = true; result.omitted_gaps = (result.omitted_gaps ?? 0) + 1;
  }
  if (countWikiTokens(result) > budget - 24) throw Error('amp_budget_exhausted');
  for (let n = 0; n < 4; n++) result.estimated_tokens = countWikiTokens(result);
  return result;
}

export async function searchAmp(wiki, rawInput) {
  const input = parseInput(searchSchema, rawInput);
  const terms = queryTerms(input.query), gaps = [], ranked = [];
  const { readPage, readEvidence, attempt } = reader(wiki, input, gaps);
  const filters = Object.fromEntries(['project_id', 'path_prefix'].filter(k => input[k] !== undefined).map(k => [k, input[k]]));
  const batches = [];
  for (let i = 0; i < terms.length; i += 8) batches.push(terms.slice(i, i + 8));
  const hits = [], ampPageIds = new Set();
  let truncated = false;
  if (input.path) hits.push({ kind: 'page', owner_id: input.path });
  else for (const batch of batches) {
    const search = await wiki.request({ ...filters, op: 'search', wiki_id: 'personal', scope: 'wiki', query: batch.join(' '), match_mode: 'any', limit: 100, per_owner_limit: 1, max_chars: 1200 });
    hits.push(...(search.hits ?? [])); truncated ||= Boolean(search.truncated);
  }
  const ids = [...new Set(hits.filter(h => h.kind === 'page').map(h => h.owner_id))];
  truncated ||= ids.length > 32;
  const candidates = new Map();
  function candidate(location, pin, rank, loaded) {
    if (!candidates.has(location)) candidates.set(location, { location, pins: [], rank, loaded });
    const item = candidates.get(location);
    if (pin) item.pins.push(pin);
    item.rank = Math.max(item.rank, rank);
    item.loaded ??= loaded;
  }
  for (const pageId of ids.slice(0, 32)) {
    const loaded = await attempt(pageId, () => readPage(input.path ? { path: pageId } : { page_id: pageId }));
    if (!loaded) continue;
    const { doc, page } = loaded;
    ampPageIds.add(page.page_id);
    if (doc.kind === 'memory') candidate(page.path, null, score(memoryText(doc), terms), loaded);
    else for (const entry of doc.entries) {
      const rank = score(`${entry.question} ${entry.aliases.join(' ')} ${entry.summary}`, terms);
      if (rank) candidate(entry.memory.path, { ...entry.memory, index_path: page.path, index_hash: page.hash }, rank);
    }
  }
  // Ordinary, non-AMP pages are expected during discovery, not malformed results.
  if (!input.path) for (let i = gaps.length - 1; i >= 0; i--) if (gaps[i].reason === 'amp_no_block') gaps.splice(i, 1);
  const pool = [...candidates.values()].sort((a, b) => b.rank - a.rank || a.location.localeCompare(b.location));
  if (pool.length > 40) truncated = true;
  for (const candidate of pool.slice(0, 40)) {
    const loaded = candidate.loaded ?? await attempt(candidate.location, () => readPage({ path: candidate.location }));
    if (!loaded) continue;
    const { doc, page } = loaded;
    ampPageIds.add(page.page_id);
    let reason = doc.kind !== 'memory' ? 'index_target_not_memory' :
      candidate.pins.some(p => p.hash !== page.hash) ? 'memory_hash_mismatch' :
      candidate.pins.some(p => p.id !== doc.id) ? 'memory_id_mismatch' :
      doc.status !== 'active' ? 'memory_not_active' : null;
    if (reason) { gaps.push({ location: candidate.location, reason }); continue; }
    const value = await presentMemory(loaded, input, readEvidence, attempt,
      candidate.pins.map(p => ({ path: p.index_path, hash: p.index_hash })));
    if (value.withheld) { gaps.push({ location: candidate.location, reason: value.withheld }); continue; }
    ranked.push({ value, id: doc.id, text: memoryText(doc), primary: [doc.title, ...doc.aliases, doc.claim].join(' ') });
  }
  const duplicates = new Set(ranked.filter((r, i) => ranked.findIndex(p => p.id === r.id) !== i).map(r => r.id));
  for (let i = ranked.length - 1; i >= 0; i--) if (duplicates.has(ranked[i].id)) {
    gaps.push({ location: ranked[i].value.path, reason: 'ambiguous_memory_id' }); ranked.splice(i, 1);
  }
  // Legacy evidence is explanatory material, never an alternative apply-mode admission path.
  const fallback = { used: input.fallback && input.mode === 'explain' && !input.path,
    reason: !input.fallback ? 'disabled' : input.mode === 'apply' ? 'apply_mode' : input.path ? 'explicit_path' : 'same_scope_originals' };
  if (fallback.used) {
    const seen = new Set();
    for (const batch of batches) {
      // A small returned summary must not narrow the underlying discovery window.
      const recalled = await recallWiki(wiki, { ...filters, query: batch.join(' '), limit: input.limit ?? 5, max_chars: 12000 });
      truncated ||= recalled.truncated;
      for (const e of recalled.evidence) {
        // AMP pages must pass the structured checks, not reappear as unvalidated Wiki prose.
        if (seen.has(e.id) || ampPageIds.has(e.page_id) || /```amp\s/.test(e.text)) continue;
        seen.add(e.id);
        // recall excerpts count a trailing newline as an extra display line;
        // the reader's inclusive end line must refer to a real original line.
        const end_line = Math.max(e.start_line, e.end_line - Number(e.text.endsWith('\n')));
        const citation = e.source_id ? `source:${e.source_id}@${e.version}#L${e.start_line}-L${end_line}` : `wiki:${e.page_id}#L${e.start_line}-L${end_line}`;
        const passage = { ...e, id: citation, end_line,
          ...(e.excerpt_ranges ? { excerpt_ranges: e.excerpt_ranges.map(range => ({ ...range, end_line: Math.min(range.end_line, end_line) })) } : {}) };
        const next_read = { tool: e.source_id ? 'orgbrain_wiki_source_read' : 'orgbrain_wiki_read',
          arguments: { wiki_id: 'personal', ...(e.source_id ? { source_id: e.source_id, version: e.version } : { page_id: e.page_id }),
            start_line: e.start_line, end_line } };
        const value = input.detail === 'summary' ? { kind: e.kind, id: citation, title: e.heading ?? citation,
          summary: e.text.slice(0, 200), detail: 'summary', requires_read: true, next_read,
          ...(e.hash ? { expected_source_hash: e.hash } : {}), verification_state: 'legacy_unverified' } :
          { ...passage, detail: 'passage', requires_read: false, next_read, applicability: 'not_assessed' };
        ranked.push({ value, text: e.text, primary: e.text });
      }
    }
  }
  const weights = terms.map(term => Math.log(1 + ranked.length / (1 + ranked.filter(r => normalize(r.text).includes(term)).length)));
  const relevance = r => terms.reduce((n, term, i) => n + weights[i] *
    (normalize(r.primary).includes(term) ? 1 : normalize(r.text).includes(term) ? 0.25 : 0), 0);
  ranked.sort((a, b) => relevance(b) - relevance(a) || Number(b.value.kind === 'amp') - Number(a.value.kind === 'amp') ||
    (a.value.path ?? a.value.id).localeCompare(b.value.path ?? b.value.id));
  const limit = input.limit ?? 5;
  const omitted_results = Math.max(0, ranked.length - limit);
  if (omitted_results) truncated = true;
  return bounded({ protocol: 'amp/0.1', retrieval_version: '0.2', mode: input.mode, detail: input.detail,
    results: ranked.slice(0, limit).map(r => r.value), fallback, gaps, truncated, omitted_results, answer_completeness_verified: false,
    semantic_verification: 'not_performed', writes_performed: false }, input.token_budget ?? 4000);
}

export async function readAmp(wiki, rawInput) {
  const input = parseInput(readSchema, rawInput), gaps = [];
  const { readPage, readEvidence, attempt } = reader(wiki, input, gaps);
  const loaded = await readPage({ path: input.path });
  if (loaded.page.hash !== input.expected_hash) throw Error('amp_memory_changed');
  if (loaded.doc.kind !== 'memory') throw Error('amp_read_requires_memory');
  if (loaded.doc.status !== 'active') throw Error('amp_memory_not_active');
  const value = await presentMemory(loaded, { ...input, detail: input.include_evidence ? 'evidence' : 'memory' }, readEvidence, attempt);
  if (value.withheld) gaps.push({ location: input.path, reason: value.withheld });
  return bounded({ protocol: 'amp/0.1', retrieval_version: '0.2', mode: input.mode, results: value.withheld ? [] : [value], gaps,
    answer_completeness_verified: false, semantic_verification: 'not_performed', writes_performed: false }, input.token_budget ?? 4000);
}

export async function validateAmpPage(wiki, rawInput) {
  const input = parseInput(validateSchema, rawInput);
  if (Boolean(input.path) === Boolean(input.page_id)) throw Error('amp_one_page_selector_required');
  const gaps = [], checked = [];
  const { readPage, readEvidence, attempt } = reader(wiki, input, gaps);
  const checkMemory = async (loaded, pin) => {
    const { page, doc } = loaded;
    if (doc.kind !== 'memory') { gaps.push({ location: page.path, reason: 'index_target_not_memory' }); return; }
    if (pin && (pin.hash !== page.hash || pin.id !== doc.id)) { gaps.push({ location: page.path, reason: 'memory_pin_mismatch' }); return; }
    for (const e of doc.evidence) await attempt(e.ref, () => readEvidence(e));
    checked.push({ path: page.path, hash: page.hash });
  };
  const loaded = await attempt(input.path ?? input.page_id, () => readPage(input.path ? { path: input.path } : { page_id: input.page_id }));
  if (loaded?.doc.kind === 'index') {
    for (const entry of loaded.doc.entries) {
      const target = await attempt(entry.memory.path, () => readPage({ path: entry.memory.path }));
      if (target) await checkMemory(target, entry.memory);
    }
  } else if (loaded) await checkMemory(loaded);
  return bounded({ protocol: 'amp/0.1', valid: gaps.length === 0, checked, gaps,
    semantic_verification: 'not_performed', writes_performed: false }, input.token_budget ?? 4000);
}
