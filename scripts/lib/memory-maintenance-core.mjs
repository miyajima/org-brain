import { classifyMemoryQuality } from "./memory-quality.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_SUMMARY_LIMIT = 6;
const DIGEST_MEMBER_ID_LIMIT = 12;
const DIGEST_CONTENT_LIMIT = 3_500;
const CANONICAL_OLDER_THAN_DAYS = 3;
const CANONICAL_SUMMARY_LIMIT = 8;
const CANONICAL_GROUP_MIN = 2;
const CANONICAL_CATEGORY_TAGS = ["project-fact", "policy", "diagnosis", "command-result", "workaround", "success", "failure", "preference"];
const TAGS_TO_SKIP_IN_TOPLIST = new Set([
  "hook",
  "promoted",
  "compacted",
  "agent-turn-complete",
  "memory-digest",
  "maintenance"
]);

function collapseWhitespace(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function stripJapanesePoliteness(value) {
  const trimmed = collapseWhitespace(value);
  if (!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(trimmed)) return trimmed;

  const trailingPunctuation = /[。．.!！?？]+$/u;
  const withoutPunctuation = trimmed.replace(trailingPunctuation, "");
  const replacements = [
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

function normalizeSummary(value) {
  return stripJapanesePoliteness(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value, limit) {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function stripMarkdownNoise(value) {
  return String(value ?? "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\/Users\/\S+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
}

function isWeakGuidanceLine(value) {
  const normalized = collapseWhitespace(stripMarkdownNoise(value)).normalize("NFKC").replace(/[。．.!！?？]+$/u, "");
  if (!normalized || normalized.length < 12) return true;
  return /^(実行結果です|修正しました|実装しました|変更しました|原因は特定して修正|原因は確定して対処済み|コミットまでは完了|はい、まだ|P\d|残り\s*\d+\s*点)/u.test(normalized);
}

function hasConcreteGuidanceSignal(value) {
  const normalized = collapseWhitespace(value);
  return (
    /`[^`\n]+`/.test(value) ||
    /\b(?:app|apps|scripts|docs|src|spec|test|tests|config|web|engine|backend|frontend)\//i.test(normalized) ||
    /\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|rb|erb|astro|md|yml|yaml|json|sql|rs)\b/.test(normalized) ||
    /\b(?:pnpm|npm|wrangler|git|bundle|rails|cargo|pytest|vitest|rspec|playwright|ffmpeg)\b/i.test(normalized) ||
    /\b\d+\s*(?:examples|failures|tests|件|rows|PDFs|ms|tokens)\b/i.test(normalized)
  );
}

function pickReusableGuidance(row) {
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

function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseTagsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function addTags(existing, extra) {
  return [...new Set([...existing, ...extra].filter(Boolean))].slice(0, 16);
}

function topTags(rows) {
  const counts = new Map();
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

function canonicalCategory(tags) {
  for (const tag of CANONICAL_CATEGORY_TAGS) {
    if (tags.includes(tag)) return tag;
  }
  return "general";
}

function canonicalSourcePriority(row) {
  if (row.tags.includes("project-fact")) return 0;
  if (row.tags.includes("promoted")) return 0;
  if (row.tags.includes("curated-memory")) return 1;
  if (row.tags.includes("memory-digest")) return 2;
  return 3;
}

function buildDigestExternalKey(tenantId, projectId, source, day) {
  return `org-brain:memory-digest:${tenantId}:${projectId || "(none)"}:${source}:${day}`;
}

function buildCanonicalExternalKey(tenantId, projectId, category) {
  return `org-brain:canonical-memory:${tenantId}:${projectId || "(none)"}:${category}`;
}

function buildDigestSummary(row, day, rowCount, uniqueCount) {
  return clip(
    `${row.project_id || "(none)"} | memory-digest | ${row.source} | ${day} | ${rowCount} items -> ${uniqueCount} summaries`,
    240
  );
}

function buildCanonicalSummary(projectId, category, uniqueCount) {
  return clip(`${projectId || "(none)"} | ${category} | ${uniqueCount} reusable rules`, 240);
}

function buildDigestContent(tenantId, row, day, rows, summaries) {
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

  if (tags.length > 0) {
    lines.push(`- TopTags: ${tags.join(", ")}`);
  }

  lines.push("");
  lines.push("## Representative Summaries");
  lines.push("");
  for (const summary of summaries) {
    lines.push(`- ${clip(stripMarkdownNoise(stripJapanesePoliteness(summary)), 180)}`);
  }

  lines.push("");
  lines.push("## Covered Memory IDs");
  lines.push("");
  for (const member of rows.slice(0, DIGEST_MEMBER_ID_LIMIT)) {
    lines.push(`- ${member.id}`);
  }

  return clip(lines.join("\n"), DIGEST_CONTENT_LIMIT);
}

function buildCanonicalContent(tenantId, projectId, category, rows, summaries) {
  const tags = topTags(rows);
  const lines = [
    "# Canonical Memory Map",
    "",
    `- Tenant: ${tenantId}`,
    `- Project: ${projectId || "(none)"}`,
    `- Category: ${category}`,
    `- ConsolidatedCount: ${rows.length}`,
    `- StableSummaryCount: ${summaries.length}`
  ];

  if (tags.length > 0) {
    lines.push(`- TopTags: ${tags.join(", ")}`);
  }

  lines.push("");
  lines.push("## Stable Guidance");
  lines.push("");
  for (const summary of summaries.slice(0, CANONICAL_SUMMARY_LIMIT)) {
    lines.push(`- ${clip(stripMarkdownNoise(stripJapanesePoliteness(summary)), 180)}`);
  }

  lines.push("");
  lines.push("## Supporting Memory IDs");
  lines.push("");
  for (const member of rows.slice(0, DIGEST_MEMBER_ID_LIMIT)) {
    lines.push(`- ${member.id}`);
  }

  return clip(lines.join("\n"), DIGEST_CONTENT_LIMIT);
}

function buildCanonicalSearchSummary(projectId, category, summaries) {
  const lead = summaries.find((summary) => summary && !/stable summaries|reusable rules/i.test(summary)) || summaries[0] || "";
  const cleaned = stripMarkdownNoise(stripJapanesePoliteness(lead))
    .replace(new RegExp(`^${(projectId || "\\(none\\)").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|\\s*`, "u"), "")
    .replace(/^(?:promoted-memory|agent-turn-complete|project-fact)\s*\|\s*/u, "");
  return clip(`${projectId || "(none)"} | ${category} | ${cleaned}`, 240);
}

function canDigestRow(row, cutoffTimestamp) {
  return (
    row.created_at <= cutoffTimestamp &&
    row.source !== "org-brain" &&
    row.tags.includes("hook") &&
    !row.tags.includes("promoted") &&
    !row.tags.includes("compacted")
  );
}

function canCanonicalizeRow(row, cutoffTimestamp) {
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

function canDedupeRow(row, cutoffTimestamp) {
  return (
    row.created_at <= cutoffTimestamp &&
    !row.tags.includes("compacted") &&
    !row.tags.includes("memory-digest") &&
    row.normalized_summary.length > 0
  );
}

export function planMemoryMaintenance(rows, options = {}) {
  const tenantId = options.tenantId ?? "default";
  const now = options.now ?? Date.now();
  const canonicalCutoff = now - CANONICAL_OLDER_THAN_DAYS * DAY_MS;
  const digestOlderThanDays = options.digestOlderThanDays ?? 7;
  const duplicateOlderThanDays = options.duplicateOlderThanDays ?? 14;
  const digestGroupMin = options.digestGroupMin ?? 4;

  const digestCutoff = now - digestOlderThanDays * DAY_MS;
  const duplicateCutoff = now - duplicateOlderThanDays * DAY_MS;
  const normalizedRows = rows.map((row) => {
    const tags = parseTagsJson(row.tags_json);
    const rawSummary = stripJapanesePoliteness(pickReusableGuidance(row));
    const quality = classifyMemoryQuality({ ...row, tags });
    return {
      id: row.id,
      project_id: row.project_id ?? null,
      source: row.source,
      tags,
      created_at: Number(row.created_at),
      summary: clip(rawSummary, 240),
      normalized_summary: normalizeSummary(rawSummary),
      quality
    };
  }).filter((row) => row.quality.action !== "delete");

  const canonicals = [];
  const digests = [];
  const compactions = [];
  const compactedIds = new Set();
  const canonicalGroups = new Map();
  const digestGroups = new Map();

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
    const dedupedSummaries = [];
    const seenSummaries = new Set();
    for (const row of ordered) {
      if (!row.normalized_summary || seenSummaries.has(row.normalized_summary)) continue;
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
    if (rowsForGroup.length < digestGroupMin) continue;
    const ordered = [...rowsForGroup].sort((left, right) => right.created_at - left.created_at);
    const dedupedSummaries = [];
    const seenSummaries = new Set();
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
      member_ids: ordered.map((row) => row.id)
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

  const duplicateGroups = new Map();
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
