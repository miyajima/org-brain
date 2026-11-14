import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseDocument as parseYamlDocument, stringify as stringifyYaml } from 'yaml';
import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';

let encoder;
export function countAmpTokens(value) {
  encoder ??= new Tiktoken(ranks);
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value, null, 2), [], []).length;
}

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
const status = z.enum(['draft', 'active', 'superseded']);
const basis = z.enum(['implementation', 'observed_execution', 'reported_execution', 'proposal']);
const exceptions = z.array(z.strictObject({ when: conditions.min(1), reason: text.max(400) })).max(8);
const notes = z.array(text.max(500)).max(12);
const event = z.strictObject({ date: text.regex(/^\d{4}-\d{2}-\d{2}$/), environment: text.max(600), outcome: text.max(1200) }).optional();
// amp/0.1: every field is explicit, and indexes pin each memory's ID and page hash.
const common = { protocol: z.literal('amp/0.1'), id, revision: z.number().int().min(1), title: text.max(200), aliases };
const memorySchema = z.strictObject({
  ...common, kind: z.literal('memory'), status, basis,
  claim: text.max(1200), rationale: text.max(800), reuse_when: text.max(600),
  conditions, exceptions, procedure: notes, limitations: notes,
  evidence: z.array(z.strictObject({ ref: text.regex(reference), sha256: hash })).min(1).max(8), event,
});
const indexSchema = z.strictObject({
  ...common, kind: z.literal('index'), question: text.max(300), summary: text.max(600),
  entries: z.array(z.strictObject({ question: text.max(200), aliases, summary: text.max(300),
    memory: z.strictObject({ id, path, hash }) })).min(1).max(12),
});
// amp/0.2: only basis, claim and evidence are required. The page path is the identity and the Wiki
// page hash is the revision; source hashes are filled in by orgbrain_wiki_amp_save. Indexes link by path.
const memory02 = z.strictObject({
  protocol: z.literal('amp/0.2'), kind: z.literal('memory'), id: id.optional(), title: text.max(200).optional(),
  aliases: aliases.default([]), status: status.default('active'), basis,
  claim: text.max(1200), rationale: text.max(800).optional(), reuse_when: text.max(600).optional(),
  conditions: conditions.default([]), exceptions: exceptions.default([]), procedure: notes.default([]), limitations: notes.default([]),
  evidence: z.array(z.strictObject({ ref: text.regex(reference), sha256: hash.optional() })).min(1).max(8), event,
});
const index02 = z.strictObject({
  protocol: z.literal('amp/0.2'), kind: z.literal('index'), id: id.optional(), title: text.max(200), aliases: aliases.default([]),
  question: text.max(300), summary: text.max(600).optional(),
  entries: z.array(z.strictObject({ question: text.max(200), aliases: aliases.default([]), summary: text.max(300).optional(), path })).min(1).max(12),
});
// amp/0.3: an ordinary Markdown note with frontmatter, so Claude Code memory files, Obsidian, Basic Memory
// and similar notes can be read as-is. Only the claim is required; conditions, exceptions, sources and
// validity are optional additions that make reuse safer. Prose exceptions (empty `when`) never auto-match.
const date = text.regex(/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/);
const memory03 = z.strictObject({
  protocol: z.literal('amp/0.3'), kind: z.literal('memory'), id: id.optional(), title: text.max(200).optional(),
  description: text.max(300).optional(), type: text.max(40).optional(), aliases: aliases.default([]),
  status: status.default('active'), basis: basis.optional(), claim: text.max(4000),
  rationale: text.max(2000).optional(), reuse_when: text.max(600).optional(),
  conditions: conditions.default([]), exceptions: z.array(z.strictObject({ when: conditions, reason: text.max(400) })).max(12).default([]),
  procedure: notes.default([]), limitations: notes.default([]),
  evidence: z.array(z.strictObject({ ref: text.regex(reference), sha256: hash.optional() })).max(8).default([]), event,
  created: date.optional(), modified: date.optional(), valid_from: date.optional(), valid_until: date.optional(),
  supersedes: z.array(text.max(200)).max(8).default([]),
});
const projectIndex04 = z.strictObject({
  protocol: z.literal('amp/0.4'), kind: z.literal('project_index'), project_id: text.max(256),
  title: text.max(200), summary: text.max(600),
  entries: z.array(z.strictObject({ question: text.max(200), path, when: z.enum(['always', 'task']), summary: text.max(300).optional() })).min(1).max(12),
});
const memory04 = memory03.extend({ protocol: z.literal('amp/0.4') });
const documentSchemas = { 'amp/0.1': { memory: memorySchema, index: indexSchema }, 'amp/0.2': { memory: memory02, index: index02 }, 'amp/0.3': { memory: memory03 }, 'amp/0.4': { memory: memory04, project_index: projectIndex04 } };
const memoryInput = memory03.omit({ protocol: true, kind: true });
const inputCommon = { wiki_id: z.literal('personal').optional(), project_id: text.max(256).optional(), token_budget: z.number().int().min(256).max(16000).optional() };
const readingCommon = { ...inputCommon, facts: z.record(key, scalar).optional(), mode: z.enum(['explain', 'apply']).default('explain'), path_prefix: text.max(512).optional(),
  memory_format: z.enum(['markdown', 'json']).default('markdown') };
const searchSchema = z.strictObject({ ...readingCommon, query: text.max(2000),
  path: path.optional(), limit: z.number().int().min(1).max(20).optional(),
  detail: z.enum(['summary', 'memory', 'evidence']).default('summary'), fallback: z.boolean().default(true) });
