import { assessMemoryUsefulnessV2 } from './memory-usefulness-runtime.mjs';

export const MEMORY_USE_POLICY = 'memory-use-ranking/v1';
export const MEMORY_USE_HALF_LIFE_MS = 90 * 86400000;
export const MEMORY_USE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_use_contexts (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, usage_item_id TEXT NOT NULL,
 source_type TEXT NOT NULL, source_id TEXT NOT NULL, source_version INTEGER,
 project_id TEXT NOT NULL, task_id TEXT NOT NULL, work_type TEXT NOT NULL,
 principal TEXT NOT NULL, context_json TEXT NOT NULL, request_hash TEXT NOT NULL,
 verification_state TEXT NOT NULL, supersedes_id TEXT, revoked_at INTEGER,
 created_at INTEGER NOT NULL, UNIQUE(tenant_id, supersedes_id)
);
CREATE INDEX IF NOT EXISTS idx_use_context_scope ON memory_use_contexts(tenant_id, principal, project_id, work_type, source_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_use_context_fts USING fts5(context_id UNINDEXED, text, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS memory_use_evidence (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, context_id TEXT NOT NULL,
 role TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
 span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, content_hash TEXT NOT NULL,
 excerpt TEXT NOT NULL, verification_state TEXT NOT NULL, reason TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_use_evidence_context ON memory_use_evidence(tenant_id, context_id);
CREATE INDEX IF NOT EXISTS idx_use_evidence_ref ON memory_use_evidence(tenant_id, ref_type, ref_id);
CREATE TABLE IF NOT EXISTS memory_use_evaluations (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, context_id TEXT NOT NULL,
 effect_event_id TEXT, assessment_json TEXT NOT NULL, outcome TEXT NOT NULL,
 verification_state TEXT NOT NULL, proof_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 supersedes_id TEXT, created_at INTEGER NOT NULL,
 UNIQUE(tenant_id, supersedes_id)
);
CREATE INDEX IF NOT EXISTS idx_use_evaluation_context ON memory_use_evaluations(tenant_id, context_id, created_at);
CREATE TABLE IF NOT EXISTS memory_use_feedback (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
 project_id TEXT NOT NULL, task_id TEXT NOT NULL, source_id TEXT NOT NULL,
 usage_item_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'assessment',
 text TEXT NOT NULL, contribution TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_use_statistics (
 tenant_id TEXT NOT NULL, principal TEXT NOT NULL, project_id TEXT NOT NULL,
 work_type TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
 source_version INTEGER NOT NULL, positive REAL NOT NULL, negative REAL NOT NULL,
 evaluation_count INTEGER NOT NULL, snapshot_id TEXT NOT NULL, as_of INTEGER NOT NULL, context_ids_json TEXT NOT NULL,
 constraints_key TEXT NOT NULL, conditions_key TEXT NOT NULL,
 PRIMARY KEY(tenant_id, principal, project_id, work_type, source_type, source_id, source_version, constraints_key, conditions_key)
);
CREATE TABLE IF NOT EXISTS memory_use_snapshots (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
 project_id TEXT NOT NULL, work_type TEXT NOT NULL, policy TEXT NOT NULL,
 as_of INTEGER NOT NULL, statistics_json TEXT NOT NULL, invalidated_at INTEGER
);
CREATE TABLE IF NOT EXISTS memory_use_outbox (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, payload_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS use_context_revoke AFTER UPDATE OF revoked_at ON memory_use_contexts
WHEN NEW.revoked_at IS NOT NULL BEGIN
 INSERT OR IGNORE INTO memory_use_outbox(id,tenant_id,payload_json,status,created_at)
 SELECT NEW.id||':revoke',NEW.tenant_id,json_object('operation','revoke','id',NEW.id),'pending',NEW.revoked_at
 WHERE EXISTS(SELECT 1 FROM memory_use_outbox WHERE id=NEW.id AND tenant_id=NEW.tenant_id);
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,NEW.revoked_at) WHERE tenant_id=NEW.tenant_id AND principal=NEW.principal AND project_id=NEW.project_id AND work_type=NEW.work_type;
 DELETE FROM memory_use_context_fts WHERE context_id=NEW.id;
 DELETE FROM memory_use_statistics WHERE tenant_id=NEW.tenant_id AND source_id=NEW.source_id;
END;
CREATE TRIGGER IF NOT EXISTS use_context_inserted AFTER INSERT ON memory_use_contexts BEGIN
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,NEW.created_at) WHERE tenant_id=NEW.tenant_id AND principal=NEW.principal AND project_id=NEW.project_id AND work_type=NEW.work_type;
END;
CREATE TRIGGER IF NOT EXISTS use_evaluation_inserted AFTER INSERT ON memory_use_evaluations BEGIN
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,NEW.created_at) WHERE tenant_id=NEW.tenant_id AND EXISTS(SELECT 1 FROM memory_use_contexts c WHERE c.id=NEW.context_id AND c.tenant_id=NEW.tenant_id AND c.principal=memory_use_snapshots.principal AND c.project_id=memory_use_snapshots.project_id AND c.work_type=memory_use_snapshots.work_type);
END;
CREATE TRIGGER IF NOT EXISTS use_effect_superseded AFTER INSERT ON memory_effect_events WHEN NEW.supersedes_effect_id IS NOT NULL BEGIN
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,NEW.created_at) WHERE tenant_id=NEW.tenant_id AND EXISTS(
 SELECT 1 FROM memory_use_contexts c JOIN memory_use_evaluations e ON e.context_id=c.id AND e.tenant_id=c.tenant_id WHERE e.effect_event_id=NEW.supersedes_effect_id AND e.tenant_id=NEW.tenant_id AND c.principal=memory_use_snapshots.principal AND c.project_id=memory_use_snapshots.project_id AND c.work_type=memory_use_snapshots.work_type);
 DELETE FROM memory_use_statistics WHERE tenant_id=NEW.tenant_id AND source_id IN (
 SELECT c.source_id FROM memory_use_contexts c JOIN memory_use_evaluations e ON e.context_id=c.id AND e.tenant_id=c.tenant_id WHERE e.effect_event_id=NEW.supersedes_effect_id AND e.tenant_id=NEW.tenant_id);
END;
CREATE TRIGGER IF NOT EXISTS use_effect_deleted AFTER DELETE ON memory_effect_events BEGIN
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,unixepoch()*1000) WHERE tenant_id=OLD.tenant_id AND EXISTS(
 SELECT 1 FROM memory_use_contexts c JOIN memory_use_evaluations e ON e.context_id=c.id AND e.tenant_id=c.tenant_id WHERE e.effect_event_id=OLD.id AND e.tenant_id=OLD.tenant_id AND c.principal=memory_use_snapshots.principal AND c.project_id=memory_use_snapshots.project_id AND c.work_type=memory_use_snapshots.work_type);
 DELETE FROM memory_use_statistics WHERE tenant_id=OLD.tenant_id AND source_id IN (
 SELECT c.source_id FROM memory_use_contexts c JOIN memory_use_evaluations e ON e.context_id=c.id AND e.tenant_id=c.tenant_id WHERE e.effect_event_id=OLD.id AND e.tenant_id=OLD.tenant_id);
