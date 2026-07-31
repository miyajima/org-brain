import { buildKnowledgeFtsQuery } from "./knowledge-docs";
import { normalizeLifecycleState, normalizeMemoryKind, type MemoryKind, type MemoryLifecycleState } from "./memory-lifecycle-types";
import {
  fuseRetrievalSignals,
  type RetrievalIndexHit,
  type RetrievalScoreBreakdown
} from "./retrieval-index";
import type { MemorySourceReference } from "./memory-store";
import {
  analyzeRetrievalIntent,
  retrievalQueryTokens,
  retrievalSubjectQueryTokens,
  retrievalUnitLexicalSpecificity
} from "./retrieval-units";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_DAYS = 14;
const PROFILE_SCAN_LIMIT = 256;
const SEARCH_FETCH_LIMIT_FLOOR = 12;
const HISTORY_FETCH_LIMIT_FLOOR = 24;
const DOC_FETCH_LIMIT = 4;
const TAG_PRIORITY_ORDER = ["policy", "diagnosis", "command-result", "workaround"] as const;
const PRIMARY_SEARCHABLE_TAGS = ["canonical-memory", "promoted", "memory-digest"] as const;
const LOW_SIGNAL_TITLES = new Set(["起動", "修正", "削除", "空け", "実装完了", "修正完了", "実行結果です", "変更しました", "1"]);

export type MemorySearchMode = "memories" | "hybrid" | "hybrid_v2" | "hybrid_v3" | "hybrid_v4";
export type MemorySearchKind = "memory" | "doc";
export type MemorySearchStrategy =
  | "bm25_v1"
  | "bm25_rewrite_v1"
  | "hybrid_memory_docs_v1"
  | "hybrid_v2"
  | "hybrid_v3"
  | "hybrid_v4"
  | "fallback_recent_v1";

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
  kind?: string | null;
  lifecycle_state?: string | null;
  current_version?: number | null;
  last_accessed_at?: number | null;
  confidence_score?: number | null;
  utility_score?: number | null;
  expires_at?: number | null;
  valid_from?: number | null;
  valid_until?: number | null;
  permissions_json?: string | null;
  source_refs_json?: string | null;
  conflicts_json?: string | null;
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

