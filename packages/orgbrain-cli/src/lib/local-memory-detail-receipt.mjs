import { randomUUID } from 'node:crypto';
import { localUseFlags } from './local-memory-use.mjs';

// Match the local observation receipt lifetime so longer user turns can
// complete a pinned read and reach Stop without losing the proof.
export const LOCAL_MEMORY_DETAIL_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

const RECEIPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS local_memory_detail_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_principal TEXT NOT NULL,
  request_principal TEXT,
  project_id TEXT,
  business_category_id TEXT,
  work_type TEXT,
  source_type TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_memory_detail_receipt_scope
  ON local_memory_detail_receipts(tenant_id, actor_principal, memory_id, source_version, expires_at);
`;

function optionalText(value) {
  return typeof value === 'string' ? value : null;
}

export async function issueLocalMemoryDetailReceipt(store, { tenantId, input, result,
  actorPrincipal = process.env.ORGBRAIN_USE_PRINCIPAL || 'local', now = Date.now() }) {
  const memory = result?.memory;
  if (!memory || typeof memory.content !== 'string' || memory.id !== input.memory_id
    || memory.current_version !== input.expected_version) return null;
  await store.init();
  const db = store.open();
  try {
    if (!localUseFlags(db).collect) return null;
    db.exec(RECEIPT_SCHEMA);
    const id = `orgbrain-detail-receipt:${randomUUID()}`;
    db.prepare('DELETE FROM local_memory_detail_receipts WHERE expires_at<=?').run(now);
    db.prepare(`INSERT INTO local_memory_detail_receipts
      (id,tenant_id,actor_principal,request_principal,project_id,business_category_id,work_type,
       source_type,memory_id,source_version,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, tenantId, actorPrincipal, optionalText(input.principal_id), optionalText(input.project_id),
      optionalText(input.business_category_id), optionalText(input.work_type), 'memory', memory.id,
      memory.current_version, now, now + LOCAL_MEMORY_DETAIL_RECEIPT_TTL_MS
    );
    return id;
  } finally { db.close(); }
}

export function readLocalMemoryDetailReceipt(db, id, { tenantId, actorPrincipal, now = Date.now() }) {
  if (typeof id !== 'string' || !/^orgbrain-detail-receipt:[0-9a-f-]{36}$/u.test(id)) return null;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_memory_detail_receipts'").get();
  if (!exists) return null;
  return db.prepare(`SELECT * FROM local_memory_detail_receipts
    WHERE id=? AND tenant_id=? AND actor_principal=? AND created_at<=? AND expires_at>?`)
    .get(id, tenantId, actorPrincipal, now, now) ?? null;
}

export function localMemoryDetailReceiptRequestScope(row) {
  return {
    tenant_id: row.tenant_id,
    principal_id: row.request_principal ?? null,
    project_id: row.project_id ?? null,
    business_category_id: row.business_category_id ?? null,
    work_type: row.work_type ?? null,
    memory_id: row.memory_id,
    expected_version: row.source_version
  };
}
