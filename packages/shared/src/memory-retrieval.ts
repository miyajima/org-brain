import { buildKnowledgeFtsQuery } from "./knowledge-docs";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_DAYS = 14;
const PROFILE_SCAN_LIMIT = 256;
const SEARCH_FETCH_LIMIT_FLOOR = 12;
const HISTORY_FETCH_LIMIT_FLOOR = 24;
const DOC_FETCH_LIMIT = 4;
const TAG_PRIORITY_ORDER = ["policy", "diagnosis", "command-result", "workaround"] as const;
const PRIMARY_SEARCHABLE_TAGS = ["canonical-memory", "promoted", "memory-digest"] as const;

export type MemorySearchMode = "memories" | "hybrid";
export type MemorySearchKind = "memory" | "doc";
export type MemorySearchStrategy = "bm25_v1" | "bm25_rewrite_v1" | "hybrid_memory_docs_v1" | "fallback_recent_v1";

export type StoredMemory = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: string;
  external_key: string | null;
  created_at: number;
};

type MemoryCandidateRow = StoredMemory & {
  raw_rank: number | null;
};

type KnowledgeDocCandidateRow = {
  id: string;
  tenant_id: string;
  scope: string;
  kind: string;
  title: string;
  slug: string;
  summary: string | null;
  body_text: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  raw_rank: number | null;
};

export type MemorySearchResult = {
  kind: MemorySearchKind;
  id: string;
  summary: string | null;
  content_preview: string;
  score: number | null;
  source: string;
  created_at: number;
};

export type MemorySearchMeta = {
  search_strategy: MemorySearchStrategy;
  matched_count: number;
  returned_count: number;
  fallback_used: boolean;
  variant_count: number;
  lexical_result_count: number;
  doc_result_count: number;
  history_result_count: number;
  top_result_ids: string[];
  top_result_ranks: Array<number | null>;
};

export type MemorySearchResponse = {
  tenant_id: string;
  project_id: string | null;
  q: string;
  rewrite_query: boolean;
  search_mode: MemorySearchMode;
  include_history: boolean;
  results: MemorySearchResult[];
  meta: MemorySearchMeta;
};

export type MemoryProfileItem = {
  id: string;
  project_id: string | null;
  summary: string;
  content_preview: string;
  source: string;
  created_at: number;
  tags: string[];
};

export type MemoryProfileResponse = {
  tenant_id: string;
  project_id: string | null;
  durable: MemoryProfileItem[];
  recent: MemoryProfileItem[];
  search_results: MemorySearchResult[];
  meta: {
    durable_count: number;
    recent_count: number;
    search: MemorySearchMeta | null;
  };
};

export type MemorySearchOptions = {
  tenantId: string;
  projectId?: string | null;
  q: string;
  limit?: number;
  rewriteQuery?: boolean;
  searchMode?: MemorySearchMode;
  includeHistory?: boolean;
};

export type MemoryProfileOptions = {
  tenantId: string;
  projectId?: string | null;
  q?: string;
  limitDurable?: number;
  limitRecent?: number;
  rewriteQuery?: boolean;
  searchMode?: MemorySearchMode;
  now?: number;
};

type QueryVariant = {
  label: string;
  ftsQuery: string;
};

type SearchCandidate = {
  kind: MemorySearchKind;
  id: string;
  summary: string | null;
  content_preview: string;
  source: string;
  created_at: number;
  raw_rank: number | null;
  dedupe_key: string;
};

