import { createHash } from 'node:crypto';
import { definiteTransientReason } from '@org-brain/shared/runtime/memory-admission-runtime';
import { memoryFromRow } from './local-memory-record.mjs';
import { hasTable } from './local-memory-schema.mjs';

const DAY = 86_400_000;
const GRACE_DAYS = 30;
const POLICY = 'local-transient/v1';
const RUN_LIMIT = 10;
const dayInTokyo = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' });
const legacySources = new Set(['codex', 'claude', 'cursor', 'openclaw', 'opencode']);

function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_memory_retention_policy(
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, policy TEXT NOT NULL,
    first_observed_at INTEGER NOT NULL, observed_days_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(tenant_id, project_id)
  );
  CREATE TABLE IF NOT EXISTS local_memory_retention_queue(
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    version INTEGER NOT NULL, content_hash TEXT NOT NULL, reason TEXT NOT NULL,
    purge_after INTEGER, PRIMARY KEY(tenant_id, memory_id)
  );`);
}

function automaticReason(db, memory) {
  if (!memory.project_id || memory.scope_type !== 'project' || memory.scope_key !== memory.project_id
    || memory.deleted_at != null || memory.owner_principal || memory.permissions?.length || memory.conflicts?.length
    || ['decision', 'constraint', 'preference'].includes(memory.kind)
    || memory.tags.some(tag => ['user-confirmed-learning', 'curated-memory', 'explicit-user-answer'].includes(tag))) return null;
  const legacy = legacySources.has(memory.source) && memory.content.startsWith('# Reusable Memory')
    && ['legacy', 'realtime_hook'].includes(memory.capture_route);
  const classified = memory.source === 'classified-auto' && memory.capture_route === 'realtime_hook'
    && memory.learning?.contract_metadata?.classification_policy === 'classified-auto/v2';
  if (!legacy && !classified) return null;
  const reason = definiteTransientReason(memory);
  if (!reason) return null;

  const { tenant_id: tenant, project_id: project, id } = memory;
  const protectedMemory = db.prepare(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM retention_policies WHERE tenant_id=$tenant AND legal_hold=1 AND (project_id IS NULL OR project_id=$project))
    OR EXISTS(SELECT 1 FROM memory_edges WHERE tenant_id=$tenant AND (from_memory_id=$id OR to_memory_id=$id))
    OR EXISTS(SELECT 1 FROM memory_integrity_relations WHERE tenant_id=$tenant AND status IN ('proposed','confirmed') AND (from_memory_id=$id OR to_memory_id=$id))
    OR EXISTS(SELECT 1 FROM memory_quality_feedback WHERE tenant_id=$tenant AND memory_id=$id AND status IN ('reported','confirmed'))
    OR EXISTS(SELECT 1 FROM memories m WHERE m.tenant_id=$tenant AND m.id<>$id AND m.lifecycle_state='active' AND m.deleted_at IS NULL
      AND (m.root_memory_id=$id OR EXISTS(
        SELECT 1 FROM json_each(m.evidence_json) e
        WHERE COALESCE(json_extract(e.value,'$.type'),json_extract(e.value,'$.evidence_type'))='memory'
          AND COALESCE(json_extract(e.value,'$.ref'),json_extract(e.value,'$.evidence_ref'))=$id
        UNION ALL SELECT 1 FROM json_each(m.source_refs_json) r
        WHERE json_extract(r.value,'$.type')='memory' AND json_extract(r.value,'$.ref')=$id)))
    OR EXISTS(SELECT 1 FROM memory_use_contexts c JOIN memory_use_evaluations e ON e.tenant_id=c.tenant_id AND e.context_id=c.id
      WHERE c.tenant_id=$tenant AND c.source_type='memory' AND c.source_id=$id AND c.revoked_at IS NULL
        AND c.verification_state='verified' AND e.verification_state='verified' AND e.outcome='positive'
        AND NOT EXISTS(SELECT 1 FROM memory_use_evaluations n WHERE n.tenant_id=e.tenant_id AND n.supersedes_id=e.id))`)
    .get({ tenant, project, id });
  return protectedMemory ? null : reason;
}

function planDigest(tenantId, projectId, candidates) {
  return createHash('sha256').update(JSON.stringify([POLICY, tenantId, projectId, candidates])).digest('hex');
}

