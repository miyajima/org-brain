CREATE TABLE IF NOT EXISTS decision_memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  domain TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  rejected_alternatives_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  known_pitfalls_json TEXT NOT NULL DEFAULT '[]',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  owner_refs_json TEXT NOT NULL DEFAULT '[]',
  valid_from INTEGER,
  valid_until INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  visibility TEXT NOT NULL DEFAULT 'tenant',
  allowed_principals_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_memories_search
ON decision_memories(tenant_id, project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_memories_title
ON decision_memories(tenant_id, title);

INSERT INTO decision_memories(
  id,
  tenant_id,
  project_id,
  domain,
  title,
  decision,
  rationale,
  rejected_alternatives_json,
  constraints_json,
  known_pitfalls_json,
  source_refs_json,
  owner_refs_json,
  valid_from,
  valid_until,
  status,
  superseded_by,
  confidence,
  visibility,
  allowed_principals_json,
  created_at,
  updated_at
)
VALUES(
  'dm_seed_context_engine_auth',
  'default',
  'context-engine-mvp',
  'engineering',
  '新規認証処理はnew_auth_providerへ統一',
  'legacy_authは新規実装で使わない',
  '移行中の二重管理を避け、auth_service経由の認証処理へ寄せるため。',
  '[{"alternative":"legacy_authを継続利用する","reasonRejected":"PR#182とADR-014で新規利用を避ける方針になったため"}]',
  '["auth_serviceを経由すること","direct DB accessを避けること"]',
  '["READMEの認証セクションは古い可能性がある","旧方式前提のテストが残っている可能性がある"]',
  '[{"type":"adr","id":"ADR-014","title":"Auth Provider Migration","updatedAt":"2026-03-12"},{"type":"merged_pr","id":"PR#182","title":"Move auth flows to new_auth_provider","updatedAt":"2026-03-12"}]',
  '[]',
  NULL,
  NULL,
  'active',
  NULL,
  0.88,
  'tenant',
  '[]',
  unixepoch('now') * 1000,
  unixepoch('now') * 1000
)
ON CONFLICT(id) DO NOTHING;
