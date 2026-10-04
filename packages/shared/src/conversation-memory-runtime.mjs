// Explicit bounded caller-supplied summaries. Shared by local CLI and Cloud MCP.
import { createHash } from 'node:crypto';
import { normalizeMemoryScope,normalizeTaskConstraint,normalizeMemoryPlaybook,renderMemoryPlaybook } from './memory-playbook-runtime.mjs';
import { Buffer } from 'node:buffer';
import { screenSensitiveMemory, normalizeMemoryPaths } from './memory-capture-v2-runtime.mjs';

export const CONVERSATION_MEMORY_SCHEMA = 'conversation-memory/v1';
const MAX_BYTES = 64 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textHash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const opaqueUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, field) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`invalid_${field}_fields`);
}
function text(value, limit, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`invalid_${field}`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > limit) throw new Error(`invalid_${field}`);
  return normalized;
}
function id(value, field) {
  const result = text(value, 128, field);
  if ((!opaqueUuid(result) && (!screenSensitiveMemory(result).allowed || /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/u.test(result))) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(result)) throw new Error(`invalid_${field}`);
  return result;
}
function safe(value, limit, field, redactions) {
  const original = text(value, limit, field);
  // Reuse the shared redactor, then re-screen with the default-deny policy.
  // This does not opt the store into restricted/sensitive memory retention.
  const screened = screenSensitiveMemory(original, { mode: 'restricted_7d', allowed_principals: ['local-redaction-only'] });
  if (!screened.allowed || screened.hard_reject || screened.counts.sensitive_domains > 0) throw new Error(`${field}_contains_sensitive_data`);
  const sanitized = normalizeMemoryPaths(screened.text);
  if (sanitized !== original) redactions.push(field);
  if (!sanitized.trim() || sanitized.length > limit) throw new Error(`invalid_${field}`);
  const rescreened = screenSensitiveMemory(sanitized);
  if (!rescreened.allowed) throw new Error(`${field}_contains_sensitive_data`);
  if (/\b(?:ignore|override|disregard)\b.{0,40}\b(?:previous|system|developer|security)\b|前の指示を無視/iu.test(sanitized)) {
    throw new Error(`${field}_unsafe_instruction`);
  }
  return sanitized;
}