function plans(db, tenantId, projectId, initialized) {
  const exclusions = initialized ? new Map(db.prepare(`SELECT memory_id,content_hash FROM local_memory_retention_queue WHERE tenant_id=?`)
    .all(tenantId).map(row => [row.memory_id, row.content_hash])) : new Map();
  const candidates = [];
  const projects = new Set();
  const rows = db.prepare(`SELECT * FROM memories WHERE tenant_id=? AND project_id IS NOT NULL AND scope_type='project'
    AND (? IS NULL OR project_id=?) AND lifecycle_state='active' AND deleted_at IS NULL ORDER BY id`);
  for (const row of rows.iterate(tenantId, projectId, projectId)) {
    projects.add(row.project_id);
    if (exclusions.get(row.id) === row.content_hash) continue;
    const reason = automaticReason(db, memoryFromRow(row));
    if (reason) candidates.push({ id: row.id, project_id: row.project_id, version: row.current_version, content_hash: row.content_hash, reason });
  }
  const planHash = planDigest(tenantId, projectId, candidates);
  return { candidates, projects, planHash };
}

export async function inspectRetention(store, { tenantId = 'default', projectId = null } = {}) {
  const db = store.open({ readOnly: true });
  try {
    const initialized = hasTable(db, 'local_memory_retention_policy');
    const { candidates, planHash } = plans(db, tenantId, projectId, initialized);
    const policies = initialized ? db.prepare(`SELECT * FROM local_memory_retention_policy WHERE tenant_id=? AND (? IS NULL OR project_id=?) ORDER BY project_id`)
      .all(tenantId, projectId, projectId).map(p => {
        const observations = JSON.parse(p.observed_days_json);
        return { project_id: p.project_id, enabled: p.policy === POLICY && p.enabled === 1,
          first_observed_at: p.first_observed_at, observed_days: observations.length, ...(projectId ? { observations } : {}) };
      }) : [];
    const pending = initialized ? db.prepare(`SELECT memory_id,project_id,reason,purge_after FROM local_memory_retention_queue
      WHERE tenant_id=? AND (? IS NULL OR project_id=?) AND purge_after IS NOT NULL ORDER BY purge_after,memory_id`).all(tenantId, projectId, projectId) : [];
    // The digest includes the record hashes; no memory text enters scheduled logs.
    return { plan_hash: planHash, candidates: candidates.map(({ content_hash, ...entry }) => entry), policies, pending };
  } finally { db.close(); }
}

function transaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = run();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function setRetentionPolicy(store, { tenantId = 'default', projectId, enable, expectedPlanHash, now = Date.now() }) {
  if (!projectId || tenantId === 'all') throw Error('retention_project_required');
  await store.init();
  const db = store.open();
  try {
    initialize(db);
    return transaction(db, () => {
      const policy = db.prepare(`SELECT * FROM local_memory_retention_policy WHERE tenant_id=? AND project_id=?`).get(tenantId, projectId);
      if (enable) {
        const observations = policy?.policy === POLICY ? JSON.parse(policy.observed_days_json) : [];
        const last = observations.at(-1);
        if (observations.length < 7 || now - policy.first_observed_at < 7 * DAY || !Number.isFinite(last.at)
          || now - last.at > 2 * DAY || now < last.at) {
          throw Error('retention_shadow_incomplete');
        }
        if (expectedPlanHash !== last.plan_hash || expectedPlanHash !== plans(db, tenantId, projectId, true).planHash) {
          throw Error('retention_plan_changed');
        }
      }
      db.prepare(`UPDATE local_memory_retention_policy SET enabled=? WHERE tenant_id=? AND project_id=?`).run(Number(enable), tenantId, projectId);
      return { project_id: projectId, enabled: enable === true };
    });
  } finally { db.close(); }
}

export async function keepMemory(store, { tenantId = 'default', projectId, memoryId }) {
  if (!projectId || !memoryId || tenantId === 'all') throw Error('retention_project_and_memory_required');
  await store.init();
  const db = store.open();
  try {
    initialize(db);
    return transaction(db, () => {
      const row = db.prepare(`SELECT current_version,content_hash FROM memories WHERE id=? AND tenant_id=? AND project_id=?`).get(memoryId, tenantId, projectId);
      if (!row) throw Error('retention_memory_not_found');
      db.prepare(`INSERT INTO local_memory_retention_queue VALUES(?,?,?,?,?,'keep',NULL)
        ON CONFLICT(tenant_id,memory_id) DO UPDATE SET version=excluded.version,content_hash=excluded.content_hash,reason='keep',purge_after=NULL`)
        .run(tenantId, projectId, memoryId, row.current_version, row.content_hash);
      return { kept: true, project_id: projectId };
    });
  } finally { db.close(); }
}