type RetrievalUnitCandidateRow = {
  id: string;
  memory_id: string;
  tenant_id: string;
  project_id: string | null;
  unit_type: string;
  speaker: string | null;
  text: string;
  event_at: number | null;
  valid_from: number | null;
  valid_until: number | null;
  extractor: string;
  extractor_version: string;
  extraction_state: string;
  degraded_reason: string | null;
  created_at: number;
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
  memory_kind?: MemoryKind;
  lifecycle_state?: MemoryLifecycleState;
  current_version?: number;
  score_breakdown?: RetrievalScoreBreakdown;
  source_references?: MemorySourceReference[];
  conflicts?: string[];
  permission_decision?: {
    allowed: boolean;
    principal_id: string | null;
  };
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
  retrieval?: {
    semantic: { available: boolean; provider: string | null };
    graph: { available: boolean; provider: string };
    degraded: boolean;
    embedding_version?: string | null;
    reranker_version?: string | null;
    extractor_version?: string | null;
    lexical_candidate_count?: number;
    semantic_candidate_count?: number;
    parent_candidate_count?: number;
    projection_lag_ms?: number | null;
    degraded_reasons?: string[];
  };
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
  memory_kind: MemoryKind;
  lifecycle_state: MemoryLifecycleState;
  current_version: number;
  last_accessed_at: number | null;
  confidence_score: number | null;
  utility_score: number | null;
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
  principalId?: string | null;
  semanticHits?: RetrievalIndexHit[];
  semanticProvider?: string | null;
  rerankerScores?: Map<string, number>;
  rerankerProvider?: string | null;
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
  memory_kind?: MemoryKind;
  lifecycle_state?: MemoryLifecycleState;
  current_version?: number;
  confidence_score?: number | null;
  utility_score?: number | null;
  valid_from?: number | null;
  valid_until?: number | null;
  permissions_json?: string | null;
  graph_score?: number | null;
  semantic_score?: number | null;
  score_breakdown?: RetrievalScoreBreakdown;
  source_refs_json?: string | null;
  conflicts_json?: string | null;
  permission_decision?: {
    allowed: boolean;
    principal_id: string | null;
  };
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

function isLowSignalMemory(row: StoredMemory): boolean {
  const tags = parseTagsJson(row.tags_json);
  const text = collapseWhitespace(`${row.summary ?? ""} ${row.content ?? ""}`);
  const title = collapseWhitespace((row.summary || row.content || "").replace(/^.*\|\s*(?:promoted-memory|agent-turn-complete|project-fact)\s*\|\s*/u, ""));
  if (tags.includes("compacted")) return true;
  if (tags.includes("message") || tags.includes("preprocessed") || /heartbeat/i.test(text)) return true;
  if (tags.includes("project-fact") || /^#\s*Project Fact/im.test(row.content)) return false;
  if (/^route=inline\/current[- ]agent$/i.test(title) || text.startsWith("route=inline/current-agent")) return true;
  if (LOW_SIGNAL_TITLES.has(title.replace(/[。．.!！?？]+$/u, ""))) return true;
  if (/^理由[:：]?\s*\d+$/u.test(title)) return true;
  return false;
}

function memoryTierPriority(tags: string[]): number {
  if (tags.includes("canonical-memory")) return 0;
  if (tags.includes("curated-memory")) return 1;
  if (tags.includes("promoted")) return 2;
  if (tags.includes("memory-digest")) return 3;
  return 4;
}

function memoryKindPriority(kind: MemoryKind): number {
  if (kind === "semantic") return 0;
  if (kind === "org_knowledge") return 1;
  return 2;
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

function compareNullableScores(left: number | null | undefined, right: number | null | undefined): number {
  const leftValue = typeof left === "number" && Number.isFinite(left) ? left : null;
  const rightValue = typeof right === "number" && Number.isFinite(right) ? right : null;
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  return rightValue - leftValue;
}

function compareMemoryQuality(left: StoredMemory, right: StoredMemory): number {
  return (
    compareNullableScores(left.utility_score, right.utility_score) ||
    compareNullableScores(left.confidence_score, right.confidence_score) ||
    compareNullableScores(left.last_accessed_at, right.last_accessed_at)
  );
}

function compareMemoryCandidates(projectId: string | null | undefined, left: MemoryCandidateRow, right: MemoryCandidateRow): number {
  const leftTags = parseTagsJson(left.tags_json);
  const rightTags = parseTagsJson(right.tags_json);
  const leftKind = normalizeMemoryKind(left.kind);
  const rightKind = normalizeMemoryKind(right.kind);
  return (
    projectPriority(projectId, left.project_id) - projectPriority(projectId, right.project_id) ||
    memoryKindPriority(leftKind) - memoryKindPriority(rightKind) ||
    memoryTierPriority(leftTags) - memoryTierPriority(rightTags) ||
    compareNullableRanks(left.raw_rank, right.raw_rank) ||
    compareMemoryQuality(left, right) ||
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
  return buildMemoryFtsQueryFromTokens(retrievalQueryTokens(raw));
}

function buildMemoryFtsQueryFromTokens(inputTokens: string[]): string | null {
  const tokens = inputTokens
    .slice(0, 12)
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
  return `(${alias}.lifecycle_state IS NULL OR ${alias}.lifecycle_state != 'suppressed')
    AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > unixepoch('now') * 1000)
    AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= unixepoch('now') * 1000)
    AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > unixepoch('now') * 1000)
    AND (${alias}.tags_json IS NULL OR ${alias}.tags_json NOT LIKE '%"compacted"%')`;
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
            m.kind, m.lifecycle_state, m.current_version, m.last_accessed_at, m.confidence_score, m.utility_score, m.expires_at,
            m.valid_from, m.valid_until, m.permissions_json, m.source_refs_json, m.conflicts_json,
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
    `SELECT id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at,
            kind, lifecycle_state, current_version, last_accessed_at, confidence_score, utility_score, expires_at,
            valid_from, valid_until, permissions_json, source_refs_json, conflicts_json
     FROM memories
     WHERE tenant_id = ?
       AND ${searchableFilterSql("memories")}
     ORDER BY ${buildProjectOrderSql("memories", projectId)}created_at DESC
     LIMIT ?`
  )
    .bind(tenantId, ...bindProjectArgs(projectId), limit)
    .all<StoredMemory>();

  return result.results.filter((row) => !isLowSignalMemory(row));
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
    dedupe_key: normalizeDedupeKey(summary || row.content || row.id),
    memory_kind: normalizeMemoryKind(row.kind),
    lifecycle_state: normalizeLifecycleState(row.lifecycle_state),
    current_version: Number(row.current_version ?? 1),
    confidence_score: row.confidence_score,
    utility_score: row.utility_score,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    permissions_json: row.permissions_json,
    source_refs_json: row.source_refs_json,
    conflicts_json: row.conflicts_json
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
    created_at: candidate.created_at,
    memory_kind: candidate.kind === "memory" ? ((candidate as SearchCandidate & { memory_kind?: MemoryKind }).memory_kind ?? "episodic") : undefined,
    lifecycle_state:
      candidate.kind === "memory"
        ? ((candidate as SearchCandidate & { lifecycle_state?: MemoryLifecycleState }).lifecycle_state ?? "active")
        : undefined,
    current_version:
      candidate.kind === "memory"
        ? ((candidate as SearchCandidate & { current_version?: number }).current_version ?? 1)
        : undefined,
    score_breakdown: candidate.score_breakdown,
    source_references: parseJsonArray<MemorySourceReference>(candidate.source_refs_json),
    conflicts: parseJsonArray<string>(candidate.conflicts_json),
    permission_decision: candidate.permission_decision
  };
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parsePermissionPrincipals(raw: string | null | undefined): Array<{
  principal_type?: string;
  principal_id?: string;
  permissions?: unknown;
}> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function candidateAllowed(candidate: SearchCandidate, principalId: string | null | undefined): boolean {
  const grants = parsePermissionPrincipals(candidate.permissions_json);
  if (grants.length === 0) return true;
  if (!principalId) return false;
  return grants.some(
    (grant) =>
      grant.principal_type === "principal" &&
      grant.principal_id === principalId &&
      Array.isArray(grant.permissions) &&
      grant.permissions.includes("read")
  );
}

function queryTokens(raw: string): string[] {
  return [
    ...new Set(
      collapseWhitespace(raw)
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  ].slice(0, 6);
}

async function loadGraphScores(
  db: D1Database,
  tenantId: string,
  query: string,
  limit: number
): Promise<Map<string, number>> {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return new Map();
  const entityMatch = tokens.map(() => "LOWER(e.canonical_name) LIKE ?").join(" OR ");
  const direct = await db.prepare(
    `SELECT me.memory_id, COUNT(DISTINCT me.entity_id) AS match_count
     FROM memory_entities me
     JOIN entities e ON e.tenant_id = me.tenant_id AND e.id = me.entity_id
     WHERE me.tenant_id = ? AND (${entityMatch})
     GROUP BY me.memory_id
     ORDER BY match_count DESC
     LIMIT ?`
  )
    .bind(tenantId, ...tokens.map((token) => `%${token}%`), limit)
    .all<{ memory_id: string; match_count: number }>();

  const scores = new Map<string, number>();
  for (const row of direct.results) {
    scores.set(row.memory_id, Math.min(1, 0.75 + Number(row.match_count ?? 0) * 0.125));
  }
  const directIds = [...scores.keys()];
  if (directIds.length === 0) return scores;

  const placeholders = directIds.map(() => "?").join(",");
  const neighbors = await db.prepare(
    `SELECT from_memory_id, to_memory_id
     FROM memory_edges
     WHERE tenant_id = ?
       AND (from_memory_id IN (${placeholders}) OR to_memory_id IN (${placeholders}))
     LIMIT ?`
  )
    .bind(tenantId, ...directIds, ...directIds, limit * 4)
    .all<{ from_memory_id: string; to_memory_id: string }>();
  const directSet = new Set(directIds);
  for (const edge of neighbors.results) {
    const neighbor = directSet.has(edge.from_memory_id) ? edge.to_memory_id : edge.from_memory_id;
    scores.set(neighbor, Math.max(scores.get(neighbor) ?? 0, 0.6));
  }
  return scores;
}

async function loadMemoryRowsByIds(
  db: D1Database,
  tenantId: string,
  ids: string[]
): Promise<MemoryCandidateRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at,
            kind, lifecycle_state, current_version, last_accessed_at, confidence_score, utility_score, expires_at,
            valid_from, valid_until, permissions_json, source_refs_json, conflicts_json, NULL AS raw_rank
     FROM memories
     WHERE tenant_id = ? AND id IN (${placeholders}) AND ${searchableFilterSql("memories")}`
  )
    .bind(tenantId, ...ids)
    .all<MemoryCandidateRow>();
  return result.results;
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

/**
 * Unit-level product retrieval. Gold labels and benchmark identifiers never
 * enter this function: its only inputs are the caller query, tenant/project
 * scope, and rebuildable lexical/semantic projections.
 */
export async function searchTenantRetrievalUnitsV3(
  db: D1Database,
  options: MemorySearchOptions
): Promise<MemorySearchResponse> {
  const tenantId = options.tenantId;
  const projectId = options.projectId?.trim() || null;
  const q = collapseWhitespace(options.q);
  const limit = Math.max(1, Math.min(50, options.limit ?? 5));
  const intent = analyzeRetrievalIntent(q);
  const referenceAt = Date.now();
  const relativeWeekdayAgeMs = Number.isInteger(intent.relative_weekday)
    ? ((new Date(referenceAt).getUTCDay() - Number(intent.relative_weekday) + 7) % 7 || 7) * DAY_MS
    : null;
  const relativeAgeMs = intent.relative_age_ms ?? relativeWeekdayAgeMs;
  const relativeTargetAt = relativeAgeMs === null ? null : referenceAt - relativeAgeMs;
  const variants = buildMemoryQueryVariants(q, options.rewriteQuery ?? false);
  const ftsQuery = variants[0]?.ftsQuery ?? null;
  const subjectFtsQuery = buildMemoryFtsQueryFromTokens(retrievalSubjectQueryTokens(q));
  const lexicalResult = ftsQuery
    ? await db.prepare(
        `SELECT u.id, u.memory_id, u.tenant_id, u.project_id, u.unit_type, u.speaker,
                u.text, u.event_at, u.valid_from, u.valid_until, u.extractor,
                u.extractor_version, u.extraction_state, u.degraded_reason,
                u.created_at, bm25(memory_retrieval_units_fts) AS raw_rank
         FROM memory_retrieval_units_fts
         JOIN memory_retrieval_units u
           ON u.id = memory_retrieval_units_fts.unit_id
          AND u.tenant_id = memory_retrieval_units_fts.tenant_id
         JOIN memories m
           ON m.id = u.memory_id
          AND m.tenant_id = u.tenant_id
         WHERE memory_retrieval_units_fts.tenant_id = ?
           AND memory_retrieval_units_fts.text MATCH ?
           AND (? IS NULL OR u.project_id = ?)
           AND ${searchableFilterSql("m")}
           AND (u.valid_from IS NULL OR u.valid_from <= unixepoch('now') * 1000)
           AND (u.valid_until IS NULL OR u.valid_until > unixepoch('now') * 1000)
         ORDER BY bm25(memory_retrieval_units_fts) ASC,
                  u.content_hash ASC,
                  COALESCE(u.event_at, u.created_at) ASC
         LIMIT 50`
      )
        .bind(tenantId, ftsQuery, projectId, projectId)
        .all<RetrievalUnitCandidateRow>()
    : { results: [] as RetrievalUnitCandidateRow[] };
  const lexicalRows = lexicalResult.results;
  const subjectLexicalResult =
    subjectFtsQuery && subjectFtsQuery !== ftsQuery
      ? await db.prepare(
          `SELECT u.id, u.memory_id, u.tenant_id, u.project_id, u.unit_type, u.speaker,
                  u.text, u.event_at, u.valid_from, u.valid_until, u.extractor,
                  u.extractor_version, u.extraction_state, u.degraded_reason,
                  u.created_at, bm25(memory_retrieval_units_fts) AS raw_rank
           FROM memory_retrieval_units_fts
           JOIN memory_retrieval_units u
             ON u.id = memory_retrieval_units_fts.unit_id
            AND u.tenant_id = memory_retrieval_units_fts.tenant_id
           JOIN memories m
             ON m.id = u.memory_id
            AND m.tenant_id = u.tenant_id
           WHERE memory_retrieval_units_fts.tenant_id = ?
             AND memory_retrieval_units_fts.text MATCH ?
             AND (? IS NULL OR u.project_id = ?)
             AND ${searchableFilterSql("m")}
             AND (u.valid_from IS NULL OR u.valid_from <= unixepoch('now') * 1000)
             AND (u.valid_until IS NULL OR u.valid_until > unixepoch('now') * 1000)
           ORDER BY bm25(memory_retrieval_units_fts) ASC,
                    u.content_hash ASC,
                    COALESCE(u.event_at, u.created_at) ASC
           LIMIT 50`
        )
          .bind(tenantId, subjectFtsQuery, projectId, projectId)
          .all<RetrievalUnitCandidateRow>()
      : lexicalResult;
  const subjectLexicalRows = subjectLexicalResult.results;
  const unitById = new Map(lexicalRows.map((row) => [row.id, row]));
  for (const row of subjectLexicalRows) unitById.set(row.id, row);
  const relativeWindowMs =
    relativeAgeMs === null
      ? null
      : intent.relative_weekday !== null
        ? DAY_MS
        : Math.max(24 * 60 * 60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, relativeAgeMs * 0.5));
  const temporalLexicalResult =
    subjectFtsQuery && relativeTargetAt !== null && relativeWindowMs !== null
      ? await db.prepare(
          `SELECT u.id, u.memory_id, u.tenant_id, u.project_id, u.unit_type, u.speaker,
                  u.text, u.event_at, u.valid_from, u.valid_until, u.extractor,
                  u.extractor_version, u.extraction_state, u.degraded_reason,
                  u.created_at, bm25(memory_retrieval_units_fts) AS raw_rank
           FROM memory_retrieval_units_fts
           JOIN memory_retrieval_units u
             ON u.id = memory_retrieval_units_fts.unit_id
            AND u.tenant_id = memory_retrieval_units_fts.tenant_id
           JOIN memories m
             ON m.id = u.memory_id
            AND m.tenant_id = u.tenant_id
           WHERE memory_retrieval_units_fts.tenant_id = ?
             AND memory_retrieval_units_fts.text MATCH ?
             AND (? IS NULL OR u.project_id = ?)
             AND ${searchableFilterSql("m")}
             AND (u.valid_from IS NULL OR u.valid_from <= unixepoch('now') * 1000)
             AND (u.valid_until IS NULL OR u.valid_until > unixepoch('now') * 1000)
             AND ABS(COALESCE(u.event_at, u.created_at) - ?) <= ?
           ORDER BY ABS(COALESCE(u.event_at, u.created_at) - ?) ASC,
                    bm25(memory_retrieval_units_fts) ASC,
                    u.content_hash ASC,
                    COALESCE(u.event_at, u.created_at) ASC
           LIMIT 50`
        )
          .bind(
            tenantId,
            subjectFtsQuery,
            projectId,
            projectId,
            relativeTargetAt,
            relativeWindowMs,
            relativeTargetAt
          )
          .all<RetrievalUnitCandidateRow>()
      : { results: [] as RetrievalUnitCandidateRow[] };
  const temporalLexicalRows = temporalLexicalResult.results;
  for (const row of temporalLexicalRows) unitById.set(row.id, row);
  const temporalRelevanceResult =
    subjectFtsQuery && relativeTargetAt !== null && relativeWindowMs !== null
      ? await db.prepare(
          `SELECT u.id, u.memory_id, u.tenant_id, u.project_id, u.unit_type, u.speaker,
                  u.text, u.event_at, u.valid_from, u.valid_until, u.extractor,
                  u.extractor_version, u.extraction_state, u.degraded_reason,
                  u.created_at, bm25(memory_retrieval_units_fts) AS raw_rank
           FROM memory_retrieval_units_fts
           JOIN memory_retrieval_units u
             ON u.id = memory_retrieval_units_fts.unit_id
            AND u.tenant_id = memory_retrieval_units_fts.tenant_id
           JOIN memories m
             ON m.id = u.memory_id
            AND m.tenant_id = u.tenant_id
           WHERE memory_retrieval_units_fts.tenant_id = ?
             AND memory_retrieval_units_fts.text MATCH ?
             AND (? IS NULL OR u.project_id = ?)
             AND ${searchableFilterSql("m")}
             AND (u.valid_from IS NULL OR u.valid_from <= unixepoch('now') * 1000)
             AND (u.valid_until IS NULL OR u.valid_until > unixepoch('now') * 1000)
             AND ABS(COALESCE(u.event_at, u.created_at) - ?) <= ?
           ORDER BY bm25(memory_retrieval_units_fts) ASC,
                    ABS(COALESCE(u.event_at, u.created_at) - ?) ASC,
                    u.content_hash ASC,
                    COALESCE(u.event_at, u.created_at) ASC
           LIMIT 50`
        )
          .bind(
            tenantId,
            subjectFtsQuery,
            projectId,
            projectId,
            relativeTargetAt,
            relativeWindowMs,
            relativeTargetAt
          )
          .all<RetrievalUnitCandidateRow>()
      : { results: [] as RetrievalUnitCandidateRow[] };
  const temporalRelevanceRows = temporalRelevanceResult.results;
  for (const row of temporalRelevanceRows) unitById.set(row.id, row);
  const temporalResult = relativeTargetAt === null
    ? { results: [] as RetrievalUnitCandidateRow[] }
    : await db.prepare(
        `SELECT u.id, u.memory_id, u.tenant_id, u.project_id, u.unit_type, u.speaker,
                u.text, u.event_at, u.valid_from, u.valid_until, u.extractor,
                u.extractor_version, u.extraction_state, u.degraded_reason,
                u.created_at, NULL AS raw_rank
         FROM memory_retrieval_units u
         JOIN memories m
           ON m.id = u.memory_id
          AND m.tenant_id = u.tenant_id
         WHERE u.tenant_id = ?
           AND u.unit_type = 'session'
           AND (? IS NULL OR u.project_id = ?)
           AND ${searchableFilterSql("m")}
           AND (u.valid_from IS NULL OR u.valid_from <= unixepoch('now') * 1000)
           AND (u.valid_until IS NULL OR u.valid_until > unixepoch('now') * 1000)
         ORDER BY ABS(COALESCE(u.event_at, u.created_at) - ?) ASC
         LIMIT 200`
      )
        .bind(tenantId, projectId, projectId, relativeTargetAt)
        .all<RetrievalUnitCandidateRow>();
  const temporalRows = temporalResult.results;
  for (const row of temporalRows) unitById.set(row.id, row);
  const semanticHits = (options.semanticHits ?? []).slice(0, 50);
  const missingUnitIds = semanticHits.map((hit) => hit.id).filter((id) => !unitById.has(id));
  if (missingUnitIds.length > 0) {
    const placeholders = missingUnitIds.map(() => "?").join(",");
    const loaded = await db.prepare(
      `SELECT u.id, u.memory_id, u.tenant_id, u.project_id, u.unit_type, u.speaker,
              u.text, u.event_at, u.valid_from, u.valid_until, u.extractor,
              u.extractor_version, u.extraction_state, u.degraded_reason,
              u.created_at, NULL AS raw_rank
       FROM memory_retrieval_units u
       JOIN memories m ON m.id = u.memory_id AND m.tenant_id = u.tenant_id
       WHERE u.tenant_id = ? AND u.id IN (${placeholders})
         AND (? IS NULL OR u.project_id = ?)
         AND ${searchableFilterSql("m")}
         AND (u.valid_from IS NULL OR u.valid_from <= unixepoch('now') * 1000)
         AND (u.valid_until IS NULL OR u.valid_until > unixepoch('now') * 1000)`
    )
      .bind(tenantId, ...missingUnitIds, projectId, projectId)
      .all<RetrievalUnitCandidateRow>();
    for (const row of loaded.results) unitById.set(row.id, row);
  }

  const unitScores = new Map<string, number>();
  lexicalRows.forEach((row, index) => {
    unitScores.set(row.id, (unitScores.get(row.id) ?? 0) + 1 / (60 + index + 1));
  });
  subjectLexicalRows.forEach((row, index) => {
    unitScores.set(row.id, (unitScores.get(row.id) ?? 0) + 1.25 / (60 + index + 1));
  });
  temporalLexicalRows.forEach((row, index) => {
    unitScores.set(row.id, (unitScores.get(row.id) ?? 0) + 1 / (60 + index + 1));
  });
  temporalRelevanceRows.forEach((row, index) => {
    unitScores.set(row.id, (unitScores.get(row.id) ?? 0) + 1 / (60 + index + 1));
  });
  semanticHits.forEach((hit, index) => {
    if (!unitById.has(hit.id)) return;
    unitScores.set(hit.id, (unitScores.get(hit.id) ?? 0) + 1 / (60 + index + 1));
  });
  temporalRows.forEach((row, index) => {
    unitScores.set(row.id, (unitScores.get(row.id) ?? 0) + 0.75 / (60 + index + 1));
  });
  const lexicalSpecificity = retrievalUnitLexicalSpecificity([...unitById.values()], q);
  const parentUnitScores = new Map<string, Array<{
    unit: RetrievalUnitCandidateRow;
    score: number;
    intentBoost: number;
    lexicalSpecificity: number;
  }>>();
  for (const [unitId, rrfScore] of unitScores) {
    const unit = unitById.get(unitId);
    if (!unit) continue;
    let intentBoost = 0;
    if (intent.speaker) {
      if (unit.speaker === intent.speaker) intentBoost += 0.006;
      else if (unit.speaker && unit.speaker !== "unknown") intentBoost -= 0.002;
    }
    if (intent.unit_types.includes(unit.unit_type as never)) intentBoost += 0.006;
    const current = parentUnitScores.get(unit.memory_id) ?? [];
    current.push({
      unit,
      score: rrfScore,
      intentBoost,
      lexicalSpecificity: lexicalSpecificity.get(unitId) ?? 0
    });
    parentUnitScores.set(unit.memory_id, current);
  }

  const rankedParentIds = [...parentUnitScores.entries()]
    .map(([memoryId, units]) => ({
      memoryId,
      score: units
        .sort((left, right) => right.score - left.score)
        .slice(0, 3)
        .reduce((sum, entry, index) => sum + entry.score * [1, 0.25, 0.1][index], 0) +
        Math.max(0, ...units.map((entry) => entry.intentBoost)) +
        Math.max(0, ...units.map((entry) => entry.lexicalSpecificity)) * 0.02
    }))
    .sort((left, right) => right.score - left.score);
  const parentIds = rankedParentIds.slice(0, 20);
  const reservedTemporalMemoryIds =
    relativeTargetAt === null
      ? []
      : [...new Set(
          [
            ...temporalLexicalRows.slice(0, 2).map((row) => row.memory_id),
            ...temporalRelevanceRows.slice(0, 2).map((row) => row.memory_id),
            ...temporalRows.map((row) => row.memory_id)
          ]
        )].slice(0, 4);
  for (const memoryId of reservedTemporalMemoryIds) {
    if (parentIds.some((item) => item.memoryId === memoryId)) continue;
    const reserved = rankedParentIds.find((item) => item.memoryId === memoryId);
    if (!reserved) continue;
    parentIds.splice(Math.max(0, parentIds.length - 1), 1, reserved);
  }
  const parentRows = await loadMemoryRowsByIds(db, tenantId, parentIds.map((item) => item.memoryId));
  const rowById = new Map(parentRows.map((row) => [row.id, row]));
  const rerankerScores = options.rerankerScores ?? new Map<string, number>();
  const eventTimes = parentIds.map(({ memoryId }) =>
    Math.max(...(parentUnitScores.get(memoryId) ?? []).map(({ unit }) => unit.event_at ?? 0))
  );
  const finiteEventTimes = eventTimes.filter((value) => value > 0);
  const minEventAt = finiteEventTimes.length > 0 ? Math.min(...finiteEventTimes) : 0;
  const maxEventAt = finiteEventTimes.length > 0 ? Math.max(...finiteEventTimes) : 0;
  const eventRange = Math.max(1, maxEventAt - minEventAt);
  const relativeDistances = relativeTargetAt === null
    ? []
    : eventTimes
      .filter((eventAt) => eventAt > 0)
      .map((eventAt) => Math.abs(eventAt - relativeTargetAt));
  const minRelativeDistance = relativeDistances.length > 0 ? Math.min(...relativeDistances) : 0;
  const maxRelativeDistance = relativeDistances.length > 0 ? Math.max(...relativeDistances) : 0;
  const relativeDistanceRange = Math.max(1, maxRelativeDistance - minRelativeDistance);
  const ranked = parentIds.flatMap<SearchCandidate>(({ memoryId, score: baseScore }) => {
    const row = rowById.get(memoryId);
    if (!row) return [];
    const candidate = toMemorySearchCandidate(row);
    if (!candidateAllowed(candidate, options.principalId)) return [];
    const units = parentUnitScores.get(memoryId) ?? [];
    const eventAt = Math.max(...units.map(({ unit }) => unit.event_at ?? 0));
    const temporal =
      relativeTargetAt !== null && eventAt > 0
        ? (1 - (Math.abs(eventAt - relativeTargetAt) - minRelativeDistance) / relativeDistanceRange) * 0.02
        : intent.temporal_direction && eventAt > 0
          ? (intent.temporal_direction === "latest"
            ? (eventAt - minEventAt) / eventRange
            : (maxEventAt - eventAt) / eventRange) * 0.006
          : 0;
    const reranker = rerankerScores.get(memoryId);
    const total = baseScore + temporal + (reranker === undefined ? 0 : Math.max(0, Math.min(1, reranker)) * 0.02);
    candidate.score_breakdown = {
      total: Number(total.toFixed(6)),
      lexical: units.some(({ unit }) => unit.raw_rank !== null) ? 1 : 0,
      semantic: semanticHits.some((hit) => units.some(({ unit }) => unit.id === hit.id)) ? 1 : null,
      graph: null,
      time:
        intent.temporal_direction || relativeTargetAt !== null
          ? Number((temporal / (relativeTargetAt === null ? 0.006 : 0.02)).toFixed(6))
          : 0,
      authority: 0,
      utility: 0,
      active_components: [
        ...(units.some(({ unit }) => unit.raw_rank !== null) ? ["lexical" as const] : []),
        ...(semanticHits.some((hit) => units.some(({ unit }) => unit.id === hit.id)) ? ["semantic" as const] : []),
        ...(intent.temporal_direction || relativeTargetAt !== null ? ["time" as const] : [])
      ]
    };
    candidate.permission_decision = { allowed: true, principal_id: options.principalId ?? null };
    return [candidate];
  }).sort((left, right) =>
    (right.score_breakdown?.total ?? 0) - (left.score_breakdown?.total ?? 0)
  );
  const finalCandidates = ranked.slice(0, limit);
  if (relativeTargetAt !== null) {
    let replacementIndex = finalCandidates.length - 1;
    for (const memoryId of reservedTemporalMemoryIds) {
      if (finalCandidates.some((candidate) => candidate.id === memoryId)) continue;
      const reserved = ranked.find((candidate) => candidate.id === memoryId);
      if (!reserved) continue;
      finalCandidates.splice(Math.max(0, replacementIndex), 1, reserved);
      replacementIndex -= 1;
    }
    finalCandidates.sort(
      (left, right) => (right.score_breakdown?.total ?? 0) - (left.score_breakdown?.total ?? 0)
    );
  }
  const allUnits = [...unitById.values()];
  const degradedReasons = [...new Set(
    allUnits
      .filter((unit) => unit.extraction_state !== "ready")
      .map((unit) => unit.degraded_reason || "atomic_extraction_degraded")
  )];
  if (options.semanticHits === undefined) degradedReasons.push("semantic_provider_unavailable");
  if (options.rerankerScores === undefined) degradedReasons.push("reranker_unavailable");
  const latestProjectionAt = allUnits.length > 0 ? Math.max(...allUnits.map((unit) => unit.created_at)) : null;

  return {
    tenant_id: tenantId,
    project_id: projectId,
    q,
    rewrite_query: options.rewriteQuery ?? false,
    search_mode: "hybrid_v3",
    include_history: false,
    results: finalCandidates.map((candidate) => {
      const result = toPublicResult(candidate);
      result.score = candidate.score_breakdown?.total ?? null;
      return result;
    }),
    meta: {
      search_strategy: "hybrid_v3",
      matched_count: parentIds.length,
      returned_count: finalCandidates.length,
      fallback_used: options.semanticHits === undefined || options.rerankerScores === undefined,
      variant_count: variants.length,
      lexical_result_count: lexicalRows.length,
      doc_result_count: 0,
      history_result_count: 0,
      top_result_ids: finalCandidates.map((candidate) => candidate.id),
      top_result_ranks: finalCandidates.map((candidate) => candidate.score_breakdown?.total ?? null),
      retrieval: {
        semantic: {
          available: options.semanticHits !== undefined,
          provider: options.semanticProvider ?? null
        },
        graph: { available: false, provider: "none" },
        degraded: degradedReasons.length > 0,
        embedding_version: options.semanticProvider ?? null,
        reranker_version: options.rerankerProvider ?? null,
        extractor_version: allUnits[0]?.extractor_version ?? null,
        lexical_candidate_count: lexicalRows.length,
        semantic_candidate_count: semanticHits.length,
        parent_candidate_count: parentIds.length,
        projection_lag_ms: latestProjectionAt === null ? null : Math.max(0, Date.now() - latestProjectionAt),
        degraded_reasons: [...new Set(degradedReasons)]
      }
    }
  };
}

/**
 * Generic v4 fusion over the independent atomic/profile/timeline/segment
 * projection. The v3 result set remains untouched and is used as one candidate
 * channel, so callers can shadow v4 without changing v3 behavior.
 */
export async function searchTenantRetrievalUnitsV4(
  db: D1Database,
  options: MemorySearchOptions
): Promise<MemorySearchResponse> {
  const limit = Math.max(1, Math.min(50, options.limit ?? 5));
  const base = await searchTenantRetrievalUnitsV3(db, {
    ...options,
    limit: 50,
    semanticHits: undefined,
    semanticProvider: null
  });
  const ftsQuery = buildMemoryFtsQuery(options.q);
  const intent = analyzeRetrievalIntent(options.q);
  const projectId = options.projectId?.trim() || null;
  const rows = ftsQuery
    ? await db.prepare(
        `SELECT u.memory_id, u.unit_type,
                bm25(memory_retrieval_units_v4_fts) AS raw_rank
         FROM memory_retrieval_units_v4_fts
         JOIN memory_retrieval_units_v4 u
           ON u.id = memory_retrieval_units_v4_fts.unit_id
          AND u.tenant_id = memory_retrieval_units_v4_fts.tenant_id
         JOIN memories m
           ON m.id = u.memory_id
          AND m.tenant_id = u.tenant_id
         WHERE memory_retrieval_units_v4_fts.tenant_id = ?
           AND memory_retrieval_units_v4_fts.text MATCH ?
           AND (? IS NULL OR u.project_id = ?)
           AND ${searchableFilterSql("m")}
         ORDER BY bm25(memory_retrieval_units_v4_fts), u.content_hash
         LIMIT 200`
      )
        .bind(options.tenantId, ftsQuery, projectId, projectId)
        .all<{ memory_id: string; unit_type: string; raw_rank: number }>()
    : { results: [] as Array<{ memory_id: string; unit_type: string; raw_rank: number }> };
  const scores = new Map<string, number>();
  base.results.forEach((result, index) => scores.set(result.id, 1 / (60 + index + 1)));
  const semanticHits = (options.semanticHits ?? []).slice(0, 50);
  const semanticParents = semanticHits.length === 0
    ? { results: [] as Array<{ id: string; memory_id: string }> }
    : await db.prepare(
        `SELECT id, memory_id
         FROM memory_retrieval_units_v4
         WHERE tenant_id = ? AND id IN (${semanticHits.map(() => "?").join(",")})`
      ).bind(options.tenantId, ...semanticHits.map((hit) => hit.id))
        .all<{ id: string; memory_id: string }>();
  const semanticParentByUnit = new Map(
    semanticParents.results.map((row) => [row.id, row.memory_id])
  );
  semanticHits.forEach((hit, index) => {
    const memoryId = semanticParentByUnit.get(hit.id);
    if (!memoryId) return;
    scores.set(memoryId, (scores.get(memoryId) ?? 0) + 0.9 / (60 + index + 1));
  });
  const channelRanks = new Map<string, number>();
  for (const row of rows.results) {
    const key = `${row.unit_type}\0${row.memory_id}`;
    if (channelRanks.has(key)) continue;
    const rank = [...channelRanks.keys()].filter((candidate) =>
      candidate.startsWith(`${row.unit_type}\0`)
    ).length;
    channelRanks.set(key, rank);
    const profileIntent = intent.unit_types.some((type) =>
      ["preference", "instruction", "update", "fact"].includes(type)
    );
    const temporalIntent = intent.temporal_direction !== null || intent.relative_age_ms !== null;
    const weight =
      row.unit_type === "profile" || row.unit_type === "ledger"
        ? profileIntent ? 1.35 : 0.55
        : row.unit_type === "timeline"
          ? temporalIntent ? 1.35 : 0.5
          : row.unit_type === "atomic"
            ? 1.2
            : 0.65;
    scores.set(row.memory_id, (scores.get(row.memory_id) ?? 0) + weight / (60 + rank + 1));
  }
  const results = [...base.results]
    .sort((left, right) =>
      (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0) ||
      (right.score ?? 0) - (left.score ?? 0) ||
      left.id.localeCompare(right.id)
    )
    .slice(0, limit)
    .map((result) => ({ ...result, score: Number((scores.get(result.id) ?? 0).toFixed(6)) }));
  const degradedReasons = [
    ...(base.meta.retrieval?.degraded_reasons ?? []),
    ...(rows.results.some((row) => row.unit_type === "segment")
      ? []
      : ["segment_candidates_unavailable"])
  ];
  return {
    ...base,
    search_mode: "hybrid_v4",
    results,
    meta: {
      ...base.meta,
      search_strategy: "hybrid_v4",
      matched_count: scores.size,
      returned_count: results.length,
      top_result_ids: results.map((result) => result.id),
      top_result_ranks: results.map((result) => result.score),
      retrieval: {
        ...base.meta.retrieval!,
        degraded: degradedReasons.length > 0,
        degraded_reasons: [...new Set(degradedReasons)],
        parent_candidate_count: base.results.length,
        semantic_candidate_count: semanticHits.length,
        embedding_version: options.semanticProvider ?? null
      }
    }
  };
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
  let rankedMemoryCandidates = lexicalCandidates;
  let graphScores = new Map<string, number>();
  const semanticScores = new Map((options.semanticHits ?? []).map((hit) => [hit.id, hit.score]));

  if (searchMode === "hybrid_v2") {
    graphScores = await loadGraphScores(db, tenantId, q, lexicalFetchLimit);
    const candidateById = new Map(lexicalCandidates.map((candidate) => [candidate.id, candidate]));
    const projectionIds = [...new Set([...graphScores.keys(), ...semanticScores.keys()])]
      .filter((id) => !candidateById.has(id))
      .slice(0, lexicalFetchLimit);
    const projectionRows = await loadMemoryRowsByIds(db, tenantId, projectionIds);
    for (const row of projectionRows) {
      candidateById.set(row.id, toMemorySearchCandidate(row));
    }

    const fused = fuseRetrievalSignals(
      [...candidateById.values()].map((candidate) => ({
        id: candidate.id,
        lexical: toPublicScore(candidate.raw_rank),
        semantic: semanticScores.get(candidate.id),
        graph: graphScores.get(candidate.id),
        created_at: candidate.created_at,
        valid_from: candidate.valid_from,
        valid_until: candidate.valid_until,
        confidence: candidate.confidence_score,
        utility: candidate.utility_score,
        authority:
          candidate.memory_kind === "decision" || candidate.source === "curated" ? 1 : 0.7,
        allowed: candidateAllowed(candidate, options.principalId)
      })),
      {
        availability: {
          semantic: options.semanticHits !== undefined,
          graph: true
        }
      }
    );
    rankedMemoryCandidates = fused.flatMap<SearchCandidate>((hit) => {
        const candidate = candidateById.get(hit.id);
        if (!candidate) return [];
        return [{
          ...candidate,
          graph_score: graphScores.get(hit.id) ?? null,
          semantic_score: semanticScores.get(hit.id) ?? null,
          score_breakdown: hit.score,
          permission_decision: {
            allowed: true,
            principal_id: options.principalId ?? null
          }
        }];
      });
  }

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

  const baseCandidates = dedupeFinalCandidates([...rankedMemoryCandidates, ...docCandidates], limit);
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
  if (searchMode === "hybrid_v2") {
    searchStrategy = "hybrid_v2";
  } else if (shouldSearchDocs) {
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
    results: finalCandidates.map((candidate) => {
      const result = toPublicResult(candidate);
      if (candidate.score_breakdown) result.score = candidate.score_breakdown.total;
      return result;
    }),
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
      top_result_ranks: finalCandidates.map((candidate) =>
        candidate.score_breakdown ? candidate.score_breakdown.total : candidate.raw_rank
      ),
      retrieval:
        searchMode === "hybrid_v2"
          ? {
              semantic: {
                available: options.semanticHits !== undefined,
                provider: options.semanticProvider ?? null
              },
              graph: { available: true, provider: "d1-memory-graph" },
              degraded: options.semanticHits === undefined
            }
          : undefined
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
    tags,
    memory_kind: normalizeMemoryKind(row.kind),
    lifecycle_state: normalizeLifecycleState(row.lifecycle_state),
    current_version: Number(row.current_version ?? 1),
    last_accessed_at: row.last_accessed_at ?? null,
    confidence_score: row.confidence_score ?? null,
    utility_score: row.utility_score ?? null
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
        memoryKindPriority(normalizeMemoryKind(left.kind)) - memoryKindPriority(normalizeMemoryKind(right.kind)) ||
        memoryTierPriority(leftTags) - memoryTierPriority(rightTags) ||
        compareMemoryQuality(left, right) ||
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