const readSchema = z.strictObject({ ...readingCommon, path, expected_hash: hash, include_evidence: z.boolean().default(false) });
const validateSchema = z.strictObject({ ...inputCommon, path: path.optional(), page_id: text.max(256).optional() });
const saveSchema = z.strictObject({ ...inputCommon, memory: memoryInput.optional(), markdown: z.string().min(1).max(64000).optional(),
  path: path.optional(), expected_hash: hash.optional(), dry_run: z.boolean().default(false) });

export const AMP_INPUT_SCHEMAS = { save: saveSchema, search: searchSchema, read: readSchema, validate: validateSchema };

export const AMP_TOOLS = [
  { name: 'orgbrain_wiki_amp_save', description: 'Save an amp/0.4 Markdown memory with block YAML metadata, using memory or markdown. Only claim is required; add known conditions, exceptions, limitations and evidence refs source:ID@VERSION#Lstart-Lend. Source ranges are checked and pinned before saving; saved metadata does not embed JSON objects or arrays. Markdown also accepts a project_index: supply matching project_id; exactly one canonical amp/projects/<encoded-project-id>/index.md is used. Pass expected_hash for updates. Writes a personal Wiki page only; never confirms memories or authorizes procedure execution.', inputSchema: z.toJSONSchema(saveSchema, { io: 'input' }) },
  { name: 'orgbrain_wiki_amp_search', description: 'Search AMP memories and same-scope Wiki originals. With project_id, read the returned project_index before work even when the query did not match it. Full memories are Markdown by default (memory_format=json for fields). Default explain mode returns candidates, including non-applicability reasons; follow next_read. detail=memory preserves qualifications; detail=evidence verifies sources. Apply mode never admits legacy fallback. No model calls or writes.', inputSchema: z.toJSONSchema(searchSchema, { io: 'input' }) },
  { name: 'orgbrain_wiki_amp_read', description: 'Read an AMP memory or project index at its expected hash. For a project index, read always entries and relevant procedures using amp_search with their path and the same project_id. Memories retain conditions and exceptions; include_evidence verifies pinned sources. Retrieval and hash checks do not authorize actions or verify meaning.', inputSchema: z.toJSONSchema(readSchema, { io: 'input' }) },
  { name: 'orgbrain_wiki_amp_validate', description: 'Validate one AMP page, every index target and immutable source pin. Structural and hash checks do not verify meaning or historical execution.', inputSchema: z.toJSONSchema(validateSchema, { io: 'input' }) },
];
export function ampJsonSchema() {
  const variants = Object.values(documentSchemas).flatMap(byKind => Object.values(byKind)).map(s => z.toJSONSchema(s));
  for (const variant of variants.filter(s => s.properties.kind.const === 'memory'))
    variant.allOf = [{ if: { properties: { basis: { enum: ['observed_execution', 'reported_execution'] } } }, then: { required: ['event'] } }];
  return { oneOf: variants };
}

function parseDocument(value) {
  const schema = documentSchemas[value?.protocol]?.[value?.kind];
  if (!schema) throw Error('amp_invalid_document:protocol,kind');
  const result = schema.safeParse(value);
  if (!result.success) throw Error(`amp_invalid_document:${result.error.issues.map(i => i.path.join('.')).join(',')}`);
  const doc = result.data;
  if (doc.kind === 'memory') {
    if (['observed_execution', 'reported_execution'].includes(doc.basis) && !doc.event) throw Error('amp_event_required');
    for (const e of doc.evidence) {
      const [, , version, start, end] = e.ref.match(reference);
      if (![version, start, end].every(n => Number.isSafeInteger(Number(n))) || Number(start) > Number(end)) throw Error('amp_invalid_evidence_range');
    }
  } else {
    const targets = doc.entries.map(e => e.memory ?? e);
    if (new Set(targets.map(t => t.path)).size !== targets.length || (doc.protocol === 'amp/0.1' && new Set(targets.map(t => t.id)).size !== targets.length))
      throw Error('amp_duplicate_entry');
  }
  return doc;
}