function observeProjects(db, tenantId, projects, candidates, now) {
  const day = dayInTokyo.format(now);
  for (const project of projects) {
    const row = db.prepare(`SELECT * FROM local_memory_retention_policy WHERE tenant_id=? AND project_id=?`).get(tenantId, project);
    const current = row?.policy === POLICY ? row : null;
    const scoped = candidates.filter(item => item.project_id === project);
    const receipt = { day, at: now, plan_hash: planDigest(tenantId, project, scoped),
      candidates: scoped.map(({ id, version, reason }) => ({ id, version, reason })) };
    const previous = current ? JSON.parse(current.observed_days_json) : [];
    const days = [...previous.filter(item => item.day !== day), receipt].slice(-14);
    db.prepare(`INSERT INTO local_memory_retention_policy VALUES(?,?,?,?,?,?)
      ON CONFLICT(tenant_id,project_id) DO UPDATE SET policy=excluded.policy,first_observed_at=excluded.first_observed_at,
      observed_days_json=excluded.observed_days_json,enabled=excluded.enabled`)
      .run(tenantId, project, POLICY, current?.first_observed_at ?? now, JSON.stringify(days), current?.enabled ?? 0);
  }
}

export async function runMemoryRetention(store, { tenantId = 'default', now = Date.now(), observeOnly = false } = {}) {
  if (tenantId === 'all') throw Error('retention_private_tenant_required');
  await store.init();
  const db = store.open();
  let outcomes;
  try {
    initialize(db);
    outcomes = transaction(db, () => {
      if (observeOnly) {
        const { candidates, projects } = plans(db, tenantId, null, true);
        observeProjects(db, tenantId, projects, candidates, now);
        return { candidate_count: candidates.length, enabled_projects: 0, suppressed: 0, due: [] };
      }
      // Restored, revised, or manually deleted rows cannot retain an old purge deadline.
      db.prepare(`UPDATE local_memory_retention_queue AS q SET purge_after=NULL,reason='keep'
        WHERE q.tenant_id=? AND q.purge_after IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memories m
          WHERE m.tenant_id=q.tenant_id AND m.id=q.memory_id AND m.lifecycle_state='suppressed'
             AND m.current_version=q.version AND m.content_hash=q.content_hash)`).run(tenantId);
      const { candidates, projects } = plans(db, tenantId, null, true);
      observeProjects(db, tenantId, projects, candidates, now);
      const enabled = new Set(db.prepare(`SELECT project_id FROM local_memory_retention_policy WHERE tenant_id=? AND policy=? AND enabled=1`)
        .all(tenantId, POLICY).map(p => p.project_id));
      let suppressed = 0;
      for (const item of candidates.filter(item => enabled.has(item.project_id)).slice(0, RUN_LIMIT)) {
        const row = db.prepare(`SELECT * FROM memories WHERE id=? AND tenant_id=?`).get(item.id, tenantId);
        const current = memoryFromRow(row);
        const record = store.normalizeRecord({ ...current, lifecycle_state: 'suppressed', current_version: current.current_version + 1,
          updated_at: now }, current);
        record.suppressed_at = now;
        store.writeRecord(db, record, true);
        store.writeVersion(db, record, 'suppress');
        db.prepare(`INSERT INTO local_memory_retention_queue VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id,memory_id) DO UPDATE SET version=excluded.version, content_hash=excluded.content_hash,
          reason=excluded.reason, purge_after=excluded.purge_after`)
          .run(tenantId, item.project_id, item.id, record.current_version, record.content_hash, item.reason, now + GRACE_DAYS * DAY);
        suppressed++;
      }
      const due = db.prepare(`SELECT q.* FROM local_memory_retention_queue q JOIN local_memory_retention_policy p
        ON p.tenant_id=q.tenant_id AND p.project_id=q.project_id AND p.enabled=1 AND p.policy=?
        WHERE q.tenant_id=? AND q.purge_after<=? ORDER BY q.purge_after,q.memory_id`)
        .all(POLICY, tenantId, now);
      return { candidate_count: candidates.length, enabled_projects: enabled.size, suppressed, due };
    });
  } finally { db.close(); }
  const { due, ...counts } = outcomes;
  let purged = 0;
  for (const item of due) {
    if (purged >= RUN_LIMIT) break;
    const result = await store.delete(tenantId, item.memory_id, { actor_type: 'system', actor_id: 'local-memory-retention' }, {
      guard(db, current) {
        const scheduled = db.prepare(`SELECT q.* FROM local_memory_retention_queue q JOIN local_memory_retention_policy p
          ON p.tenant_id=q.tenant_id AND p.project_id=q.project_id AND p.enabled=1 AND p.policy=?
          WHERE q.tenant_id=? AND q.memory_id=? AND q.purge_after<=?`).get(POLICY, tenantId, item.memory_id, now);
        return scheduled?.version === current.current_version && scheduled.content_hash === current.content_hash
          && scheduled.project_id === current.project_id && current.lifecycle_state === 'suppressed'
          && automaticReason(db, memoryFromRow(current)) === scheduled.reason;
      }
    });
    if (result.operation === 'delete') purged++;
  }
  return { ...counts, purged, deferred: due.length - purged };
}