function clipText(value: string | null | undefined, limit = 240): string {
  const normalized = collapseWhitespace(value ?? "");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function parseTagsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function normalizeDedupeKey(value: string | null | undefined): string {
  return collapseWhitespace(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPreview(summary: string | null, content: string | null | undefined): string {
  return clipText(summary || content || "", 240);
}

function tagPriority(tags: string[]): number {
  for (let index = 0; index < TAG_PRIORITY_ORDER.length; index += 1) {
    if (tags.includes(TAG_PRIORITY_ORDER[index])) return index;
  }
  return TAG_PRIORITY_ORDER.length;
}

function hasAnyTag(tags: string[], candidates: readonly string[]): boolean {
  return candidates.some((candidate) => tags.includes(candidate));
}

function memoryTierPriority(tags: string[]): number {
  if (tags.includes("canonical-memory")) return 0;
  if (tags.includes("curated-memory")) return 1;
  if (tags.includes("promoted")) return 2;
  if (tags.includes("memory-digest")) return 3;
  return 4;
}

function projectPriority(targetProjectId: string | null | undefined, candidateProjectId: string | null | undefined): number {
  return targetProjectId && candidateProjectId === targetProjectId ? 0 : 1;
}

function compareNullableRanks(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function compareMemoryCandidates(projectId: string | null | undefined, left: MemoryCandidateRow, right: MemoryCandidateRow): number {
  const leftTags = parseTagsJson(left.tags_json);
  const rightTags = parseTagsJson(right.tags_json);
  return (
    projectPriority(projectId, left.project_id) - projectPriority(projectId, right.project_id) ||
    memoryTierPriority(leftTags) - memoryTierPriority(rightTags) ||
    compareNullableRanks(left.raw_rank, right.raw_rank) ||
    tagPriority(leftTags) - tagPriority(rightTags) ||
    right.created_at - left.created_at
  );
}

function compareDocCandidates(left: KnowledgeDocCandidateRow, right: KnowledgeDocCandidateRow): number {
  return compareNullableRanks(left.raw_rank, right.raw_rank) || right.updated_at - left.updated_at;
}

function toPublicScore(rawRank: number | null): number | null {
  if (rawRank === null || !Number.isFinite(rawRank)) return null;
  return Number((1 / (1 + Math.abs(rawRank))).toFixed(6));
}

export function buildMemoryFtsQuery(raw: string): string | null {
  const tokens = collapseWhitespace(raw)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 6)
    .map((token) => `"${token.replace(/"/g, '""')}"*`);

  if (tokens.length === 0) return null;
  return tokens.join(" OR ");
}

function tokenizeForRewrite(raw: string): string[] {
  const normalized = collapseWhitespace(raw);
  if (!normalized) return [];
  const pieces = normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s/_.:-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return [...new Set(pieces)].slice(0, 8);
}

function singularizeToken(token: string): string {
  if (token.length <= 3) return token;
  return token.endsWith("s") ? token.slice(0, -1) : token;
}

export function buildMemoryQueryVariants(raw: string, rewriteQuery = false): QueryVariant[] {
  const normalized = collapseWhitespace(raw);
  if (!normalized) return [];

  const variants: QueryVariant[] = [];
  const seen = new Set<string>();
  const pushVariant = (label: string, ftsQuery: string | null) => {
    if (!ftsQuery || seen.has(ftsQuery)) return;
    seen.add(ftsQuery);
    variants.push({ label, ftsQuery });
  };

  if (rewriteQuery) {
    pushVariant("phrase", `"${normalized.replace(/"/g, '""')}"`);
  }

  pushVariant("token_or", buildMemoryFtsQuery(normalized));

  if (rewriteQuery) {
    const splitTokens = tokenizeForRewrite(normalized);
    if (splitTokens.length > 0) {
      pushVariant(
        "split_or",
        splitTokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ")
      );
      const singularTokens = [...new Set(splitTokens.map(singularizeToken).filter((token) => token.length >= 2))];
      pushVariant(
        "singular_or",
        singularTokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ")
      );
    }
  }

  return variants.slice(0, rewriteQuery ? 4 : 1);
}

function buildProjectOrderSql(alias: string, projectId: string | null | undefined): string {
  if (!projectId) return "";
  return `CASE WHEN ${alias}.project_id = ? THEN 0 ELSE 1 END, `;
}

function bindProjectArgs(projectId: string | null | undefined): unknown[] {
  return projectId ? [projectId] : [];
}

function searchableFilterSql(alias: string): string {
  return `(${alias}.tags_json IS NULL OR ${alias}.tags_json NOT LIKE '%"compacted"%')`;
}

function primaryLexicalFilterSql(alias: string): string {
  const tagClauses = PRIMARY_SEARCHABLE_TAGS.map((tag) => `${alias}.tags_json LIKE '%"${tag}"%'`).join(" OR ");
  return `(${alias}.tags_json LIKE '%"curated-memory"%' OR ${tagClauses})`;
}

async function searchMemoryVariant(
  db: D1Database,
  tenantId: string,
  projectId: string | null | undefined,
  ftsQuery: string,
  limit: number
): Promise<MemoryCandidateRow[]> {
  const result = await db.prepare(
    `SELECT m.id, m.tenant_id, m.project_id, m.content, m.summary, m.tags_json, m.source, m.external_key, m.created_at,
            bm25(memories_fts) AS raw_rank
     FROM memories_fts
     JOIN memories m
       ON m.id = memories_fts.memory_id
     AND m.tenant_id = memories_fts.tenant_id
     WHERE memories_fts.tenant_id = ?
       AND memories_fts.content MATCH ?
       AND ${searchableFilterSql("m")}
       AND ${primaryLexicalFilterSql("m")}
     ORDER BY ${buildProjectOrderSql("m", projectId)}bm25(memories_fts) ASC, m.created_at DESC
     LIMIT ?`
  )
    .bind(tenantId, ftsQuery, ...bindProjectArgs(projectId), limit)
    .all<MemoryCandidateRow>();

  return result.results.map((row) => ({
    ...row,
    raw_rank: typeof row.raw_rank === "number" && Number.isFinite(row.raw_rank) ? row.raw_rank : null
  }));
}

async function loadRecentHistoryRows(
  db: D1Database,
  tenantId: string,
  projectId: string | null | undefined,
  limit: number
): Promise<StoredMemory[]> {
  const result = await db.prepare(
    `SELECT id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at
     FROM memories
     WHERE tenant_id = ?
       AND ${searchableFilterSql("memories")}
     ORDER BY ${buildProjectOrderSql("memories", projectId)}created_at DESC
     LIMIT ?`
  )
    .bind(tenantId, ...bindProjectArgs(projectId), limit)
    .all<StoredMemory>();

  return result.results;
}

async function searchDocVariant(db: D1Database, tenantId: string, ftsQuery: string, limit: number): Promise<KnowledgeDocCandidateRow[]> {
  const result = await db.prepare(
    `SELECT d.id, d.tenant_id, d.scope, d.kind, d.title, d.slug, d.summary, d.body_text, d.created_at, d.updated_at, d.deleted_at,
            bm25(knowledge_docs_fts) AS raw_rank
     FROM knowledge_docs_fts
     JOIN knowledge_docs d
       ON d.id = knowledge_docs_fts.doc_id
      AND d.tenant_id = knowledge_docs_fts.tenant_id
     WHERE knowledge_docs_fts.tenant_id = ?
       AND knowledge_docs_fts MATCH ?
       AND d.deleted_at IS NULL
     ORDER BY bm25(knowledge_docs_fts) ASC, d.updated_at DESC
     LIMIT ?`
  )
    .bind(tenantId, ftsQuery, limit)
    .all<KnowledgeDocCandidateRow>();

  return result.results.map((row) => ({
    ...row,
    raw_rank: typeof row.raw_rank === "number" && Number.isFinite(row.raw_rank) ? row.raw_rank : null
  }));
}

function chooseBetterCandidate(existing: MemoryCandidateRow, incoming: MemoryCandidateRow): MemoryCandidateRow {
  if (compareNullableRanks(incoming.raw_rank, existing.raw_rank) < 0) return incoming;
  if (compareNullableRanks(incoming.raw_rank, existing.raw_rank) > 0) return existing;
  return incoming.created_at > existing.created_at ? incoming : existing;
}

function toMemorySearchCandidate(row: MemoryCandidateRow): SearchCandidate {
  const summary = row.summary ? clipText(row.summary, 240) : clipText(row.content, 240);
  return {
    kind: "memory",
    id: row.id,
    summary: summary || null,
    content_preview: buildPreview(row.summary, row.content),
    source: row.source,
    created_at: row.created_at,
    raw_rank: row.raw_rank,
    dedupe_key: normalizeDedupeKey(summary || row.content || row.id)
  };
}

function toDocSearchCandidate(row: KnowledgeDocCandidateRow): SearchCandidate {
  const summary = clipText(row.summary || row.title, 240) || null;
  return {
    kind: "doc",
    id: row.id,
    summary,
    content_preview: buildPreview(row.summary || row.title, row.body_text),
    source: "knowledge-doc",
    created_at: row.updated_at || row.created_at,
    raw_rank: row.raw_rank,
    dedupe_key: normalizeDedupeKey(row.summary || row.title || row.slug || row.id)
  };
}

function toPublicResult(candidate: SearchCandidate): MemorySearchResult {
  return {
    kind: candidate.kind,
    id: candidate.id,
    summary: candidate.summary,
    content_preview: candidate.content_preview,
    score: candidate.kind === "memory" || candidate.kind === "doc" ? toPublicScore(candidate.raw_rank) : null,
    source: candidate.source,
    created_at: candidate.created_at
  };
}

function dedupeFinalCandidates(candidates: SearchCandidate[], limit: number): SearchCandidate[] {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const results: SearchCandidate[] = [];

  for (const candidate of candidates) {
    if (seenIds.has(candidate.id)) continue;
    if (candidate.dedupe_key && seenKeys.has(candidate.dedupe_key)) continue;
    seenIds.add(candidate.id);
    if (candidate.dedupe_key) seenKeys.add(candidate.dedupe_key);
    results.push(candidate);
    if (results.length >= limit) break;
  }

  return results;
}

export async function searchTenantMemories(
  db: D1Database,
  options: MemorySearchOptions
): Promise<MemorySearchResponse> {
  const tenantId = options.tenantId;
  const projectId = options.projectId?.trim() || null;
  const q = collapseWhitespace(options.q);
  const limit = Math.max(1, Math.min(20, options.limit ?? 5));
  const rewriteQuery = options.rewriteQuery ?? false;
  const searchMode = options.searchMode ?? "memories";
  const includeHistory = options.includeHistory ?? false;
  const variants = buildMemoryQueryVariants(q, rewriteQuery);
  const lexicalFetchLimit = Math.max(SEARCH_FETCH_LIMIT_FLOOR, limit * 2);
  const lexicalById = new Map<string, MemoryCandidateRow>();

  for (const variant of variants) {
    const rows = await searchMemoryVariant(db, tenantId, projectId, variant.ftsQuery, lexicalFetchLimit);
    for (const row of rows) {
      const existing = lexicalById.get(row.id);
      lexicalById.set(row.id, existing ? chooseBetterCandidate(existing, row) : row);
    }
  }

  const lexicalRows = [...lexicalById.values()].sort((left, right) => compareMemoryCandidates(projectId, left, right));
  const lexicalCandidates = lexicalRows.map(toMemorySearchCandidate);
  const lexicalResultCount = lexicalCandidates.length;

  const shouldSearchDocs = searchMode === "hybrid" && q.length > 0 && lexicalResultCount < 3;
  const docCandidates: SearchCandidate[] = [];
  if (shouldSearchDocs) {
    const docById = new Map<string, KnowledgeDocCandidateRow>();
    for (const variant of variants) {
      const ftsQuery = buildKnowledgeFtsQuery(variant.ftsQuery.replace(/\s+OR\s+/g, " ").replace(/\*/g, "").replace(/"/g, ""));
      if (!ftsQuery) continue;
      const rows = await searchDocVariant(db, tenantId, ftsQuery, DOC_FETCH_LIMIT);
      for (const row of rows) {
        const existing = docById.get(row.id);
        if (!existing || compareDocCandidates(row, existing) < 0) {
          docById.set(row.id, row);
        }
      }
    }
    docCandidates.push(...[...docById.values()].sort(compareDocCandidates).slice(0, 2).map(toDocSearchCandidate));
  }

  const baseCandidates = dedupeFinalCandidates([...lexicalCandidates, ...docCandidates], limit);
  const baseIds = new Set(baseCandidates.filter((candidate) => candidate.kind === "memory").map((candidate) => candidate.id));
  const baseKeys = new Set(baseCandidates.map((candidate) => candidate.dedupe_key).filter(Boolean));

  const historyCandidates: SearchCandidate[] = [];
  if (includeHistory && baseCandidates.length < limit) {
    const historyRows = await loadRecentHistoryRows(
      db,
      tenantId,
      projectId,
      Math.max(HISTORY_FETCH_LIMIT_FLOOR, limit * 4)
    );
    for (const row of historyRows) {
      if (baseIds.has(row.id)) continue;
      const candidate = toMemorySearchCandidate({ ...row, raw_rank: null });
      if (candidate.dedupe_key && baseKeys.has(candidate.dedupe_key)) continue;
      historyCandidates.push(candidate);
      baseIds.add(candidate.id);
      if (candidate.dedupe_key) baseKeys.add(candidate.dedupe_key);
      if (baseCandidates.length + historyCandidates.length >= limit) break;
    }
  }

  const finalCandidates = dedupeFinalCandidates([...baseCandidates, ...historyCandidates], limit);
  const docResultCount = finalCandidates.filter((candidate) => candidate.kind === "doc").length;
  const historyResultCount = historyCandidates.length;

  let searchStrategy: MemorySearchStrategy;
  if (shouldSearchDocs) {
    searchStrategy = "hybrid_memory_docs_v1";
  } else if (rewriteQuery) {
    searchStrategy = "bm25_rewrite_v1";
  } else if (lexicalResultCount > 0) {
    searchStrategy = "bm25_v1";
  } else {
    searchStrategy = "fallback_recent_v1";
  }

  const fallbackUsed =
    lexicalResultCount === 0 && docResultCount === 0 && (includeHistory ? historyResultCount > 0 : true);

  return {
    tenant_id: tenantId,
    project_id: projectId,
    q,
    rewrite_query: rewriteQuery,
    search_mode: searchMode,
    include_history: includeHistory,
    results: finalCandidates.map(toPublicResult),
    meta: {
      search_strategy: searchStrategy,
      matched_count: lexicalResultCount,
      returned_count: finalCandidates.length,
      fallback_used: fallbackUsed,
      variant_count: variants.length,
      lexical_result_count: lexicalResultCount,
      doc_result_count: docResultCount,
      history_result_count: historyResultCount,
      top_result_ids: finalCandidates.map((candidate) => candidate.id),
      top_result_ranks: finalCandidates.map((candidate) => candidate.raw_rank)
    }
  };
}

function toProfileItem(row: StoredMemory): MemoryProfileItem {
  const tags = parseTagsJson(row.tags_json);
  return {
    id: row.id,
    project_id: row.project_id,
    summary: clipText(row.summary || row.content, 240),
    content_preview: buildPreview(row.summary, row.content),
    source: row.source,
    created_at: row.created_at,
    tags
  };
}

export async function buildTenantMemoryProfile(
  db: D1Database,
  options: MemoryProfileOptions
): Promise<MemoryProfileResponse> {
  const tenantId = options.tenantId;
  const projectId = options.projectId?.trim() || null;
  const limitDurable = Math.max(1, Math.min(16, options.limitDurable ?? 8));
  const limitRecent = Math.max(1, Math.min(16, options.limitRecent ?? 8));
  const now = options.now ?? Date.now();

  const rows = await loadRecentHistoryRows(db, tenantId, projectId, PROFILE_SCAN_LIMIT);
  const durableCutoff = now - DAY_MS;
  const recentCutoff = now - RECENT_WINDOW_DAYS * DAY_MS;
  const durableSeen = new Set<string>();
  const durableIds = new Set<string>();
  const recentSeen = new Set<string>();

  const durable = rows
    .filter((row) => Boolean(collapseWhitespace(row.summary ?? "")) && row.created_at <= durableCutoff)
    .sort((left, right) => {
      const leftTags = parseTagsJson(left.tags_json);
      const rightTags = parseTagsJson(right.tags_json);
      return (
        projectPriority(projectId, left.project_id) - projectPriority(projectId, right.project_id) ||
        memoryTierPriority(leftTags) - memoryTierPriority(rightTags) ||
        tagPriority(leftTags) - tagPriority(rightTags) ||
        right.created_at - left.created_at
      );
    })
    .reduce<MemoryProfileItem[]>((items, row) => {
      if (items.length >= limitDurable) return items;
      const item = toProfileItem(row);
      const key = normalizeDedupeKey(item.summary);
      if (!key || durableSeen.has(key)) return items;
      durableSeen.add(key);
      durableIds.add(item.id);
      recentSeen.add(key);
      items.push(item);
      return items;
    }, []);

  const recent = rows
    .filter((row) => row.created_at >= recentCutoff && !durableIds.has(row.id))
    .sort(
      (left, right) =>
        projectPriority(projectId, left.project_id) - projectPriority(projectId, right.project_id) ||
        right.created_at - left.created_at
    )
    .reduce<MemoryProfileItem[]>((items, row) => {
      if (items.length >= limitRecent) return items;
      const item = toProfileItem(row);
      const key = normalizeDedupeKey(item.summary || item.content_preview);
      if (!key || recentSeen.has(key)) return items;
      recentSeen.add(key);
      items.push(item);
      return items;
    }, []);

  const search = options.q
    ? await searchTenantMemories(db, {
        tenantId,
        projectId,
        q: options.q,
        limit: 5,
        rewriteQuery: options.rewriteQuery ?? false,
        searchMode: options.searchMode ?? "memories",
        includeHistory: false
      })
    : null;

  return {
    tenant_id: tenantId,
    project_id: projectId,
    durable,
    recent,
    search_results: search?.results ?? [],
    meta: {
      durable_count: durable.length,
      recent_count: recent.length,
      search: search?.meta ?? null
    }
  };
}