// YAML block metadata is canonical. The parser also reads the JSON flow values in old 0.3 notes.
// No aliases, duplicate keys or custom tags: metadata must be a bounded, unambiguous data mapping.
function frontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return null;
  // Legacy 0.3 allowed raw scalars containing # or colon-space. YAML would silently
  // change those qualifications. Preserve its original reader; only new saves use 0.4.
  if (/^amp:[ \t]*(?:"0\.3"|0\.3)[ \t]*\r?$/m.test(match[1])) {
    const data = {};
    for (const line of match[1].split(/\r?\n/)) {
      const field = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
      if (!field) continue;
      if (Object.hasOwn(data, field[1])) throw Error('amp_invalid_frontmatter');
      const raw = field[2].trim();
      try { data[field[1]] = /^(?:[[{"]|-?\d|true$|false$|null$)/.test(raw) ? JSON.parse(raw) : raw; }
      catch { throw Error('amp_invalid_frontmatter'); }
    }
    return { data, body: content.slice(match[0].length) };
  }
  try {
    const parsed = parseYamlDocument(match[1], { version: '1.2', uniqueKeys: true, stringKeys: true, resolveKnownTags: false, prettyErrors: false });
    if (parsed.errors.length || parsed.warnings.length) throw Error('invalid_yaml');
    const data = parsed.toJS({ maxAliasCount: 0 });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('mapping_required');
    return { data, body: content.slice(match[0].length) };
  } catch { throw Error('amp_invalid_frontmatter'); }
}

const SECTIONS = [['exceptions', /^(exceptions?|例外)$/i], ['limitations', /^(limitations?|caveats?|限界|制約|注意)$/i],
  ['procedure', /^(procedure|steps|手順)$/i], ['rationale', /^(rationale|why|理由)$/i], ['sources', /^(sources?|evidence|根拠|出典)$/i]];

function sectionItems(lines = []) {
  const items = [];
  let current = [], fence, indent = 0;
  for (const line of lines) {
    const bullet = !fence && /^(?:[-*] |\d+\. )/.exec(line)?.[0];
    let normalized = line;
    if (bullet) {
      if (current.join('\n').trim()) items.push(current.join('\n').trim());
      indent = bullet.length;
      normalized = line.slice(indent);
      current = [];
    } else if (indent && line.startsWith(' '.repeat(indent))) normalized = line.slice(indent);
    current.push(normalized);
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(normalized)?.[1];
    if (!fence && marker) fence = marker;
    else if (fence && marker?.[0] === fence[0] && marker.length >= fence.length && normalized.trim() === marker) fence = undefined;
  }
  if (current.join('\n').trim()) items.push(current.join('\n').trim());
  return items;
}

function noteDocument({ data, body }) {
  if (String(data.amp) === '0.4' && data.kind === 'project_index') return projectIndexDocument(data, body);
  if (!['0.3', '0.4'].includes(String(data.amp)) || (data.kind !== undefined && data.kind !== 'memory')) throw Error('amp_invalid_document:amp,kind');
  const sections = { claim: [] };
  let current = 'claim', title, fence, listIndent = 0;
  for (const line of body.split(/\r?\n/)) {
    const bullet = !fence && /^(?:[-*] |\d+\. )/.exec(line)?.[0];
    if (bullet) listIndent = bullet.length;
    // Saved multiline items add list indentation. Detect fences relative to that
    // indentation so a valid indented closing fence still ends the code block.
    const normalized = bullet ? line.slice(bullet.length)
      : listIndent && line.startsWith(' '.repeat(listIndent)) ? line.slice(listIndent) : line;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(normalized)?.[1];
    if (fence) {
      (sections[current] ??= []).push(line);
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker) { fence = marker; (sections[current] ??= []).push(line); continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading && heading[1] === '#' && !title && current === 'claim' && !sections.claim.join('').trim()) { title = heading[2]; continue; }
    const section = heading?.[1] === '##' && SECTIONS.find(([, pattern]) => pattern.test(heading[2]))?.[0];
    if (section) { current = section; listIndent = 0; continue; }
    (sections[current] ??= []).push(line);
  }
  const refs = value => (Array.isArray(value) ? value : value ? [value] : []).map(v => typeof v === 'string' ? { ref: v } : v);
  const sha = data.source_hashes ?? {};
  const evidence = [...refs(data.sources), ...(sections.sources ?? []).join('\n').match(/source:[A-Za-z0-9._-]+@\d+#L\d+-L\d+/g)?.map(ref => ({ ref })) ?? []]
    .filter((e, i, all) => all.findIndex(x => x.ref === e.ref) === i).map(e => sha[e.ref] && !e.sha256 ? { ...e, sha256: sha[e.ref] } : e);
  const pairs = object => {
    if (object !== undefined && (!object || typeof object !== 'object' || Array.isArray(object))) throw Error('amp_invalid_conditions');
    return Object.entries(object ?? {}).map(([key, equals]) => ({ key, equals }));
  };
  if (data.exceptions !== undefined && !Array.isArray(data.exceptions)) throw Error('amp_invalid_exceptions');
  const value = {
    protocol: `amp/${data.amp}`, kind: 'memory', id: data.name ?? data.id, title: data.title ?? title ?? data.description, description: data.description,
    type: data.type, aliases: [...new Set([...(data.tags ?? []), ...(data.aliases ?? [])])], status: data.status, basis: data.basis,
    claim: sections.claim.join('\n').trim(), rationale: (sections.rationale ?? []).join('\n').trim() || undefined, reuse_when: data.reuse_when,
    conditions: pairs(data.conditions), procedure: sectionItems(sections.procedure), limitations: sectionItems(sections.limitations),
    exceptions: [...(data.exceptions ?? []).map(e => ({ when: pairs(e?.when), reason: e?.reason })), ...sectionItems(sections.exceptions).map(item => {
      const machine = /^(\{[^}]*\})\s*:\s*([\s\S]+)$/.exec(item);
      if (!machine) return { when: [], reason: item };
      try { return { when: pairs(JSON.parse(machine[1])), reason: machine[2].trim() }; } catch { return { when: [], reason: item }; }
    })],
    evidence, event: data.event, created: data.created, modified: data.modified, valid_from: data.valid_from, valid_until: data.valid_until,
    supersedes: data.supersedes === undefined ? undefined : [data.supersedes].flat(),
  };
  return parseDocument(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)));
}

// One project-owned entry point; procedures remain ordinary memories so their conditions and
// evidence use the same reader. Links are Wiki-root-relative, never filesystem paths or commands.
function projectIndexDocument(data, body) {
  let title, when;
  const summary = [], entries = [];
  for (const line of body.split(/\r?\n/)) {
    if (!title && /^# /.test(line)) { title = line.slice(2).trim(); continue; }
    if (/^## (Always|常に読む)$/i.test(line)) { when = 'always'; continue; }
    if (/^## (Procedures|手順)$/i.test(line)) { when = 'task'; continue; }
    if (!when) { summary.push(line); continue; }
    if (!line.trim()) continue;
    const link = /^- \[([^\]]+)\]\(([^)]+)\)(?:\s*:\s*(.+))?$/.exec(line);
    if (!link) throw Error('amp_invalid_project_index_entry');
    entries.push({ question: link[1], path: link[2], when, ...(link[3] ? { summary: link[3] } : {}) });
  }
  return parseDocument({ protocol: 'amp/0.4', kind: 'project_index', project_id: data.project_id, title,
    summary: summary.join('\n').trim(), entries });
}

export function projectIndexPath(projectId) {
  return `amp/projects/${encodeURIComponent(text.max(256).parse(projectId)).replace(/\./g, '%2E')}/index.md`;
}

function memoryStateReason(doc) {
  if (doc.kind !== 'memory') return 'index_target_not_memory';
  if (doc.status !== 'active') return 'memory_not_active';
  const today = new Date().toISOString().slice(0, 10);
  if (doc.valid_until && doc.valid_until.slice(0, 10) < today) return 'memory_expired';
  if (doc.valid_from && doc.valid_from.slice(0, 10) > today) return 'memory_not_yet_valid';
  return null;
}

export function parseAmpPage(content) {
  if (typeof content !== 'string' || content.length > 64000) throw Error('amp_page_too_large');
  const note = frontmatter(content);
  if (note?.data.amp !== undefined) {
    return noteDocument(note);
  }
  const blocks = [...content.matchAll(/^```amp\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (!blocks.length) throw Error('amp_no_block');
  if (blocks.length !== 1) throw Error('amp_block_required_once');
  let value;
  try { value = JSON.parse(blocks[0][1]); } catch { throw Error('amp_invalid_json'); }
  return parseDocument(value);
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
  // A prose-only exception (no machine-checkable `when`) is shown to the reader but never matched here.
  const except = memory.exceptions.map(e => e.when.length ? matches(e.when, facts) : { state: null, missing: [] });
  const missing = [...new Set([...required.missing, ...except.flatMap(e => e.missing)])];
  const mismatches = memory.conditions.filter(c => Object.hasOwn(facts, c.key) && facts[c.key] !== c.equals);
  const exceptions = memory.exceptions.filter((_, i) => except[i].state === true).map(e => e.reason);
  if (mismatches.length || exceptions.length) return { applicability: 'not_applicable', missing_facts: missing,
    reason: mismatches.length ? 'conditions_mismatch' : 'exception_matches', explanation: { conditions: mismatches, exceptions } };
  return { applicability: missing.length ? 'unknown' : 'matched', missing_facts: missing };
}

const memoryText = doc => [doc.title, doc.description, ...doc.aliases, doc.claim, doc.rationale, doc.reuse_when,
  ...doc.conditions.map(c => `${c.key} ${c.equals}`), ...doc.exceptions.map(e => e.reason), ...doc.procedure, ...doc.limitations,
  ...(doc.event ? Object.values(doc.event) : [])].join(' ');

// Defaults are omitted so that many candidates fit a small search budget; readSchema restores them.
// Storage, fallback retrieval and response accounting differ between Node and Workers.
// The document parser, applicability rules and ranking/packing remain shared.
export function createAmpRuntime({ countTokens: countWikiTokens, recall: recallWiki, readArguments = args => args }) {
  function nextRead(page, input, include_evidence = false) {
    return { tool: 'orgbrain_wiki_amp_read', arguments: readArguments({ path: page.path, expected_hash: page.hash,
      ...(input.mode === 'apply' ? { mode: 'apply' } : {}), ...(Object.keys(input.facts ?? {}).length ? { facts: input.facts } : {}),
      ...(include_evidence ? { include_evidence } : {}),
      ...Object.fromEntries(['project_id', 'path_prefix'].filter(k => input[k] !== undefined).map(k => [k, input[k]])) }) };
  }

  // Show the qualification that matched the query, so an exception question does not see only the claim.
  function matchedField(doc, terms = []) {
    const fields = [['claim', doc.claim], ...doc.exceptions.map(e => ['exception', e.reason]),
      ...doc.limitations.map(l => ['limitation', l]), ...doc.procedure.map(p => ['procedure', p]), ['rationale', doc.rationale ?? '']];
    let best = fields[0], top = score(best[1], terms);
    for (const field of fields.slice(1)) { const n = score(field[1], terms); if (n > top) { best = field; top = n; } }
    return best;
  }

  async function presentMemory(loaded, input, readEvidence, attempt, via = []) {
    const { page, doc } = loaded, match = applicability(doc, input.facts ?? {});
    if (input.mode === 'apply' && match.reason) return { withheld: match.reason };
    const withEvidence = input.detail === 'evidence' || input.mode === 'apply';
    // An unsourced note (allowed in amp/0.3) can explain, but cannot be verified or applied.
    if (withEvidence && !doc.evidence.length) return { withheld: 'evidence_missing' };
    const evidence = [];
    if (withEvidence) for (const e of doc.evidence) {
      const value = await attempt(e.ref, () => readEvidence(e));
      if (value) evidence.push(value);
    }
    if (withEvidence && evidence.length !== doc.evidence.length) return { withheld: 'evidence_unavailable' };
    const shared = { kind: 'amp', path: page.path, hash: page.hash, ...match,
      evidence_integrity: withEvidence ? 'verified' : 'not_checked' };
    // A degraded full result must be read again with the same verification it would have had.
    const pointer = { kind: 'amp', id: doc.id, path: page.path, hash: page.hash, applicability: match.applicability,
      detail: 'reference', requires_read: true, next_read: nextRead(page, input, withEvidence) };
    const [field, text] = matchedField(doc, input.terms);
    const summary = { ...shared, id: doc.id, title: doc.title, detail: 'summary', requires_read: true, next_read: pointer.next_read,
      ...(field === 'claim' ? { summary: doc.claim.slice(0, 200) } : { summary: doc.claim.slice(0, 120), matched_on: field, matched_text: text.slice(0, 160) }) };
    if (input.detail === 'summary') return { value: summary, smaller: [pointer] };
    // Full results return answer material only. Source pins are verified through amp_read with this
    // result's path and hash (include_evidence), so their hashes and a read hint are not repeated here.
    // Markdown (default) costs fewer tokens than the same memory as JSON; applicability stays structured.
    const { protocol, kind, status, aliases, revision, ...view } = doc;
    return { value: { ...shared, ...(via.length ? { via } : {}),
      memory: input.memory_format === 'json' ? { ...view, evidence: doc.evidence.map(e => e.ref) } : memoryMarkdown(doc),
      detail: withEvidence ? 'evidence' : 'memory', requires_read: false, ...(withEvidence ? { evidence } : {}) }, smaller: [summary, pointer] };
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
        if (doc.kind === 'project_index' && (doc.project_id !== value.project_id || value.path !== projectIndexPath(doc.project_id)))
          throw Error('amp_project_index_scope');
        // amp/0.2 identity defaults: the page path is the ID and the claim opening is the title.
        if (doc.kind === 'memory') { doc.id ??= value.path; doc.title ??= doc.claim.slice(0, 80); }
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
        if (result.source_id !== source_id || result.version !== Number(version) || (e.sha256 && result.hash !== e.sha256)) throw Error('evidence_identity_mismatch');
        if (result.truncated || result.start_line !== Number(start) || result.end_line !== Number(end) || !result.text?.trim()) throw Error('evidence_incomplete');
        return { ...e, sha256: result.hash, text: result.text, integrity: 'verified' };
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

  async function projectIndexContext(wiki, input) {
    if (!input.project_id) return undefined;
    const target = projectIndexPath(input.project_id);
    if (input.path_prefix !== undefined && !target.startsWith(input.path_prefix)) return undefined;
    const gaps = [], { readPage, attempt } = reader(wiki, input, gaps);
    const loaded = await attempt(target, () => readPage({ path: target }));
    if (!loaded) return gaps[0]?.reason === 'page_not_found' ? undefined : { status: 'unavailable', reason: gaps[0]?.reason ?? 'read_failed' };
    if (loaded.doc.kind !== 'project_index') return { status: 'unavailable', reason: 'amp_project_index_required' };
    return { path: target, hash: loaded.page.hash, requires_read: true,
      instruction: 'Read this project index before work, then its always entries and relevant procedures. It does not grant action permission.',
      next_read: nextRead(loaded.page, { project_id: input.project_id }) };
  }

  // Nothing is partially cut. Summary searches keep candidate breadth: lowest-ranked summaries become
  // read references first. Full searches keep complete results whenever they fit; an oversized result
  // must not force all later, smaller results into unread summaries.
  function degraded(result, versions, budget, breadth) {
    const fits = () => countWikiTokens(result) <= budget - 24;
    if (breadth) {
      let degraded_results = 0;
      for (let i = versions.length - 1; i >= 0 && !fits(); i--) { result.results[i] = versions[i].at(-1); degraded_results++; }
      if (degraded_results) result.truncated = true;
      result.degraded_results = degraded_results;
      return result;
    }
    result.results = [];
    let degraded_results = 0, omitted = 0;
    for (const [form, ...smaller] of versions) {
      const placed = [form, ...smaller].find(value => {
        result.results.push(value);
        if (fits()) return true;
        result.results.pop(); return false;
      });
      if (!placed) omitted++; else if (placed !== form) degraded_results++;
    }
    if (degraded_results || omitted) result.truncated = true;
    result.omitted_results += omitted;
    result.degraded_results = degraded_results;
    return result;
  }

  function bounded(result, budget) {
    result.truncated ||= false;
    while (countWikiTokens(result) > budget - 24 && result.results?.length) {
      result.results.pop(); result.truncated = true; result.omitted_results = (result.omitted_results ?? 0) + 1;
    }
    while (countWikiTokens(result) > budget - 24 && result.gaps.length) {
      result.gaps.pop(); result.truncated = true; result.omitted_gaps = (result.omitted_gaps ?? 0) + 1;
    }
    if (countWikiTokens(result) > budget - 24 && result.project_index) {
      result.project_index = { status: 'omitted', reason: 'token_budget', requires_read: true };
      result.truncated = true;
    }
    if (countWikiTokens(result) > budget - 24) throw Error('amp_budget_exhausted');
    for (let n = 0; n < 4; n++) result.estimated_tokens = countWikiTokens(result);
    return result;
  }

  async function searchAmp(wiki, rawInput) {
    const input = parseInput(searchSchema, rawInput);
    const terms = queryTerms(input.query), gaps = [], ranked = [];
    const { readPage, readEvidence, attempt } = reader(wiki, input, gaps);
    const project_index = !input.path ? await projectIndexContext(wiki, input) : undefined;
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
    if (project_index?.path) {
      const loaded = await attempt(project_index.path, () => readPage({ path: project_index.path }));
      if (loaded && loaded.page.hash !== project_index.hash) gaps.push({ location: project_index.path, reason: 'amp_memory_changed' });
      else if (loaded) for (const entry of loaded.doc.entries) {
        const routing_text = `${entry.question} ${entry.summary ?? ''}`;
        const rank = score(routing_text, terms);
        if (rank) candidate(entry.path, { path: entry.path, index_path: loaded.page.path, index_hash: loaded.page.hash, routing_text }, rank);
      }
    }
    for (const pageId of ids.slice(0, 32)) {
      const loaded = await attempt(pageId, () => readPage(input.path ? { path: pageId } : { page_id: pageId }));
      if (!loaded) continue;
      const { doc, page } = loaded;
      ampPageIds.add(page.page_id);
      if (doc.kind === 'project_index') continue;
      if (doc.kind === 'memory') candidate(page.path, null, score(memoryText(doc), terms), loaded);
      else for (const entry of doc.entries) {
        const rank = score(`${entry.question} ${entry.aliases.join(' ')} ${entry.summary ?? ''}`, terms);
        // amp/0.1 entries pin id and hash; amp/0.2 entries link by path and follow the current page.
        if (rank) candidate((entry.memory ?? entry).path, { ...(entry.memory ?? { path: entry.path }), index_path: page.path, index_hash: page.hash,
          routing_text: `${entry.question} ${entry.aliases.join(' ')} ${entry.summary ?? ''}` }, rank);
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
      let reason = candidate.pins.some(p => p.hash && p.hash !== page.hash) ? 'memory_hash_mismatch' :
        candidate.pins.some(p => p.id && p.id !== doc.id) ? 'memory_id_mismatch' :
        memoryStateReason(doc);
      if (reason) { gaps.push({ location: candidate.location, reason }); continue; }
      const shown = await presentMemory(loaded, { ...input, terms }, readEvidence, attempt,
        candidate.pins.map(p => ({ path: p.index_path, hash: p.index_hash })));
      if (shown.withheld) { gaps.push({ location: candidate.location, reason: shown.withheld }); continue; }
      const routing = candidate.pins.map(p => p.routing_text ?? '').join(' ');
      ranked.push({ value: shown.value, smaller: shown.smaller, id: doc.id, text: `${memoryText(doc)} ${routing}`,
        primary: [doc.title, ...doc.aliases, doc.claim, routing].join(' ') });
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
        // Returned excerpts shrink with the budget so that at least one passage can fit; at the default
        // 4,000 tokens this stays at recall's 1,800 characters. Summaries keep it, since the excerpt
        // range is also the range that next_read later reads.
        // Rank against the whole query below. A per-batch output limit or full-match filter
        // can discard a source that best answers the complete query before it gets ranked.
        const recalled = await recallWiki(wiki, { ...filters, query: batch.join(' '), limit: 20, max_chars: 36000,
          context_mode: batches.length > 1 ? 'broad' : 'focused',
          passage_chars: input.detail === 'summary' ? 1800 : Math.max(128, Math.min(1800, Math.floor((input.token_budget ?? 4000) * 0.5))) });
        truncated ||= recalled.truncated;
        for (const e of recalled.evidence) {
          // AMP pages must pass the structured checks, not reappear as unvalidated Wiki prose.
          if (seen.has(e.id) || ampPageIds.has(e.page_id) || /```amp\s/.test(e.text)) continue;
          if (e.page_id) {
            // A passage may omit frontmatter, and fallback can find pages outside the AMP candidate
            // window. Check the full page before treating it as ordinary prose.
            try { await readPage({ page_id: e.page_id }); continue; }
            catch (error) {
              if (error.message !== 'amp_no_block') {
                if (!gaps.some(g => g.location === e.page_id)) await attempt(e.page_id, () => { throw error; });
                continue;
              }
            }
          }
          seen.add(e.id);
          // recall excerpts count a trailing newline as an extra display line;
          // the reader's inclusive end line must refer to a real original line.
          const end_line = Math.max(e.start_line, e.end_line - Number(e.text.endsWith('\n')));
          const citation = e.source_id ? `source:${e.source_id}@${e.version}#L${e.start_line}-L${end_line}` : `wiki:${e.page_id}#L${e.start_line}-L${end_line}`;
          const passage = { ...e, id: citation, end_line,
            ...(e.excerpt_ranges ? { excerpt_ranges: e.excerpt_ranges.map(range => ({ ...range, end_line: Math.min(range.end_line, end_line) })) } : {}) };
          const next_read = { tool: e.source_id ? 'orgbrain_wiki_source_read' : 'orgbrain_wiki_read',
            arguments: readArguments({ wiki_id: 'personal', ...(e.source_id ? { source_id: e.source_id, version: e.version } : { page_id: e.page_id }),
              start_line: e.start_line, end_line }) };
          const pointer = { kind: e.kind, id: citation, detail: 'reference', requires_read: true, next_read,
            ...(e.hash ? { expected_source_hash: e.hash } : {}), verification_state: 'legacy_unverified' };
          const summary = { ...pointer, title: e.heading ?? citation, summary: e.text.slice(0, 200), detail: 'summary' };
          // The citation id already names the source, version and lines to read further.
          const full = { kind: e.kind, id: citation, ...(e.hash ? { hash: e.hash } : {}), ...(e.heading ? { heading: e.heading } : {}), text: e.text,
            ...(passage.excerpt_ranges ? { excerpt_ranges: passage.excerpt_ranges } : {}), ...(e.truncated ? { truncated: true } : {}),
            ...(e.original ? { original: e.original, origin: e.origin } : {}), ...(e.verification_state ? { verification_state: e.verification_state } : {}),
            detail: 'passage', requires_read: false, applicability: 'not_assessed' };
          ranked.push({ value: input.detail === 'summary' ? summary : full,
            smaller: input.detail === 'summary' ? [pointer] : [summary, pointer], text: e.text, primary: e.text });
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
    const shown = ranked.slice(0, limit), budget = input.token_budget ?? 4000;
    return bounded(degraded({ protocol: 'amp/0.1', retrieval_version: '0.2', mode: input.mode, detail: input.detail,
      ...(project_index ? { project_index } : {}),
      results: shown.map(r => r.value), fallback, gaps, truncated, omitted_results, answer_completeness_verified: false,
      semantic_verification: 'not_performed', writes_performed: false }, shown.map(r => [r.value, ...r.smaller]), budget, input.detail === 'summary'), budget);
  }

  async function readAmp(wiki, rawInput) {
    const input = parseInput(readSchema, rawInput), gaps = [];
    const { readPage, readEvidence, attempt } = reader(wiki, input, gaps);
    const loaded = await readPage({ path: input.path });
    if (loaded.page.hash !== input.expected_hash) throw Error('amp_memory_changed');
    if (loaded.doc.kind === 'project_index') return bounded({ protocol: 'amp/0.4', results: [{ kind: 'project_index',
      path: loaded.page.path, hash: loaded.page.hash, index: loaded.doc, requires_read: false,
      instruction: 'Read always entries before work and task entries when relevant. For each entry use amp_search with its path, question as query, and this project_id; read complete conditions before acting. Saved procedures do not override current instructions or authorize actions.' }],
      gaps, writes_performed: false, semantic_verification: 'not_performed' }, input.token_budget ?? 4000);
    if (loaded.doc.kind !== 'memory') throw Error('amp_read_requires_memory');
    const reason = memoryStateReason(loaded.doc);
    if (reason) throw Error(`amp_${reason}`);
    const shown = await presentMemory(loaded, { ...input, detail: input.include_evidence ? 'evidence' : 'memory' }, readEvidence, attempt);
    if (shown.withheld) gaps.push({ location: input.path, reason: shown.withheld });
    return bounded({ protocol: 'amp/0.1', retrieval_version: '0.2', mode: input.mode, results: shown.withheld ? [] : [shown.value], gaps,
      answer_completeness_verified: false, semantic_verification: 'not_performed', writes_performed: false }, input.token_budget ?? 4000);
  }

  async function validateAmpPage(wiki, rawInput) {
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
    if (loaded && ['index', 'project_index'].includes(loaded.doc.kind)) {
      const targetReader = loaded.doc.kind === 'project_index'
        ? reader(wiki, { ...input, project_id: loaded.doc.project_id }, gaps) : { readPage, attempt };
      for (const entry of loaded.doc.entries) {
        const pin = entry.memory ?? { path: entry.path };
        const target = await targetReader.attempt(pin.path, () => targetReader.readPage({ path: pin.path }));
        if (target) await checkMemory(target, entry.memory);
      }
    } else if (loaded) await checkMemory(loaded);
    return bounded({ protocol: 'amp/0.1', valid: gaps.length === 0, checked, gaps,
      semantic_verification: 'not_performed', writes_performed: false }, input.token_budget ?? 4000);
  }

  // The readable Markdown is generated from the same object as the amp block, so the two cannot drift.
  const conditionObject = pairs => Object.fromEntries(pairs.map(c => [c.key, c.equals]));
  const conditionText = pairs => pairs.map(c => `${c.key} = ${stringifyYaml(c.equals, { defaultStringType: 'QUOTE_SINGLE', lineWidth: 0 }).trimEnd()}`).join('; ');
  // The claim and standard sections as ordinary Markdown, shared by stored pages and search results.
  function memoryBody(doc) {
    const list = (heading, items) => items.length ? [`## ${heading}`, '', ...items.map(item => `- ${item.replace(/\n/g, '\n  ')}`), ''] : [];
    return [...(doc.title ? [`# ${doc.title}`, ''] : []), doc.claim, '',
      ...list('Exceptions', doc.exceptions.map(e => e.when.length ? `${conditionText(e.when)}: ${e.reason}` : e.reason)),
      ...list('Limitations', doc.limitations), ...list('Procedure', doc.procedure),
      ...(doc.rationale ? ['## Rationale', '', doc.rationale, ''] : [])];
  }
  // A search or read result: the readable body plus the metadata needed to reuse it correctly.
  function memoryMarkdown(doc) {
    return [...memoryBody(doc), doc.basis && `Basis: ${doc.basis}`,
      doc.event && `Event: ${doc.event.date} · ${doc.event.environment} · ${doc.event.outcome}`,
      doc.conditions.length && `Conditions: ${conditionText(doc.conditions)}`,
      doc.reuse_when && `Reuse when: ${doc.reuse_when}`,
      (doc.valid_from || doc.valid_until) && `Valid: ${doc.valid_from ?? ''}..${doc.valid_until ?? ''}`,
      doc.evidence.length && `Sources: ${doc.evidence.map(e => e.ref).join(' ')}`].filter(line => typeof line === 'string').join('\n').trim();
  }

  // amp/0.4: block YAML metadata plus ordinary Markdown. Each source pin and exception is stored once.
  function renderMemory(doc) {
    const object = conditionObject;
    const fields = { amp: '0.4', name: doc.id, description: doc.description, type: doc.type, basis: doc.basis,
      tags: doc.aliases.length ? doc.aliases : undefined, status: doc.status === 'active' ? undefined : doc.status,
      conditions: doc.conditions.length ? object(doc.conditions) : undefined, reuse_when: doc.reuse_when,
      exceptions: doc.exceptions.length ? doc.exceptions.map(e => ({ ...(e.when.length ? { when: object(e.when) } : {}), reason: e.reason })) : undefined,
      sources: doc.evidence.length ? doc.evidence : undefined,
      event: doc.event, created: doc.created, modified: doc.modified, valid_from: doc.valid_from, valid_until: doc.valid_until,
      supersedes: doc.supersedes.length ? doc.supersedes : undefined };
    const metadata = stringifyYaml(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), { collectionStyle: 'block', lineWidth: 0 });
    return ['---', metadata.trimEnd(), '---', ...memoryBody({ ...doc, exceptions: [] })].join('\n');
  }

  // Saving accepts the shapes agents naturally write: a ref string for an evidence item and a single
  // string for a list field. The stored page always uses the canonical shape.
  function looseMemory(memory) {
    if (!memory || typeof memory !== 'object' || Array.isArray(memory)) return memory;
    const value = { ...memory };
    for (const field of ['aliases', 'procedure', 'limitations']) if (typeof value[field] === 'string') value[field] = [value[field]];
    if (Array.isArray(value.evidence)) value.evidence = value.evidence.map(e => typeof e === 'string' ? { ref: e } : e);
    return value;
  }

  async function saveAmp(wiki, rawInput) {
    const input = parseInput(saveSchema, rawInput && typeof rawInput === 'object' && rawInput.memory ? { ...rawInput, memory: looseMemory(rawInput.memory) } : rawInput);
    if (Boolean(input.memory) === Boolean(input.markdown)) throw Error('amp_invalid_input:memory_or_markdown');
    // A Markdown note from another tool needs no conversion: frontmatter keys it shares are kept, the body is the claim.
    let doc;
    if (input.markdown) {
      const note = frontmatter(input.markdown) ?? { data: {}, body: input.markdown };
      doc = noteDocument({ ...note, data: { ...note.data, amp: note.data.amp ?? '0.4' } });
    } else doc = parseDocument({ protocol: 'amp/0.4', kind: 'memory', ...input.memory });
    if (doc.kind === 'project_index') {
      const target = path.parse(projectIndexPath(doc.project_id));
      if (input.project_id !== doc.project_id || (input.path !== undefined && input.path !== target)) throw Error('amp_project_index_scope');
      const result = { protocol: 'amp/0.4', path: target, kind: doc.kind, semantic_verification: 'not_performed' };
      if (input.dry_run) return { ...result, dry_run: true, writes_performed: false };
      const metadata = stringifyYaml({ amp: '0.4', kind: 'project_index', project_id: doc.project_id }, { collectionStyle: 'block', lineWidth: 0 });
      const content = `---\n${metadata}---\n${frontmatter(input.markdown).body}`;
      const saved = await wiki.request({ op: 'put', wiki_id: 'personal', path: target, title: doc.title, content,
        project_id: input.project_id, ...(input.expected_hash ? { expected_hash: input.expected_hash } : {}) });
      return { ...result, hash: saved.hash, writes_performed: true };
    }
    for (const e of doc.evidence) {
      const [, source_id, version, start, end] = e.ref.match(reference);
      const read = await wiki.request({ op: 'source_read', wiki_id: 'personal', source_id, version: Number(version),
        start_line: Number(start), end_line: Number(end), max_chars: 12000 });
      if (read.source_id !== source_id || read.version !== Number(version)) throw Error('amp_evidence_not_found');
      if (e.sha256 && read.hash !== e.sha256) throw Error('amp_evidence_hash_mismatch');
      if (read.truncated) throw Error('amp_evidence_range_too_long');
      if (read.start_line !== Number(start) || read.end_line !== Number(end) || !read.text?.trim()) throw Error('amp_evidence_range_invalid');
      e.sha256 = read.hash;
    }
    const target = input.path ?? `amp/memories/${doc.id ?? `m-${createHash('sha256').update(doc.claim).digest('hex').slice(0, 12)}`}.md`;
    const content = renderMemory(doc);
    parseAmpPage(content);
    const result = { protocol: 'amp/0.4', path: target, id: doc.id ?? target, evidence: doc.evidence.map(e => ({ ref: e.ref, sha256: e.sha256, integrity: 'verified' })),
      semantic_verification: 'not_performed' };
    if (input.dry_run) return { ...result, dry_run: true, writes_performed: false };
    const saved = await wiki.request({ op: 'put', wiki_id: 'personal', path: target, title: doc.title ?? doc.claim.slice(0, 80), content,
      ...Object.fromEntries(['expected_hash', 'project_id'].filter(k => input[k] !== undefined).map(k => [k, input[k]])) });
    return { ...result, hash: saved.hash, writes_performed: true };
  }
  return { projectIndexContext, searchAmp, readAmp, validateAmpPage, saveAmp };
}