export function planConversationMemory(input) {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_BYTES) throw new Error('conversation_input_too_large');
  keys(input, ['schema_version', 'tenant_id', 'project_id', 'session_id', 'event_id', 'occurred_at', 'producer', 'sources', 'candidates'], 'conversation');
  if (input.schema_version !== CONVERSATION_MEMORY_SCHEMA) throw new Error('invalid_conversation_schema');
  const tenant = id(input.tenant_id, 'tenant_id'), project = id(input.project_id, 'project_id');
  const session = id(input.session_id, 'session_id'), event = id(input.event_id, 'event_id');
  const occurredAt = text(input.occurred_at, 40, 'occurred_at');
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) throw new Error('invalid_occurred_at');
  if (!['dot', 'worker', 'codex', 'manual'].includes(input.producer)) throw new Error('invalid_conversation_producer');
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 8) throw new Error('invalid_conversation_sources');
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 3) throw new Error('invalid_conversation_candidates');
  const redactions = [];
  const sources = input.sources.map(source => {
    keys(source, ['id', 'role', 'ref', 'text'], 'source');
    const sourceId = id(source.id, 'source_id');
    if (!['user', 'assistant', 'worker', 'tool'].includes(source.role)) throw new Error('invalid_source_role');
    const ref = safe(source.ref, 512, 'source_ref', redactions);
    if (/^(?:file:|[a-z]:[\\/])/iu.test(ref) || ref.includes('[external-path]')) throw new Error('invalid_source_ref');
    // Do not persist signed links, authentication query strings, or local paths.
    if (/[?&#]|^[\\/]/u.test(ref)) throw new Error('invalid_source_ref');
    const snippet = safe(source.text, 2000, 'source_text', redactions);
    return { id: sourceId, role: source.role, ref, content_hash: `sha256:${textHash(snippet)}`, snippet };
  });
  if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('duplicate_source_id');
  const candidates = input.candidates.map(candidate => {
    keys(candidate, ['id', 'kind', 'claim_type', 'conclusion', 'rationale', 'reuse_rule', 'source_ids', 'work_type','memory_type','scope','playbook','task_constraint'], 'candidate');
    const candidateKey = id(candidate.id, 'candidate_id');
    if (!['fact', 'decision', 'constraint', 'pitfall', 'preference'].includes(candidate.kind)) throw new Error('invalid_candidate_kind');
    const requiredRole = { user_decision: 'user', worker_claim: 'worker', assistant_claim: 'assistant', tool_result: 'tool' }[candidate.claim_type];
    if (!requiredRole) throw new Error('invalid_claim_type');
    if (!Array.isArray(candidate.source_ids) || !candidate.source_ids.length || candidate.source_ids.length > 3
      || new Set(candidate.source_ids).size !== candidate.source_ids.length) throw new Error('invalid_candidate_sources');
    const selected = candidate.source_ids.map(sourceId => {
      const source = sources.find(item => item.id === sourceId);
      if (!source) throw new Error('candidate_source_not_found');
      return source;
    });
    if (!selected.some(source => source.role === requiredRole)) throw new Error('claim_source_role_mismatch');
    const workType = candidate.work_type ?? 'implementation';
    if (!['implementation', 'review', 'debug', 'proposal', 'support', 'research', 'operations', 'other'].includes(workType)) throw new Error('invalid_work_type');
    const scope=candidate.scope === undefined ? undefined : normalizeMemoryScope(candidate.scope,project);
    const typed=candidate.memory_type;
    if (typed !== undefined && !['playbook','task_constraint','lesson'].includes(typed)) throw new Error('invalid_memory_type');
    if (scope?.level === 'task' && typed !== 'task_constraint' || typed === 'task_constraint' && (candidate.claim_type !== 'user_decision' || candidate.playbook !== undefined)) throw new Error('invalid_task_constraint_type');
    const taskConstraint=typed==='task_constraint'?normalizeTaskConstraint(candidate.task_constraint,scope,occurredAt):undefined;
    if (typed !== 'task_constraint' && candidate.task_constraint !== undefined) throw new Error('task_constraint_requires_task_scope');
    const playbook=typed==='playbook'?normalizeMemoryPlaybook(candidate.playbook,scope):undefined;
    if (typed !== 'playbook' && candidate.playbook !== undefined) throw new Error('playbook_requires_typed_scope');
    const extension={...(typed?{memory_type:typed}:{}),...(scope?{scope}:{}),...(taskConstraint?{task_constraint:taskConstraint}:{}),...(playbook?{playbook}:{} )};
    const conclusion = safe(candidate.conclusion, 240, 'conclusion', redactions);
    const reason = safe(candidate.rationale, 500, 'rationale', redactions);
    const reuse = safe(candidate.reuse_rule, 500, 'reuse_rule', redactions);
    const provenance = { producer: input.producer, session_id: session, event_id: event, occurred_at_ms: Date.parse(occurredAt),
      claim_type: candidate.claim_type, evidence_status: 'supplied_unverified', kind: candidate.kind, ...extension };
    const sourceReferences = selected.map(source => ({ type: 'conversation', ref: source.ref, role: source.role,
      span_id: source.id, parent_span_id: event, content_hash: source.content_hash }));
    if (playbook) sourceReferences.push(...playbook.sources.map(source=>({type:'playbook_source',ref:source.ref,role:'supplied_unverified',content_hash:source.content_hash,version:source.version})));
    sourceReferences.push({ type: 'conversation_event', ref: `turn:sha256:${hash(provenance)}#conversation-event`, role: 'supplied_unverified',
      span_id: `at:${new Date(occurredAt).toISOString().replaceAll('-', '/')}`, parent_span_id: session, content_hash: `sha256:${hash(provenance)}` });
    if (playbook && [conclusion,reason,reuse,renderMemoryPlaybook(playbook)].join('\n').length>3900) throw new Error('playbook_capsule_too_large');
    const candidateHash = hash({ tenant, project, candidateKey, conclusion, reason, reuse, workType, provenance, sourceReferences });
    const confirmationId = `memory-confirmation:${createHash('sha256').update(`${tenant}\0${project}\0${candidateHash}`).digest('hex').slice(0, 40)}`;
    return { id: confirmationId, candidate_hash: candidateHash, category: 'decision',
      conclusion, reason, reuse_rule: reuse, project_id: project, work_type: workType,
      external_key: `turn:sha256:${candidateHash}#conversation`, confirmation_only: true,
      ...extension, provenance, source_references: sourceReferences,
      // These are bounded, redacted excerpts supplied by the caller, never raw transcripts.
      evidence: selected.map(source => ({ role: source.role, ref: source.ref, content_hash: source.content_hash, snippet: source.snippet,
        verification_state: 'unverified', hash_basis: 'normalized_redacted_excerpt_utf8' })),
      proposal: { tenant_id: tenant, source: 'conversation-event',
        item: { content: conclusion, summary: conclusion, project_id: project, work_type: workType,
          external_key: `turn:sha256:${candidateHash}#conversation`, tags: ['conversation-event', candidate.kind, candidate.claim_type, 'supplied-unverified'] },
        review_context: { candidate_id: confirmationId, candidate_hash: candidateHash, source_references: sourceReferences,
          conclusion, reason_summary: reason, reuse_rule: reuse } } };
  });
  if (new Set(input.candidates.map(candidate => id(candidate.id, 'candidate_id'))).size !== candidates.length) throw new Error('duplicate_candidate_id');
  const plan = { schema_version: CONVERSATION_MEMORY_SCHEMA, tenant_id: tenant, project_id: project,
    task_key: `codex:conversation:${session}`, producer: input.producer, event_id: event, occurred_at: occurredAt,
    active_memories_created: 0, verification_state: 'unverified', requires_confirmation: true,
    redacted_fields: [...new Set(redactions)], candidates };
  return { ...plan, plan_hash: hash(plan) };
}
