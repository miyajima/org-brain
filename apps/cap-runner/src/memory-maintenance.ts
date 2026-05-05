const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_SUMMARY_LIMIT = 6;
const DIGEST_MEMBER_ID_LIMIT = 12;
const DIGEST_CONTENT_LIMIT = 3_500;
const DIGEST_GROUP_MIN = 4;
const DIGEST_OLDER_THAN_DAYS = 7;
const CANONICAL_OLDER_THAN_DAYS = 3;
const CANONICAL_SUMMARY_LIMIT = 8;
const CANONICAL_GROUP_MIN = 2;
const CANONICAL_CATEGORY_TAGS = ["project-fact", "policy", "diagnosis", "command-result", "workaround", "success", "failure", "preference"] as const;
const DUPLICATE_OLDER_THAN_DAYS = 14;
const MAINTENANCE_SOURCE_ALLOWLIST = ["codex", "claude", "cursor", "openclaw", "opencode"] as const;

const TAGS_TO_SKIP_IN_TOPLIST = new Set([
  "hook",
  "promoted",
  "compacted",
  "agent-turn-complete",
  "memory-digest",
  "maintenance"
]);

type RawMemoryRow = {
  id: string;
  project_id: string | null;
  source: string;
  summary: string | null;
  content: string;
  tags_json: string | null;
  created_at: number;
  lifecycle_state?: string | null;
};

type PlannedDigest = {
  external_key: string;
  project_id: string | null;
  source: "org-brain";
  created_at: number;
  tags: string[];
  summary: string;
  content: string;
  member_ids: string[];
};

type PlannedCanonicalMemory = {
  external_key: string;
  project_id: string | null;
  source: "org-brain";
  created_at: number;
  tags: string[];
  summary: string;
  content: string;
  member_ids: string[];
};

type PlannedCompaction = {
  id: string;
  reason: "digest" | "duplicate";
  digest_external_key: string | null;
  next_tags: string[];
};

type MaintenancePlan = {
  canonicals: PlannedCanonicalMemory[];
  digests: PlannedDigest[];
  compactions: PlannedCompaction[];
  stats: {
    scanned_count: number;
    canonical_group_count: number;
    canonical_memory_count: number;
    digest_group_count: number;
    digested_memory_count: number;
    duplicate_compaction_count: number;
    total_compaction_count: number;
  };
};

type NormalizedMemoryRow = {
  id: string;
  project_id: string | null;
  source: string;
  tags: string[];
  created_at: number;
  summary: string;
  normalized_summary: string;
};

export type TenantMaintenanceResult = {
  tenant_id: string;
  applied: boolean;
  stats: MaintenancePlan["stats"];
};

function collapseWhitespace(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function stripJapanesePoliteness(value: string): string {
  const trimmed = collapseWhitespace(value);
  if (!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(trimmed)) return trimmed;

  const trailingPunctuation = /[。．.!！?？]+$/u;
  const withoutPunctuation = trimmed.replace(trailingPunctuation, "");
  const replacements: Array<[RegExp, string]> = [
    [/(.+?)してください$/u, "$1"],
    [/(.+?)して下さい$/u, "$1"],
    [/(.+?)しました$/u, "$1"],
    [/(.+?)します$/u, "$1"],
    [/(.+?)でした$/u, "$1"],
    [/(.+?)ました$/u, "$1"],
    [/(.+?)です$/u, "$1"],
    [/(.+?)ます$/u, "$1"]
  ];

  let normalized = withoutPunctuation;
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, replacement);
      break;
    }
  }

  return collapseWhitespace(normalized.replace(trailingPunctuation, ""));
}

