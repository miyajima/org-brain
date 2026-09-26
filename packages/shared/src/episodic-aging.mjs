const DAY_MS = 86_400_000;

/** Read-only candidate selection. Callers must supply use timestamps from verified evaluations only. */
export function planEpisodicAging(rows, { now = Date.now(), coldDays = 30, compactDays = 180 } = {}) {
  const candidates = [];
  for (const row of rows) {
    if (row.kind !== "episodic" || row.lifecycle_state !== "active" || row.deleted_at != null) continue;
    if (row.legal_hold || row.unresolved_integrity) continue;
    if (row.expires_at != null && Number(row.expires_at) <= now) continue;
    if (row.valid_until != null && Number(row.valid_until) <= now) continue;
    const createdAt = Number(row.created_at);
    if (!Number.isFinite(createdAt) || createdAt > now) continue;
    const verifiedUse = Number(row.last_verified_use_at);
    const lastActivity = Number.isFinite(verifiedUse) && verifiedUse > 0 ? Math.max(createdAt, verifiedUse) : createdAt;
    const inactiveDays = Math.floor((now - lastActivity) / DAY_MS);
    if (inactiveDays < coldDays) continue;
    candidates.push({ id: String(row.id), version: Number(row.current_version || 1),
      stage: inactiveDays >= compactDays ? "compaction_candidate" : "cold_candidate", inactive_days: inactiveDays,
      last_verified_use_at: Number.isFinite(verifiedUse) && verifiedUse > 0 ? verifiedUse : null });
  }
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return { mode: "shadow", cold_after_days: coldDays, compaction_after_days: compactDays,
    scanned: rows.length, candidates, mutations: 0 };
}