END;
CREATE TRIGGER IF NOT EXISTS use_feedback_deleted AFTER DELETE ON memory_use_feedback BEGIN
 UPDATE memory_use_contexts SET revoked_at=unixepoch()*1000 WHERE tenant_id=OLD.tenant_id AND id IN (SELECT context_id FROM memory_use_evidence WHERE tenant_id=OLD.tenant_id AND ref_type='use_feedback' AND ref_id=OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS use_memory_deleted AFTER DELETE ON memories BEGIN
 UPDATE memory_use_contexts SET revoked_at=unixepoch()*1000 WHERE tenant_id=OLD.tenant_id AND source_type='memory' AND source_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS use_memory_changed AFTER UPDATE OF permissions_json, current_version, lifecycle_state, valid_until ON memories BEGIN
 DELETE FROM memory_use_statistics WHERE tenant_id=NEW.tenant_id AND source_id=NEW.id;
 DELETE FROM memory_use_context_fts WHERE context_id IN(SELECT id FROM memory_use_contexts WHERE tenant_id=NEW.tenant_id AND source_id=NEW.id);
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,unixepoch()*1000) WHERE tenant_id=NEW.tenant_id AND EXISTS(SELECT 1 FROM memory_use_contexts c WHERE c.tenant_id=NEW.tenant_id AND c.source_id=NEW.id AND c.principal=memory_use_snapshots.principal AND c.project_id=memory_use_snapshots.project_id AND c.work_type=memory_use_snapshots.work_type);
END;
`;

const WORK_TYPES = new Set(['implementation','review','debug','proposal','support','research','operations','other','unknown']);
function fail(code) { throw new Error(code); }
function text(value, max = 256, required = true) {
  if ((value == null || value === '') && !required) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_use_text');
  return value.trim();
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_use_object');
  return value;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
}
export async function useHash(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(stable(value)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function memoryUseFlags(env = {}) {
  const flag = name => env[name] === 'on' || env[name] === 'true';
  return { collect: flag('ORGBRAIN_USE_COLLECT'), context: flag('ORGBRAIN_USE_CONTEXT'),
    ranking: flag('ORGBRAIN_USE_RANKING'), sync: flag('ORGBRAIN_USE_SYNC') };
}
export function normalizeUseContext(raw) {
  const body = object(raw);
  const result = {};
  for (const key of ['task', 'target', 'constraints', 'conditions']) result[key] = text(body[key] ?? '', 600, false) ?? '';
  if (!result.task || !result.target) fail('use_task_and_target_required');
  if (/Bearer\s+\S+|(?:password|api[_-]?key|secret)\s*[:=]\s*\S+/iu.test(JSON.stringify(result))) fail('sensitive_use_context');
  return result;
}
export function useContextTokens(value) {
  const input = String(value).normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const words = input.match(/[a-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  return [...new Set(words.flatMap(word => /^[a-z0-9]+$/.test(word) || word.length < 3 ? [word]
    : Array.from({length: word.length - 1}, (_, i) => word.slice(i, i + 2))))].slice(0, 48);
}
export function useScore(base, positive, negative) {
  if (!Number.isFinite(base) || base < 0) return base;
  return base * (1 + 0.1 * (positive - negative) / (positive + negative + 5));
}
export function useConditionsMatch(context, requested) {
  // No guessed semantic applicability: non-empty conditions require the same supplied condition.
  return (!context.conditions || context.conditions === requested?.conditions)
    && (!context.constraints || context.constraints === requested?.constraints);
}

/** SQL port uses all(sql,args), batch([{sql,args}]); trusted resolvers are never request fields. */
export class MemoryUseHistory {
  constructor({ db, tenantId, principal, resolveSource, resolveEvidence, now = Date.now }) {
    this.db = db; this.tenant = text(tenantId, 128); this.principal = text(principal, 128);
    this.resolveSource = resolveSource; this.resolveEvidence = resolveEvidence; this.now = now;
  }
  async one(sql, args = []) { return (await this.db.all(sql, args))[0] ?? null; }
  async context(id) {
    const row = await this.one('SELECT * FROM memory_use_contexts WHERE tenant_id=? AND principal=? AND id=?', [this.tenant, this.principal, id]);
    if (!row) fail('use_context_not_found');
    const source = await this.resolveSource(row.source_type, row.source_id);
    if (!source) fail('use_source_not_readable');
    return row;
  }
  async verifyEvidence(raw, scope) {
    const e = object(raw);
    if (!['decision', 'action', 'outcome', 'assessment'].includes(e.role)) fail('invalid_use_evidence_role');
    const refType = text(e.ref_type, 32), refId = text(e.ref_id, 4096);
    const start = e.span_start, end = e.span_end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end - start > 1000) fail('invalid_use_span');
    if (!/^[a-f0-9]{64}$/.test(e.content_hash)) fail('invalid_use_hash');
    const feedback = refType === 'use_feedback' ? await this.one('SELECT * FROM memory_use_feedback WHERE tenant_id=? AND principal=? AND id=?',[this.tenant,this.principal,refId]) : null;
    const proof = refType === 'use_feedback' ? (feedback ? {...feedback,verified:true} : null) : await this.resolveEvidence(refType, refId, scope);
    let reason = null;
    if (!proof) reason = 'source_unavailable';
    else if (proof.task_id !== scope.task_id || proof.project_id !== scope.project_id || proof.principal !== this.principal || proof.source_id !== scope.source_id || proof.usage_item_id !== scope.usage_item_id) reason = 'evidence_scope_mismatch';
    else if (Number.isFinite(proof.created_at) && proof.created_at > (scope.at ?? this.now())) reason = 'future_use_evidence';
    else if (proof.role !== e.role || proof.verified !== true) reason = 'evidence_role_unverified';
    else if (end > proof.text.length || await useHash(proof.text) !== e.content_hash) reason = 'evidence_hash_mismatch';
    return { ...e, ref_type: refType, ref_id: refId, verification_state: reason ? 'unverified' : 'verified', reason,
      excerpt: reason ? '' : proof.text.slice(start, end), contribution: reason ? null : proof.contribution ?? null };
  }
  async record(raw) {
    const input = object(raw), id = text(input.id, 128), hash = await useHash(input);
    const existing = await this.one('SELECT * FROM memory_use_contexts WHERE tenant_id=? AND id=?', [this.tenant, id]);
    if (existing) {
      if (existing.principal !== this.principal || existing.request_hash !== hash) fail('use_idempotency_conflict');
      await this.context(id);
      await this.rebuild(existing.project_id, existing.work_type);
      return { id, created: false, source_version:existing.source_version,verification_state:await this.live(existing)?'verified':'unverified' };
    }
    const item = await this.one(`SELECT i.*, e.project_id, e.task_id, e.requested_work_type, e.actor_principal
      FROM memory_usage_items i JOIN memory_usage_events e ON e.id=i.usage_event_id AND e.tenant_id=i.tenant_id
      WHERE i.tenant_id=? AND i.id=?`, [this.tenant, text(input.usage_item_id, 128)]);
    if (!item || item.actor_principal !== this.principal) fail('use_item_not_readable');
    const source = await this.resolveSource(item.source_type, item.source_id);
    if (!source) fail('use_source_not_readable');
    const project = text(input.project_id, 128), task = text(input.task_id, 256);
    if (item.project_id !== project || item.task_id !== task || (source.project_id && source.project_id !== project)) fail('use_context_scope_mismatch');
    const context = normalizeUseContext(input.context);
    const work = text(input.work_type ?? item.requested_work_type ?? 'unknown', 64);
    if (!WORK_TYPES.has(work)) fail('invalid_use_work_type');
    if (item.requested_work_type && work !== item.requested_work_type) fail('use_work_type_mismatch');
    const scope = {task_id: task, project_id: project, source_id: item.source_id, usage_item_id:item.id};
    if (!Array.isArray(input.evidence) || input.evidence.length > 6) fail('invalid_use_evidence');
    const evidence = await Promise.all(input.evidence.map(e => this.verifyEvidence(e, scope)));
    const verified = evidence.some(e => ['decision', 'action'].includes(e.role) && e.verification_state === 'verified');
    const version = Number.isInteger(item.source_version) && item.source_version > 0 ? item.source_version : null;
    const state = verified && version ? 'verified' : 'unverified';
    const previous = input.supersedes_id ? await this.context(input.supersedes_id) : null;
    if (previous && (previous.usage_item_id !== item.id || previous.revoked_at)) fail('invalid_use_supersession');
    if (previous && await this.one('SELECT id FROM memory_use_contexts WHERE tenant_id=? AND supersedes_id=?', [this.tenant, previous.id])) fail('use_supersedes_latest_required');
    const now = this.now();
    const commands = [{sql: `INSERT INTO memory_use_contexts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args:
      [id, this.tenant, item.id, item.source_type, item.source_id, version, project, task, work, this.principal,
        JSON.stringify(context), hash, state, previous?.id ?? null, null, now]}];
    for (const [index, e] of evidence.entries()) commands.push({sql: 'INSERT INTO memory_use_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', args:
      [`${id}:${index}`, this.tenant, id, e.role, e.ref_type, e.ref_id, e.span_start, e.span_end, e.content_hash, e.excerpt, e.verification_state, e.reason, now]});
    if (previous) commands.push({sql:'DELETE FROM memory_use_context_fts WHERE context_id=?', args:[previous.id]});
    if (state === 'verified') commands.push({sql:'INSERT INTO memory_use_context_fts(context_id,text) VALUES(?,?)', args:[id, useContextTokens(Object.values(context).join(' ')).join(' ')]});
    commands.push({sql:'DELETE FROM memory_use_statistics WHERE tenant_id=? AND source_id=?', args:[this.tenant, item.source_id]});
    try {await this.db.batch(commands);} catch(error) {
      if(await this.one('SELECT id FROM memory_use_contexts WHERE tenant_id=? AND id=?',[this.tenant,id])) return this.record(input);
      throw error;
    }
    await this.rebuild(project, work);
    return { id, created: true, verification_state: state, source_version: version, evidence: evidence.map(e => ({role:e.role, verification_state:e.verification_state, reason:e.reason})) };
  }
  async evaluate(raw) {
    const input = object(raw), id = text(input.id, 128), hash = await useHash(input);
    const context = await this.context(text(input.context_id, 128));
    const old = await this.one('SELECT * FROM memory_use_evaluations WHERE tenant_id=? AND id=?', [this.tenant,id]);
    if (old) { if (old.context_id !== context.id || old.request_hash !== hash) fail('use_idempotency_conflict'); await this.rebuild(context.project_id,context.work_type); return {id,created:false,outcome:old.outcome,assessment:JSON.parse(old.assessment_json),verification_state:old.verification_state}; }
    if (context.revoked_at) fail('use_context_revoked');
    if (input.effect_event_id) {
      const effect = await this.one(`SELECT e.id FROM memory_effect_events e JOIN memory_effect_attributions a ON a.effect_event_id=e.id AND a.tenant_id=e.tenant_id
        WHERE e.tenant_id=? AND e.id=? AND a.usage_item_id=?`, [this.tenant,input.effect_event_id,context.usage_item_id]);
      if (!effect) fail('use_effect_attribution_required');
    }
    const evidence = await this.db.all('SELECT * FROM memory_use_evidence WHERE tenant_id=? AND context_id=?', [this.tenant,context.id]);
    const proof = evidence.find(e => e.id === input.proof_id && e.role === 'assessment');
    let checked = proof ? await this.verifyEvidence(proof,context) : null;
    let proofId = text(input.proof_id,256,false);
    const commands=[];
    if (input.feedback) {
      const feedback=object(input.feedback);
      if (!['positive','negative','unknown'].includes(feedback.contribution)) fail('invalid_use_contribution');
      const statement=text(feedback.statement,600);
      normalizeUseContext({task:statement,target:'explicit use assessment'});
      const refId=`${id}:feedback`;
      proofId=refId;
      commands.push({sql:'INSERT INTO memory_use_feedback VALUES(?,?,?,?,?,?,?,?,?,?,?)',args:[refId,this.tenant,this.principal,context.project_id,context.task_id,context.source_id,context.usage_item_id,'assessment',statement,feedback.contribution,this.now()]});
      commands.push({sql:'INSERT INTO memory_use_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',args:[refId,this.tenant,context.id,'assessment','use_feedback',refId,0,statement.length,await useHash(statement),statement,'verified',null,this.now()]});
      checked={verification_state:'verified',contribution:feedback.contribution};
    }
    if (!proofId) fail('use_assessment_required');
    const allValid = await this.live(context, evidence);
    const hasOutcome = evidence.some(e => e.role === 'outcome' && e.verification_state === 'verified');
    const supported = allValid && hasOutcome && checked?.verification_state === 'verified';
    const outcome = supported && ['positive','negative'].includes(checked.contribution) ? checked.contribution : 'unknown';
    const assessment = assessMemoryUsefulnessV2({stage:'use',basis:'observed',evidence_supported:allValid,
      applicable:allValid, task_contribution:outcome==='positive' ? true : null,
      incremental_value:null, within_budget:true});
    const latest = await this.one(`SELECT e.id FROM memory_use_evaluations e WHERE tenant_id=? AND context_id=?
      AND NOT EXISTS(SELECT 1 FROM memory_use_evaluations x WHERE x.tenant_id=e.tenant_id AND x.supersedes_id=e.id)`, [this.tenant,context.id]);
    if ((latest?.id ?? null) !== (input.supersedes_id ?? null)) fail('use_evaluation_supersedes_latest_required');
    commands.push({sql:'INSERT INTO memory_use_evaluations VALUES(?,?,?,?,?,?,?,?,?,?,?)',args:
      [id,this.tenant,context.id,input.effect_event_id??null,JSON.stringify(assessment),outcome,supported?'verified':'unverified',proofId,hash,latest?.id??null,this.now()]});
    try {await this.db.batch(commands);} catch(error) {
      if(await this.one('SELECT id FROM memory_use_evaluations WHERE tenant_id=? AND id=?',[this.tenant,id])) return this.evaluate(input);
      throw error;
    }
    await this.rebuild(context.project_id,context.work_type);
    return {id,created:true,outcome,assessment,verification_state:supported?'verified':'unverified'};
  }
  async live(row, supplied, resolveSource=this.resolveSource) {
    if (row.revoked_at || row.verification_state !== 'verified' || !row.source_version) return false;
    const source = await resolveSource(row.source_type, row.source_id);
    if (!source || source.current_version !== row.source_version) return false;
    const evidence = supplied ?? await this.db.all('SELECT * FROM memory_use_evidence WHERE tenant_id=? AND context_id=?', [this.tenant,row.id]);
    const accepted = evidence.filter(e => e.verification_state === 'verified' && e.created_at <= (row.at ?? this.now()));
    if (!accepted.length) return false;
    return (await Promise.all(accepted.map(e => this.verifyEvidence(e,row)))).every(e => e.verification_state === 'verified');
  }
  async revoke(id) {
    const row = await this.context(id);
    await this.db.batch([{sql:'UPDATE memory_use_contexts SET revoked_at=COALESCE(revoked_at,?) WHERE tenant_id=? AND id=?',args:[this.now(),this.tenant,id]}]);
    await this.rebuild(row.project_id,row.work_type);
    return {id,revoked:true};
  }
  async history({source_id=null,project_id=null,limit=20,before=null}={}) {
    limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_use_limit');
    const cursor=before ? await this.one('SELECT id,created_at FROM memory_use_contexts WHERE tenant_id=? AND principal=? AND id=?',[this.tenant,this.principal,text(before,128)]) : null;
    if(before&&!cursor) fail('invalid_use_cursor');
    const rows = await this.db.all(`SELECT * FROM memory_use_contexts WHERE tenant_id=? AND principal=?
      AND (? IS NULL OR source_id=?) AND (? IS NULL OR project_id=?) AND (? IS NULL OR created_at<? OR (created_at=? AND id<?))
      ORDER BY created_at DESC,id DESC LIMIT ?`, [this.tenant,this.principal,source_id,source_id,project_id,project_id,cursor?.id??null,cursor?.created_at??null,cursor?.created_at??null,cursor?.id??null,limit+1]);
    const result = [];
    for (const row of rows.slice(0,limit)) {
      if (!await this.resolveSource(row.source_type,row.source_id)) continue;
      const evidence = await this.db.all('SELECT * FROM memory_use_evidence WHERE tenant_id=? AND context_id=?',[this.tenant,row.id]);
      const visible = [];
      for (const e of evidence) { const v = await this.verifyEvidence(e,row); visible.push({...e,excerpt:v.excerpt,verification_state:v.verification_state,reason:v.reason}); }
      const evaluations = await this.db.all('SELECT * FROM memory_use_evaluations WHERE tenant_id=? AND context_id=? ORDER BY created_at,id',[this.tenant,row.id]);
      result.push({...row,context:JSON.parse(row.context_json),evidence:visible,evaluations,stages:{retrieved:true,adopted:visible.some(e=>['decision','action'].includes(e.role)&&e.verification_state==='verified'),executed:visible.some(e=>e.role==='action'&&e.verification_state==='verified'),outcome_confirmed:visible.some(e=>e.role==='outcome'&&e.verification_state==='verified')},live:await this.live(row,evidence)});
    }
    return {items:result,next_cursor:rows.length>limit?rows[limit-1].id:null,policy:MEMORY_USE_POLICY};
  }
  async rebuild(project, work) {
    const at = this.now();
    const rows = await this.db.all(`SELECT c.*, e.id AS evaluation_id,e.outcome,e.created_at AS evaluated_at
      FROM memory_use_contexts c JOIN memory_use_evaluations e ON e.context_id=c.id AND e.tenant_id=c.tenant_id
      WHERE c.tenant_id=? AND c.principal=? AND c.project_id=? AND c.work_type=? AND c.revoked_at IS NULL
      AND c.verification_state='verified' AND e.verification_state='verified' AND e.created_at<=?
      AND (e.effect_event_id IS NULL OR EXISTS(SELECT 1 FROM memory_effect_events f WHERE f.tenant_id=e.tenant_id AND f.id=e.effect_event_id
        AND NOT EXISTS(SELECT 1 FROM memory_effect_events n WHERE n.tenant_id=f.tenant_id AND n.supersedes_effect_id=f.id)))
      AND NOT EXISTS(SELECT 1 FROM memory_use_contexts n WHERE n.tenant_id=c.tenant_id AND n.supersedes_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM memory_use_evaluations n WHERE n.tenant_id=e.tenant_id AND n.supersedes_id=e.id)
      ORDER BY e.created_at DESC,e.id DESC`, [this.tenant,this.principal,project,work,at]);
    const seen = new Set(), totals = new Map();
    for (const row of rows) {
      const taskKey = `${row.source_type}:${row.source_id}:${row.source_version}:${row.task_id}`;
      if (seen.has(taskKey)) continue;
      if (!await this.live(row)) continue;
      seen.add(taskKey);
      if (!['positive','negative'].includes(row.outcome) || work==='unknown') continue;
      const ctx=JSON.parse(row.context_json);
      const key = JSON.stringify([row.source_type,row.source_id,row.source_version,ctx.constraints,ctx.conditions]);
      const sum = totals.get(key) ?? {source_type:row.source_type,source_id:row.source_id,source_version:row.source_version,positive:0,negative:0,evaluation_count:0,context_ids:[],constraints_key:ctx.constraints,conditions_key:ctx.conditions};
      sum[row.outcome] += 2 ** (-(at-row.evaluated_at)/MEMORY_USE_HALF_LIFE_MS); sum.evaluation_count++; sum.context_ids.push(row.id);
      totals.set(key,sum);
    }
    const values = [...totals.values()].sort((a,b)=>a.source_id.localeCompare(b.source_id));
    const snapshot = await useHash({policy:MEMORY_USE_POLICY,tenant:this.tenant,principal:this.principal,project,work,at,values});
    const commands = [{sql:'DELETE FROM memory_use_statistics WHERE tenant_id=? AND principal=? AND project_id=? AND work_type=?',args:[this.tenant,this.principal,project,work]},
      {sql:'INSERT OR IGNORE INTO memory_use_snapshots VALUES(?,?,?,?,?,?,?,?,?)',args:[snapshot,this.tenant,this.principal,project,work,MEMORY_USE_POLICY,at,JSON.stringify(values),null]}];
    for (const v of values) commands.push({sql:'INSERT INTO memory_use_statistics VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',args:
      [this.tenant,this.principal,project,work,v.source_type,v.source_id,v.source_version,v.positive,v.negative,v.evaluation_count,snapshot,at,JSON.stringify(v.context_ids),v.constraints_key,v.conditions_key]});
    await this.db.batch(commands); return {snapshot_id:snapshot,as_of:at,statistics:values};
  }
  async search({query,project_id,work_type,task_id,context={},base=[],context_enabled=false,ranking_enabled=false,limit=5,at=this.now(),snapshot_id=null,source_types=['memory'],filter_candidates=null}) {
    const meta = {policy:MEMORY_USE_POLICY,context_enabled,ranking_enabled,degraded_reasons:[]};
    if(!context_enabled&&!ranking_enabled) return {results:base.slice(0,limit),meta};
    if (!project_id || !work_type || !task_id) return {results:base.slice(0,limit),meta:{...meta,degraded_reasons:['use_context_incomplete']}};
    const sourceCache=new Map();
    const sourceFor=(type,id)=>{const key=`${type}:${id}`;if(!sourceCache.has(key)) sourceCache.set(key,this.resolveSource(type,id));return sourceCache.get(key);};
    const liveCache=new Map();
    const liveFor=(row,evidence)=>{if(!liveCache.has(row.id)) liveCache.set(row.id,this.live({...row,at},evidence,sourceFor));return liveCache.get(row.id);};
    const tokens = useContextTokens(query);
    let matches = [];
    if (context_enabled && tokens.length) {
      matches = await this.db.all(`SELECT c.*,bm25(memory_use_context_fts) AS rank FROM memory_use_context_fts f
        JOIN memory_use_contexts c ON c.id=f.context_id WHERE memory_use_context_fts MATCH ?
        AND c.tenant_id=? AND c.principal=? AND c.project_id=? AND c.work_type=? AND c.task_id!=?
        AND c.created_at<=? AND c.revoked_at IS NULL AND c.verification_state='verified'
        AND NOT EXISTS(SELECT 1 FROM memory_use_contexts n WHERE n.tenant_id=c.tenant_id AND n.supersedes_id=c.id)
        ORDER BY rank,c.id LIMIT 100`, [tokens.map(t=>'"'+t+'"').join(' OR '),this.tenant,this.principal,project_id,work_type,task_id,at]);
    }
    const merged = new Map(base.map(x=>[`${x.kind??'memory'}:${x.id}`,{...x}]));
    const examples = new Map();
    const baselineTop = Math.max(0,...base.map(x=>Number(x.score)||0));
    for (const row of matches) {
      if(!source_types.includes(row.source_type)) continue;
      const ctx = JSON.parse(row.context_json);
      if (!useConditionsMatch(ctx,context)) continue;
      const key = `${row.source_type}:${row.source_id}`;
      const contextTokens=new Set(useContextTokens(Object.values(ctx).join(' ')));
      const matched = tokens.filter(t=>contextTokens.has(t)).length / tokens.length;
      const candidateScore = Math.max(baselineTop,0.02) * matched;
      const old = merged.get(key);
      if (examples.has(key) && old?.score >= candidateScore) continue;
      if (!await liveFor(row)) continue;
      const source = await sourceFor(row.source_type,row.source_id);
      if (!old || candidateScore > old.score) merged.set(key,{...old,...source,id:row.source_id,kind:row.source_type,score:candidateScore,current_version:row.source_version});
      const list = examples.get(key) ?? [];
      if (list.length<1) list.push({id:row.id,task_id:row.task_id,context:{task:ctx.task.slice(0,160),target:ctx.target.slice(0,80),constraints:ctx.constraints.slice(0,80),conditions:ctx.conditions.slice(0,80)},match:matched});
      examples.set(key,list);
    }
    if(filter_candidates) {
      const allowed=new Set((await filter_candidates([...merged.values()])).map(x=>`${x.kind??'memory'}:${x.id}`));
      for(const key of merged.keys()) if(!allowed.has(key)) merged.delete(key);
    }
    let stats = [];
    if (ranking_enabled && merged.size) {
      try {
        if(snapshot_id) {
          const snapshot=await this.one('SELECT * FROM memory_use_snapshots WHERE id=? AND tenant_id=? AND principal=? AND project_id=? AND work_type=? AND policy=? AND as_of<=? AND (invalidated_at IS NULL OR invalidated_at>?)',[snapshot_id,this.tenant,this.principal,project_id,work_type,MEMORY_USE_POLICY,at,at]);
          if(!snapshot) throw new Error('snapshot_unavailable');
          stats=JSON.parse(snapshot.statistics_json).map(s=>({...s,snapshot_id:snapshot.id,as_of:snapshot.as_of,context_ids_json:JSON.stringify(s.context_ids)}));
        } else {
          const ids=[...new Set([...merged.values()].map(x=>x.id))];
          for(let start=0;start<ids.length;start+=90) {
            const batch=ids.slice(start,start+90);
            stats.push(...await this.db.all(`SELECT * FROM memory_use_statistics WHERE tenant_id=? AND principal=? AND project_id=? AND work_type=?
              AND as_of<=? AND source_id IN (${batch.map(()=>'?').join(',')})`,[this.tenant,this.principal,project_id,work_type,at,...batch]));
          }
        }
      } catch { stats=[];meta.degraded_reasons.push('use_statistics_unavailable'); }
    }
    const contextIds=[...new Set(stats.flatMap(s=>JSON.parse(s.context_ids_json)))];
    let provenance=[],evidenceRows=[];
    if(contextIds.length>2000) {stats=[];meta.degraded_reasons.push('use_provenance_budget_exceeded');}
    else if(contextIds.length) {
      try {
      // Bound D1 parameter counts. This is batch provenance validation, never per-candidate SQL.
      for(let start=0;start<contextIds.length;start+=90) {
        const ids=contextIds.slice(start,start+90),params=ids.map(()=>'?').join(',');
        provenance.push(...await this.db.all(`SELECT * FROM memory_use_contexts WHERE tenant_id=? AND principal=? AND id IN (${params})`,[this.tenant,this.principal,...ids]));
        evidenceRows.push(...await this.db.all(`SELECT * FROM memory_use_evidence WHERE tenant_id=? AND context_id IN (${params})`,[this.tenant,...ids]));
      }
      } catch {stats=[];meta.degraded_reasons.push('use_provenance_unavailable');}
    }
    const result = [];
    for (const [key,item] of merged) {
      const source = item.kind==='doc'?null:await sourceFor(item.kind??'memory',item.id);
      if (item.kind!=='doc' && !source) continue;
      const applicable=stats.filter(s=>s.source_id===item.id && s.source_type===(item.kind??'memory') && s.source_version===source?.current_version
        && useConditionsMatch({constraints:s.constraints_key,conditions:s.conditions_key},context));
      let stat=applicable.length ? {...applicable[0],positive:applicable.reduce((n,s)=>n+s.positive,0),negative:applicable.reduce((n,s)=>n+s.negative,0),
        evaluation_count:applicable.reduce((n,s)=>n+s.evaluation_count,0),context_ids_json:JSON.stringify(applicable.flatMap(s=>JSON.parse(s.context_ids_json)))} : null;
      // Exact task exclusion, conditions and live evidence must hold for EVERY contributing record.
      if (stat) {
        const ids=JSON.parse(stat.context_ids_json);
        const rows=provenance.filter(r=>ids.includes(r.id));
        if (rows.length!==ids.length || rows.some(r=>r.task_id===task_id || !useConditionsMatch(JSON.parse(r.context_json),context)) || !(await Promise.all(rows.map(r=>liveFor(r,evidenceRows.filter(e=>e.context_id===r.id))))).every(Boolean)) {
          stat=null; meta.degraded_reasons.push('use_statistics_inapplicable');
        }
      }
      const before = item.score;
      // Governance rank is protected; scores are not a license to bypass it.
      const protectedKind = ['decision','constraint'].includes(source?.memory_kind ?? source?.kind);
      const after = stat && !protectedKind ? useScore(before,stat.positive,stat.negative) : before;
      result.push({...item,memory_kind:source?.memory_kind??item.memory_kind,score:after,use_history:{base_score:before,adjusted_score:after,
        evaluation_count:stat?.evaluation_count??0,snapshot_id:stat?.snapshot_id??null,
        as_of:stat?.as_of??null,policy:MEMORY_USE_POLICY,examples:examples.get(key)??[]}});
    }
    // Keep protected entries in their original slots; only reorder the remaining candidates.
    const normal = result.filter(x=>!['decision','constraint'].includes(x.memory_kind)).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
    let cursor=0;
    const ordered=result.map(x=>['decision','constraint'].includes(x.memory_kind)?x:normal[cursor++]);
    return {results:ordered.slice(0,limit),meta:{...meta,snapshot_ids:[...new Set(result.map(x=>x.use_history.snapshot_id).filter(Boolean))],degraded_reasons:[...new Set(meta.degraded_reasons)]}};
  }
}

export function observeMemoryUse(input) {
  if(!input || typeof input!=='object') throw new Error('invalid_use_observation');
  for(const field of ['usage_id','usage_item_id','source_id','task_id','project_id','action_call_id']) {
    if(typeof input[field]!=='string'||!input[field]||input[field].length>256) throw new Error(`invalid_use_${field}`);
  }
  if(!Number.isInteger(input.source_version)||input.source_version<1) throw new Error('use_version_required');
  normalizeUseContext(input.context);
  return {accepted:true,persisted:false,record_type:'memory_use_observation',observation:input};
}