function normalizeSummary(value: string): string {
  return stripJapanesePoliteness(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: unknown, limit: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function stripMarkdownNoise(value: string): string {
  return String(value ?? "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\/Users\/\S+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
}

function isWeakGuidanceLine(value: string): boolean {
  const normalized = collapseWhitespace(stripMarkdownNoise(value)).normalize("NFKC").replace(/[。．.!！?？]+$/u, "");
  if (!normalized || normalized.length < 12) return true;
  if (/::git-(?:stage|commit|push|create-branch|create-pr)\{/u.test(value)) return true;
  if (/^(?:\[path\]\s*)+$/u.test(normalized)) return true;
  return /^(実行結果です|修正しました|実装しました|変更しました|原因は特定して修正|原因は確定して対処済み|コミットまでは完了|はい、まだ|P\d|残り\s*\d+\s*点)/u.test(normalized);
}

function hasConcreteGuidanceSignal(value: string): boolean {
  const normalized = collapseWhitespace(value);
  return (
    /`[^`\n]+`/.test(value) ||
    /\b(?:app|apps|scripts|docs|src|spec|test|tests|config|web|engine|backend|frontend)\//i.test(normalized) ||
    /\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|rb|erb|astro|md|yml|yaml|json|sql|rs)\b/.test(normalized) ||
    /\b(?:pnpm|npm|wrangler|git|bundle|rails|cargo|pytest|vitest|rspec|playwright|ffmpeg)\b/i.test(normalized) ||
    /\b\d+\s*(?:examples|failures|tests|件|rows|PDFs|ms|tokens)\b/i.test(normalized)
  );
}

function pickReusableGuidance(row: RawMemoryRow): string {
  const contentLines = String(row.content ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line && !line.startsWith("#") && !/^(Source|Event|Project|RecordedAt|Tenant|Category|TopTags):/i.test(line));
  const candidates = [...contentLines, row.summary ?? ""]
    .map((line) => stripMarkdownNoise(line))
    .filter((line) => !isWeakGuidanceLine(line));
  return (
    candidates.find(hasConcreteGuidanceSignal) ||
    candidates.find((line) => line.length >= 24) ||
    stripMarkdownNoise(row.summary || row.content || row.id)
  );
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseTagsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function addTags(existing: string[], extra: string[]): string[] {
  return [...new Set([...existing, ...extra].filter(Boolean))].slice(0, 16);
}

function topTags(rows: NormalizedMemoryRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of row.tags) {
      if (TAGS_TO_SKIP_IN_TOPLIST.has(tag)) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([tag]) => tag);
}

function canonicalCategory(tags: string[]): string {
  for (const tag of CANONICAL_CATEGORY_TAGS) {
    if (tags.includes(tag)) return tag;
  }
  return "general";
}

function canonicalSourcePriority(row: NormalizedMemoryRow): number {
  if (row.tags.includes("project-fact")) return 0;
  if (row.tags.includes("promoted")) return 0;
  if (row.tags.includes("curated-memory")) return 1;
  if (row.tags.includes("memory-digest")) return 2;
  return 3;
}

function buildDigestExternalKey(tenantId: string, projectId: string | null, source: string, day: string): string {
  return `org-brain:memory-digest:${tenantId}:${projectId || "(none)"}:${source}:${day}`;
}

function buildCanonicalExternalKey(tenantId: string, projectId: string | null, category: string): string {
  return `org-brain:canonical-memory:${tenantId}:${projectId || "(none)"}:${category}`;
}

function buildDigestSummary(row: NormalizedMemoryRow, day: string, rowCount: number, uniqueCount: number): string {
  return clip(`${row.project_id || "(none)"} | memory-digest | ${row.source} | ${day} | ${rowCount} items -> ${uniqueCount} summaries`, 240);
}

function buildCanonicalSummary(projectId: string | null, category: string, uniqueCount: number): string {
  return clip(`${projectId || "(none)"} | ${category} | ${uniqueCount} reusable rules`, 240);
}

function buildDigestContent(
  tenantId: string,
  row: NormalizedMemoryRow,
  day: string,
  rows: NormalizedMemoryRow[],
  summaries: string[]
): string {
  const tags = topTags(rows);
  const lines = [
    "# Memory Digest",
    "",
    `- Tenant: ${tenantId}`,
    `- Project: ${row.project_id || "(none)"}`,
    `- Source: ${row.source}`,
    `- Day: ${day}`,
    `- CompactedCount: ${rows.length}`,
    `- UniqueSummaryCount: ${summaries.length}`
  ];

  if (tags.length > 0) lines.push(`- TopTags: ${tags.join(", ")}`);

  lines.push("", "## Representative Summaries", "");
  for (const summary of summaries) {
    lines.push(`- ${clip(stripMarkdownNoise(stripJapanesePoliteness(summary)), 180)}`);
  }

  lines.push("", "## Covered Memory IDs", "");
  for (const member of rows.slice(0, DIGEST_MEMBER_ID_LIMIT)) {
    lines.push(`- ${member.id}`);
  }

  return clip(lines.join("\n"), DIGEST_CONTENT_LIMIT);
}

function buildCanonicalContent(
  tenantId: string,
  projectId: string | null,
  category: string,
  rows: NormalizedMemoryRow[],
  summaries: string[]
): string {
  const tags = topTags(rows);
  const reusable = summaries
    .map((summary) => clip(stripMarkdownNoise(stripJapanesePoliteness(summary)), 180))
    .filter((summary) => !isWeakGuidanceLine(summary) && hasConcreteGuidanceSignal(summary))
    .slice(0, CANONICAL_SUMMARY_LIMIT);
  const caveats = summaries
    .map((summary) => clip(stripMarkdownNoise(stripJapanesePoliteness(summary)), 180))
    .filter((summary) => /(?:失敗|failed|failure|未確認|確認できません|cannot confirm)/i.test(summary))
    .slice(0, 4);
  const lines = [
    "# Canonical Memory Map",
    "",
    `- Tenant: ${tenantId}`,
    `- Project: ${projectId || "(none)"}`,
    `- Category: ${category}`,
    `- ConsolidatedCount: ${rows.length}`,
    `- ReusableGuidanceCount: ${reusable.length}`
  ];

  if (tags.length > 0) lines.push(`- TopTags: ${tags.join(", ")}`);

  lines.push("", "## Reusable Guidance", "");
  for (const summary of reusable) {
    lines.push(`- ${summary}`);
  }

  lines.push("", "## Evidence Memory IDs", "");
  for (const member of rows.slice(0, DIGEST_MEMBER_ID_LIMIT)) {
    lines.push(`- ${member.id}`);
  }

  lines.push("", "## Caveats", "");
  if (caveats.length === 0) {
    lines.push("- Re-check guidance when project structure, dependencies, or deployment environment changes.");
  } else {
    for (const caveat of caveats) lines.push(`- ${caveat}`);
  }

  return clip(lines.join("\n"), DIGEST_CONTENT_LIMIT);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCanonicalSearchSummary(projectId: string | null, category: string, summaries: string[]): string {
  const lead = summaries.find((summary) => summary && !/stable summaries|reusable rules/i.test(summary)) || summaries[0] || "";
  const projectLabel = projectId || "(none)";
  const cleaned = stripMarkdownNoise(stripJapanesePoliteness(lead))
    .replace(new RegExp(`^${escapeRegExp(projectLabel)}\\s*\\|\\s*`, "u"), "")
    .replace(/^(?:promoted-memory|agent-turn-complete|project-fact)\s*\|\s*/u, "");
  return clip(`${projectLabel} | ${category} | ${cleaned}`, 240);
}

function canDigestRow(row: NormalizedMemoryRow, cutoffTimestamp: number): boolean {
  return (
    row.created_at <= cutoffTimestamp &&
    row.source !== "org-brain" &&
    row.tags.includes("hook") &&
    !row.tags.includes("promoted") &&
    !row.tags.includes("compacted")
  );
}

function hasAnyText(text: string, keywords: string[]): boolean {
  const lowered = text.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

function isLowSignalRow(row: RawMemoryRow, tags: string[], rawSummary: string): boolean {
  const text = collapseWhitespace(`${rawSummary}\n${row.content}`);
  const title = collapseWhitespace(rawSummary.replace(/^.*\|\s*(?:promoted-memory|agent-turn-complete|project-fact)\s*\|\s*/u, ""));
  if (tags.includes("canonical-memory") || tags.includes("memory-digest") || tags.includes("compacted")) return true;
  if (tags.includes("message") || tags.includes("preprocessed") || /heartbeat/i.test(text)) return true;
  if (tags.includes("project-fact") || /^#\s*Project Fact/im.test(row.content)) return false;
  if (/^route=inline\/current[- ]agent$/i.test(title) || text.startsWith("route=inline/current-agent")) return true;
  if (/^(起動|修正|削除|空け|実装完了|修正完了|実行結果です|変更しました|1)$/u.test(title.replace(/[。．.!！?？]+$/u, ""))) return true;
  if (/^理由[:：]?\s*\d+$/u.test(title)) return true;
  const hasCauseAndFix =
    hasAnyText(text, ["原因", "理由", "root cause", "because", "why"]) &&
    hasAnyText(text, ["対処", "再発防止", "fix", "fixed", "workaround", "resolve", "resolved", "solution", "対応"]);
  const hasCommandAndResult =
    (/`[^`\n]+`/.test(row.content) || hasAnyText(text, ["pnpm", "npm", "wrangler", "git", "bundle", "rails", "cargo", "pytest", "vitest", "rspec"])) &&
    hasAnyText(text, ["成功", "failed", "failure", "succeeded", "success", "通った", "完了", "確認", "restored", "0 failures"]);
  if (hasCauseAndFix || hasCommandAndResult) return false;
  return tags.includes("promoted") || tags.includes("curated-memory") || tags.includes("hook");
}

function canCanonicalizeRow(row: NormalizedMemoryRow, cutoffTimestamp: number): boolean {
  return (
    row.created_at <= cutoffTimestamp &&
    !row.tags.includes("compacted") &&
    !row.tags.includes("canonical-memory") &&
    row.normalized_summary.length > 0 &&
    (row.tags.includes("promoted") ||
      row.tags.includes("memory-digest") ||
      row.tags.includes("curated-memory") ||
      CANONICAL_CATEGORY_TAGS.some((tag) => row.tags.includes(tag)))
  );
}

function canDedupeRow(row: NormalizedMemoryRow, cutoffTimestamp: number): boolean {
  return (
    row.created_at <= cutoffTimestamp &&
    !row.tags.includes("compacted") &&
    !row.tags.includes("memory-digest") &&
    row.normalized_summary.length > 0
  );
}

export function planMemoryMaintenance(rows: RawMemoryRow[], options: { tenantId?: string; now?: number } = {}): MaintenancePlan {
  const tenantId = options.tenantId ?? "default";
  const now = options.now ?? Date.now();
  const canonicalCutoff = now - CANONICAL_OLDER_THAN_DAYS * DAY_MS;
  const digestCutoff = now - DIGEST_OLDER_THAN_DAYS * DAY_MS;
  const duplicateCutoff = now - DUPLICATE_OLDER_THAN_DAYS * DAY_MS;
  const normalizedRows: NormalizedMemoryRow[] = rows.map((row) => {
    const tags = parseTagsJson(row.tags_json);
    const rawSummary = stripJapanesePoliteness(pickReusableGuidance(row));
    return {
      id: row.id,
      project_id: row.project_id ?? null,
      source: row.source,
      tags,
      created_at: Number(row.created_at),
      summary: clip(rawSummary, 240),
      normalized_summary: normalizeSummary(rawSummary)
    };
  }).filter((row, index) => !isLowSignalRow(rows[index], row.tags, row.summary));

  const canonicals: PlannedCanonicalMemory[] = [];
  const digests: PlannedDigest[] = [];
  const compactions: PlannedCompaction[] = [];
  const compactedIds = new Set<string>();
  const canonicalGroups = new Map<string, NormalizedMemoryRow[]>();
  const digestGroups = new Map<string, NormalizedMemoryRow[]>();

  for (const row of normalizedRows) {
    if (canCanonicalizeRow(row, canonicalCutoff)) {
      const category = canonicalCategory(row.tags);
      const key = `${row.project_id || "(none)"}::${category}`;
      const group = canonicalGroups.get(key) ?? [];
      group.push(row);
      canonicalGroups.set(key, group);
    }

    if (!canDigestRow(row, digestCutoff)) continue;
    const key = `${row.project_id || "(none)"}::${row.source}::${utcDay(row.created_at)}`;
    const group = digestGroups.get(key) ?? [];
    group.push(row);
    digestGroups.set(key, group);
  }

  for (const [groupKey, rowsForGroup] of canonicalGroups.entries()) {
    if (rowsForGroup.length < CANONICAL_GROUP_MIN) continue;
    const ordered = [...rowsForGroup].sort(
      (left, right) =>
        canonicalSourcePriority(left) - canonicalSourcePriority(right) ||
        right.created_at - left.created_at
    );
    const dedupedSummaries: string[] = [];
    const seenSummaries = new Set<string>();
    for (const row of ordered) {
      if (!row.normalized_summary || seenSummaries.has(row.normalized_summary)) continue;
      if (isWeakGuidanceLine(row.summary)) continue;
      seenSummaries.add(row.normalized_summary);
      dedupedSummaries.push(row.summary);
      if (dedupedSummaries.length >= CANONICAL_SUMMARY_LIMIT) break;
    }
    if (dedupedSummaries.length < CANONICAL_GROUP_MIN) continue;

    const [projectKey, category] = groupKey.split("::", 2);
    const projectId = projectKey === "(none)" ? null : projectKey;
    const anchor = ordered[0];
    canonicals.push({
      external_key: buildCanonicalExternalKey(tenantId, projectId, category),
      project_id: projectId,
      source: "org-brain",
      created_at: anchor.created_at,
      tags: addTags(["org-brain", "maintenance", "canonical-memory", "memory-map", "quality-v2", category], projectId ? [projectId] : []),
      summary: buildCanonicalSearchSummary(projectId, category, dedupedSummaries),
      content: buildCanonicalContent(tenantId, projectId, category, ordered, dedupedSummaries),
      member_ids: ordered.map((row) => row.id)
    });
  }

  for (const rowsForGroup of digestGroups.values()) {
    if (rowsForGroup.length < DIGEST_GROUP_MIN) continue;
    const ordered = [...rowsForGroup].sort((left, right) => right.created_at - left.created_at);
    const dedupedSummaries: string[] = [];
    const seenSummaries = new Set<string>();
    for (const row of ordered) {
      if (!row.normalized_summary || seenSummaries.has(row.normalized_summary)) continue;
      seenSummaries.add(row.normalized_summary);
      dedupedSummaries.push(row.summary);
      if (dedupedSummaries.length >= DIGEST_SUMMARY_LIMIT) break;
    }
    if (dedupedSummaries.length < 2) continue;

    const anchor = ordered[0];
    const day = utcDay(anchor.created_at);
    const external_key = buildDigestExternalKey(tenantId, anchor.project_id, anchor.source, day);
    digests.push({
      external_key,
      project_id: anchor.project_id,
      source: "org-brain",
      created_at: anchor.created_at,
      tags: addTags(["org-brain", "maintenance", "memory-digest", "quality-v2", anchor.source], anchor.project_id ? [anchor.project_id] : []),
      summary: buildDigestSummary(anchor, day, ordered.length, dedupedSummaries.length),
      content: buildDigestContent(tenantId, anchor, day, ordered, dedupedSummaries),
      member_ids: ordered.map((item) => item.id)
    });

    for (const row of ordered) {
      if (compactedIds.has(row.id)) continue;
      compactedIds.add(row.id);
      compactions.push({
        id: row.id,
        reason: "digest",
        digest_external_key: external_key,
        next_tags: addTags(row.tags, ["compacted"])
      });
    }
  }

  const duplicateGroups = new Map<string, NormalizedMemoryRow[]>();
  for (const row of normalizedRows) {
    if (compactedIds.has(row.id) || !canDedupeRow(row, duplicateCutoff)) continue;
    const key = `${row.project_id || "(none)"}::${row.source}::${row.normalized_summary}`;
    const group = duplicateGroups.get(key) ?? [];
    group.push(row);
    duplicateGroups.set(key, group);
  }

  for (const rowsForGroup of duplicateGroups.values()) {
    if (rowsForGroup.length < 2) continue;
    const ordered = [...rowsForGroup].sort((left, right) => right.created_at - left.created_at);
    const [, ...duplicates] = ordered;
    for (const row of duplicates) {
      if (compactedIds.has(row.id)) continue;
      compactedIds.add(row.id);
      compactions.push({
        id: row.id,
        reason: "duplicate",
        digest_external_key: null,
        next_tags: addTags(row.tags, ["compacted"])
      });
    }
  }

  return {
    canonicals,
    digests,
    compactions,
    stats: {
      scanned_count: normalizedRows.length,
      canonical_group_count: canonicals.length,
      canonical_memory_count: canonicals.length,
      digest_group_count: digests.length,
      digested_memory_count: compactions.filter((item) => item.reason === "digest").length,
      duplicate_compaction_count: compactions.filter((item) => item.reason === "duplicate").length,
      total_compaction_count: compactions.length
    }
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function loadMaintenanceTenantIds(db: D1Database): Promise<string[]> {
  const result = await db.prepare(
    `SELECT DISTINCT tenant_id
       FROM memories
      WHERE source IN (${MAINTENANCE_SOURCE_ALLOWLIST.map(() => "?").join(", ")})
      ORDER BY tenant_id ASC
      LIMIT 100`
  )
    .bind(...MAINTENANCE_SOURCE_ALLOWLIST)
    .all<{ tenant_id: string }>();
  return result.results.map((row) => row.tenant_id).filter(Boolean);
}

async function loadMaintenanceRows(db: D1Database, tenantId: string): Promise<RawMemoryRow[]> {
  const result = await db.prepare(
    `SELECT id, project_id, source, summary, content, tags_json, created_at, lifecycle_state
       FROM memories
      WHERE tenant_id = ?
        AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
        AND (tags_json IS NULL OR tags_json NOT LIKE '%"compacted"%')
        AND source IN (${MAINTENANCE_SOURCE_ALLOWLIST.map(() => "?").join(", ")})
      ORDER BY created_at DESC
      LIMIT 5000`
  )
    .bind(tenantId, ...MAINTENANCE_SOURCE_ALLOWLIST)
    .all<RawMemoryRow>();
  return result.results;
}

async function loadExistingDigestIdsByExternalKeys(
  db: D1Database,
  tenantId: string,
  externalKeys: string[]
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (externalKeys.length === 0) return results;
  for (const chunk of chunkArray(externalKeys, 100)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const response = await db.prepare(
      `SELECT id, external_key
         FROM memories
        WHERE tenant_id = ?
          AND external_key IN (${placeholders})`
    )
      .bind(tenantId, ...chunk)
      .all<{ id: string; external_key: string | null }>();
    for (const row of response.results) {
      if (row.external_key) results.set(row.external_key, row.id);
    }
  }
  return results;
}

async function runBatchChunks(db: D1Database, statements: D1PreparedStatement[], chunkSize = 80): Promise<void> {
  for (const chunk of chunkArray(statements, chunkSize)) {
    if (chunk.length === 0) continue;
    await db.batch(chunk);
  }
}

function buildApplyStatements(
  db: D1Database,
  tenantId: string,
  plan: Pick<MaintenancePlan, "canonicals" | "digests" | "compactions">,
  existingDigestIds: Map<string, string>
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];

  for (const synthesized of [...plan.canonicals, ...plan.digests]) {
    const tagsJson = JSON.stringify(synthesized.tags);
    const existingId = existingDigestIds.get(synthesized.external_key);
    if (existingId) {
      statements.push(
        db.prepare(
          "UPDATE memories SET project_id = ?, content = ?, summary = ?, tags_json = ?, source = ?, created_at = ?, kind = ?, lifecycle_state = ?, consolidated_at = ?, revised_at = ? WHERE tenant_id = ? AND id = ?"
        ).bind(
          synthesized.project_id,
          synthesized.content,
          synthesized.summary,
          tagsJson,
          "org-brain",
          synthesized.created_at,
          "semantic",
          "active",
          synthesized.created_at,
          synthesized.created_at,
          tenantId,
          existingId
        ),
        db.prepare("DELETE FROM memories_fts WHERE memory_id = ? AND tenant_id = ?").bind(existingId, tenantId),
        db.prepare("INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)").bind(existingId, tenantId, synthesized.content)
      );
      continue;
    }

    const id = `mem_digest_${synthesized.external_key.replace(/[^A-Za-z0-9_]/g, "_")}`;
    statements.push(
      db.prepare(
        "INSERT INTO memories(id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at) VALUES(?,?,?,?,?,?,?,?,?)"
      ).bind(
        id,
        tenantId,
        synthesized.project_id,
        synthesized.content,
        synthesized.summary,
        tagsJson,
        "org-brain",
        synthesized.external_key,
        synthesized.created_at
      ),
      db.prepare(
        "UPDATE memories SET kind = ?, lifecycle_state = ?, consolidated_at = ?, revised_at = ? WHERE tenant_id = ? AND id = ?"
      ).bind("semantic", "active", synthesized.created_at, synthesized.created_at, tenantId, id),
      db.prepare("INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)").bind(id, tenantId, synthesized.content)
    );
  }

  for (const compaction of plan.compactions) {
    statements.push(
      db.prepare("UPDATE memories SET tags_json = ?, lifecycle_state = ?, suppressed_at = ?, revised_at = ? WHERE tenant_id = ? AND id = ?").bind(
        JSON.stringify(compaction.next_tags),
        "suppressed",
        Date.now(),
        Date.now(),
        tenantId,
        compaction.id
      ),
      db.prepare("DELETE FROM memories_fts WHERE memory_id = ? AND tenant_id = ?").bind(compaction.id, tenantId)
    );
  }

  return statements;
}

export async function runTenantMemoryMaintenance(
  db: D1Database,
  tenantId: string,
  now = Date.now()
): Promise<TenantMaintenanceResult> {
  const rows = await loadMaintenanceRows(db, tenantId);
  const plan = planMemoryMaintenance(rows, { tenantId, now });

  if (plan.canonicals.length === 0 && plan.digests.length === 0 && plan.compactions.length === 0) {
    return { tenant_id: tenantId, applied: false, stats: plan.stats };
  }

  const existingDigestIds = await loadExistingDigestIdsByExternalKeys(
    db,
    tenantId,
    [...plan.canonicals, ...plan.digests].map((item) => item.external_key)
  );

  for (const synthesized of [...plan.canonicals, ...plan.digests]) {
    await runBatchChunks(
      db,
      buildApplyStatements(db, tenantId, { canonicals: [synthesized as PlannedCanonicalMemory], digests: [], compactions: [] }, existingDigestIds),
      10
    );
  }

  await runBatchChunks(
    db,
    buildApplyStatements(db, tenantId, { canonicals: [], digests: [], compactions: plan.compactions }, existingDigestIds),
    80
  );

  return { tenant_id: tenantId, applied: true, stats: plan.stats };
}

export async function runScheduledMemoryMaintenance(db: D1Database, now = Date.now()): Promise<TenantMaintenanceResult[]> {
  const tenantIds = await loadMaintenanceTenantIds(db);
  const results: TenantMaintenanceResult[] = [];
  for (const tenantId of tenantIds) {
    results.push(await runTenantMemoryMaintenance(db, tenantId, now));
  }
  return results;
}
