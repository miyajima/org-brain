import { sha256Hex } from "@org-brain/core";
import { HttpError, estimateTextTokens, memoryReadAccessSql, ulid } from "@org-brain/shared";
import type { Env } from "./types";

export type TeamActor = { tenantId: string; principal: string; isTenantAdmin?: boolean; projectId?: string | null };
export type ShareType = "memory" | "decision_memory" | "knowledge_doc" | "knowledge_resource";
export type ShareSource = { type: ShareType; id: string; expectedPolicyVersion: number };
export type ShareInput = ShareSource & { minimumRank: number; targets: string[]; expiresAt?: number | null; expectedShareId?: string | null };

type Membership = { company_id: string; rank: number };
type Source = { title: string; content: string; revision: string; policy_id: string; policy_version: number; scope: string; legacy_private: number };
type SharedResult = {
  id: string;
  kind: "all" | "role";
  source_tenant_id: string;
  resource_type: ShareType;
  resource_id: string;
  title: string;
  content: string;
  revision: string;
  updated_at: number;
  access_reason: "all" | "tenant_role" | "company_admin" | "target_tenant";
  expires_at: number | null;
  minimum_rank: number;
};

export function teamKnowledgeEnabled(env: Env) {
  return env.TEAM_KNOWLEDGE_ENABLED === "true";
}

export async function teamKnowledgeStatus(env: Env, actor: TeamActor) {
  const member = await membership(env, actor);
  if (!member) return { enabled: false as const };
  const { results } = await env.OPEN_BRAIN_DB.prepare(`
    SELECT t.tenant_id,COALESCE(o.display_name,t.tenant_id) AS label
    FROM team_knowledge_tenants t LEFT JOIN organizations o ON o.tenant_id = t.tenant_id
    WHERE t.company_id = ? ORDER BY label,t.tenant_id
  `).bind(member.company_id).all<{ tenant_id: string; label: string }>();
  return { enabled: true as const, rank: member.rank, can_manage: member.rank === 4 || actor.isTenantAdmin === true, tenants: results };
}

export async function updateTeamKnowledgeRole(env: Env, actor: TeamActor, tenantId: string, principal: string, rank: number) {
  const member = await requireMember(env, actor);
  if (principal === actor.principal || (member.rank !== 4 && (!actor.isTenantAdmin || tenantId !== actor.tenantId || rank > 2))) {
    throw new HttpError(403, "team_role_forbidden", "You cannot assign that role");
  }
  const db = env.OPEN_BRAIN_DB;
  const target = await db.prepare(`
    SELECT COALESCE(r.rank,1) AS rank,a.principal AS administrator
    FROM team_knowledge_tenants t JOIN user_profiles u ON u.tenant_id = t.tenant_id AND u.status = 'active'
    LEFT JOIN team_knowledge_roles r ON r.tenant_id = t.tenant_id AND r.principal = u.principal
    LEFT JOIN team_knowledge_admins a ON a.company_id = t.company_id AND a.tenant_id = t.tenant_id AND a.principal = u.principal
    WHERE t.company_id = ? AND t.tenant_id = ? AND u.principal = ?
  `).bind(member.company_id, tenantId, principal).first<{ rank: number; administrator: string | null }>();
  if (!target) throw missing();
  if (member.rank !== 4 && (target.rank > 2 || target.administrator)) {
    throw new HttpError(403, "team_role_forbidden", "You cannot change an executive or company administrator");
  }
  await db.batch([
    db.prepare(`
      INSERT INTO team_knowledge_roles(tenant_id,principal,rank) VALUES(?,?,?)
      ON CONFLICT(tenant_id,principal) DO UPDATE SET rank = excluded.rank
    `).bind(tenantId, principal, Math.min(rank, 3)),
    rank === 4
      ? db.prepare("INSERT OR IGNORE INTO team_knowledge_admins(company_id,tenant_id,principal) VALUES(?,?,?)")
        .bind(member.company_id, tenantId, principal)
      : db.prepare("DELETE FROM team_knowledge_admins WHERE company_id = ? AND tenant_id = ? AND principal = ?")
        .bind(member.company_id, tenantId, principal)
  ]);
  return { tenant_id: tenantId, principal, rank };
}

async function membership(env: Env, actor: TeamActor) {
  if (!teamKnowledgeEnabled(env) || actor.projectId) return null;
  return env.OPEN_BRAIN_DB.prepare(`
    SELECT t.company_id, CASE WHEN a.principal IS NOT NULL THEN 4 ELSE COALESCE(r.rank,1) END AS rank
    FROM team_knowledge_tenants t
    JOIN user_profiles u ON u.tenant_id = t.tenant_id AND u.principal = ? AND u.status = 'active'
    LEFT JOIN team_knowledge_roles r ON r.tenant_id = t.tenant_id AND r.principal = u.principal
    LEFT JOIN team_knowledge_admins a ON a.company_id = t.company_id AND a.tenant_id = t.tenant_id AND a.principal = u.principal
    WHERE t.tenant_id = ?
  `).bind(actor.principal, actor.tenantId).first<Membership>();
}

async function requireMember(env: Env, actor: TeamActor, rank = 1) {
  const member = await membership(env, actor);
  if (!member || member.rank < rank) throw new HttpError(403, "team_access_denied", "Team knowledge access is required");
  return member;
}

const ACTIVE_SOURCE = "(d.expires_at IS NULL OR d.expires_at > ?) AND (d.valid_from IS NULL OR d.valid_from <= ?)";
const PRIVATE_ORIGIN = `d.legacy_private = 1 AND NOT EXISTS (
  SELECT 1 FROM resource_acl g WHERE g.tenant_id = p.tenant_id AND g.resource_type = p.resource_type
    AND g.resource_id = p.resource_id AND NOT (g.subject_type = 'principal' AND g.subject_id = p.owner_principal)
)`;

async function sourceForShare(env: Env, actor: TeamActor, input: ShareSource) {
  const now = Date.now();
  const row = await env.OPEN_BRAIN_DB.prepare(`
    SELECT d.title,d.content,d.revision,p.id AS policy_id,p.policy_version,p.scope,p.owner_principal,
      CASE WHEN ${PRIVATE_ORIGIN} THEN 1 ELSE 0 END AS legacy_private
    FROM team_knowledge_sources d
    JOIN resource_access_policies p ON p.tenant_id = d.tenant_id AND p.resource_type = d.resource_type AND p.resource_id = d.resource_id
    WHERE d.tenant_id = ? AND d.resource_type = ? AND d.resource_id = ? AND ${ACTIVE_SOURCE}
  `).bind(actor.tenantId, input.type, input.id, now, now).first<Source & { owner_principal: string }>();
  if (!row || (row.owner_principal !== actor.principal && !actor.isTenantAdmin)) throw missing();
  if (row.policy_version !== input.expectedPolicyVersion) throw new HttpError(409, "policy_conflict", "Reload the sharing policy");
  return row;
}

function missing() {
  return new HttpError(404, "resource_not_found", "Resource not found");
}

const VIEWER_RANK = "CASE WHEN admin.principal IS NOT NULL THEN 4 ELSE COALESCE(role.rank,1) END";
const VISIBLE_SHARES = `
  SELECT s.id,s.kind,s.source_tenant_id,s.resource_type,s.resource_id,s.updated_at,
         CASE WHEN s.kind = 'all' THEN v.title ELSE d.title END AS title,
         CASE WHEN s.kind = 'all' THEN v.content ELSE d.content END AS content,
         CASE WHEN s.kind = 'all' THEN v.source_revision ELSE d.revision END AS revision,
         CASE WHEN s.kind = 'all' THEN 'all' WHEN s.source_tenant_id = viewer.tenant_id THEN 'tenant_role'
           WHEN admin.principal IS NOT NULL THEN 'company_admin' ELSE 'target_tenant' END AS access_reason,
         s.expires_at,s.minimum_rank
  FROM team_knowledge_shares s
  JOIN team_knowledge_tenants viewer ON viewer.company_id = s.company_id AND viewer.tenant_id = ?
  JOIN user_profiles u ON u.tenant_id = viewer.tenant_id AND u.principal = ? AND u.status = 'active'
  LEFT JOIN team_knowledge_roles role ON role.tenant_id = viewer.tenant_id AND role.principal = u.principal
  LEFT JOIN team_knowledge_admins admin ON admin.company_id = viewer.company_id AND admin.tenant_id = viewer.tenant_id AND admin.principal = u.principal
  JOIN team_knowledge_tenants origin ON origin.tenant_id = s.source_tenant_id AND origin.company_id = s.company_id
  JOIN resource_access_policies p ON p.id = s.policy_id AND p.tenant_id = s.source_tenant_id
    AND p.resource_type = s.resource_type AND p.resource_id = s.resource_id AND p.policy_version = s.policy_version
  JOIN team_knowledge_sources d ON d.tenant_id = s.source_tenant_id AND d.resource_type = s.resource_type AND d.resource_id = s.resource_id
  LEFT JOIN team_knowledge_publications v ON v.id = s.publication_id AND v.company_id = s.company_id AND v.approved_at IS NOT NULL
  WHERE ${ACTIVE_SOURCE} AND (s.expires_at IS NULL OR s.expires_at > ?)
    AND (
      (s.kind = 'all' AND v.id IS NOT NULL)
      OR (s.kind = 'role' AND p.scope = 'private' AND ${PRIVATE_ORIGIN} AND (${VIEWER_RANK}) >= s.minimum_rank AND
          (s.source_tenant_id = viewer.tenant_id OR admin.principal IS NOT NULL
            OR ((${VIEWER_RANK}) >= 2 AND viewer.tenant_id IN (SELECT value FROM json_each(s.target_tenants)))))
    )
`;

function visibleBindings(actor: TeamActor) {
  const now = Date.now();
  return [actor.tenantId, actor.principal, now, now, now];
}

const MAX_QUERY_TERMS = 12;
const EXCERPT_CHARS = 600;
const EXCERPT_LEAD_CHARS = 150;
const SEARCH_AUGMENT_LIMIT = 3;
const SEARCH_AUGMENT_BUDGET_SHARE = 0.25;
const SEARCH_AUGMENT_DEFAULT_TOKENS = 450;

type SharedSearchItem = SharedResult & { content_truncated: boolean };
type SharedSearchRow = SharedResult & { match_offset: number; excerpt_start: number; content_length: number };

// Mirrors SQLite lower(), which folds ASCII only, so terms de-duplicate exactly as the SQL compares them.
function asciiLower(value: string) {
  return value.replace(/[A-Z]+/gu, part => part.toLowerCase());
}

// Function words that would otherwise match almost any English text as substrings.
const STOPWORDS = new Set([
  "the", "and", "but", "for", "nor", "not", "with", "from", "into", "onto", "about", "over", "under", "after", "before",
  "between", "through", "during", "without", "within", "are", "was", "were", "been", "being", "does", "did", "has", "have",
  "had", "can", "could", "will", "would", "shall", "should", "may", "might", "must", "you", "your", "our", "ours", "his",
  "her", "hers", "its", "they", "them", "their", "this", "that", "these", "those", "what", "which", "who", "whom", "whose",
  "when", "where", "why", "how", "there", "here", "then", "than", "any", "some", "all"
]);

function qualifies(term: string) {
  const ascii = [...term].every(char => char.charCodeAt(0) < 128);
  return ascii ? term.length >= 3 && !STOPWORDS.has(term) : [...term].length >= 2;
}

export function sharedSearchTerms(query: string) {
  const text = query.trim();
  if (!text) return [];
  const unique = [...new Set(text.split(/[\s\p{P}\p{S}]+/u).map(asciiLower).filter(qualifies))];
  // A term contained in another would match wherever the longer one does, so it only inflates the score.
  const terms = unique.filter(term => !unique.some(other => other !== term && other.includes(term)));
  return terms.length ? terms.slice(0, MAX_QUERY_TERMS) : [asciiLower(text)];
}

export function sharedSearchThreshold(termCount: number) {
  return termCount <= 2 ? termCount : Math.max(2, Math.ceil(termCount / 3));
}

async function querySharedKnowledge(env: Env, actor: TeamActor, query: string, limit: number) {
  const terms = sharedSearchTerms(query);
  const rowLimit = Math.floor(limit);
  if (!teamKnowledgeEnabled(env) || actor.projectId || !terms.length || !Number.isFinite(rowLimit)) return [];
  // All terms travel in one JSON parameter so the bound-parameter count stays constant. Each readable row is
  // lowercased once (MATERIALIZED) and each (row, term) position is computed once in hits.
  const result = await env.OPEN_BRAIN_DB.prepare(`
    WITH readable AS (${VISIBLE_SHARES}), terms AS (SELECT DISTINCT lower(value) AS term FROM json_each(?)),
    folded AS MATERIALIZED (SELECT r.*, lower(r.title) AS folded_title, lower(r.content) AS folded_content FROM readable r),
    hits AS (
      SELECT f.id AS share_id, COALESCE(instr(f.folded_title,t.term),0) > 0 AS in_title,
        COALESCE(instr(f.folded_content,t.term),0) AS content_at
      FROM folded f CROSS JOIN terms t
    ), counts AS (
      SELECT share_id, SUM(in_title OR content_at > 0) AS matched_terms, SUM(in_title) AS title_terms,
        MIN(NULLIF(content_at,0)) AS match_at
      FROM hits GROUP BY share_id
    ), scored AS (
      SELECT f.id,f.kind,f.source_tenant_id,f.resource_type,f.resource_id,f.updated_at,f.title,f.content,f.revision,
        f.access_reason,f.expires_at,f.minimum_rank,c.matched_terms,c.title_terms,c.match_at
      FROM folded f JOIN counts c ON c.share_id = f.id
    ), matched AS (
      SELECT *, MAX(1, COALESCE(match_at,1) - ${EXCERPT_LEAD_CHARS}) AS excerpt_start,
        row_number() OVER(PARTITION BY source_tenant_id,resource_type,resource_id ORDER BY kind ASC) AS occurrence
      FROM scored WHERE matched_terms >= ?
    )
    SELECT id,kind,source_tenant_id,resource_type,resource_id,title,substr(content,excerpt_start,${EXCERPT_CHARS}) AS content,
      revision,updated_at,access_reason,expires_at,minimum_rank,
      COALESCE(match_at,1) - excerpt_start AS match_offset,excerpt_start,length(content) AS content_length
    FROM matched WHERE occurrence = 1
    ORDER BY matched_terms + title_terms DESC,updated_at DESC,id LIMIT ?
  `).bind(...visibleBindings(actor), JSON.stringify(terms), sharedSearchThreshold(terms.length), Math.min(50, Math.max(1, rowLimit)))
    .all<SharedSearchRow>();
  return result.results;
}

function toSearchItem(row: SharedSearchRow): SharedSearchItem {
  const { match_offset: _offset, excerpt_start: start, content_length: length, ...item } = row;
  const content = item.content ?? "";
  return { ...item, content, content_truncated: start > 1 || start - 1 + [...content].length < length };
}

function itemTokens(item: { title: string | null; content: string | null }) {
  return estimateTextTokens(`${item.title ?? ""}${item.content ?? ""}`);
}

// Cuts by code point so surrogate pairs survive, keeping the first match inside the window. The window size is
// binary-searched against the real estimate, and only a size that was measured to fit is returned.
function shortenExcerpt(row: SharedSearchRow, budgetTokens: number) {
  if (itemTokens({ title: row.title, content: "" }) > budgetTokens) return null;
  const chars = [...(row.content ?? "")];
  const window = (size: number) => {
    const from = Math.max(0, Math.min(row.match_offset - Math.floor(size / 4), chars.length - size));
    return chars.slice(from, from + size).join("");
  };
  let fits = 0;
  let over = chars.length + 1;
  while (over - fits > 1) {
    const size = Math.floor((fits + over) / 2);
    if (itemTokens({ title: row.title, content: window(size) }) <= budgetTokens) fits = size;
    else over = size;
  }
  return { ...toSearchItem(row), content: window(fits), content_truncated: true };
}

export type SharedDeliveryPath = "memory_search_api" | "memory_search_mcp" | "direct_search";
export type SharedDeliveryOptions = { accessPath: SharedDeliveryPath; waitUntil?: (promise: Promise<unknown>) => void };

async function writeDeliveries(env: Env, actor: TeamActor, query: string, accessPath: SharedDeliveryPath, items: SharedSearchItem[]) {
  try {
    const queryHash = await sha256Hex(query.trim().toLowerCase());
    const rows = items.map((item, index) => ({
      id: ulid(), share_id: item.id, source_tenant_id: item.source_tenant_id, resource_type: item.resource_type,
      resource_id: item.resource_id, revision: item.revision, rank: index + 1, tokens: itemTokens(item)
    }));
    // One statement for the whole delivery; the company comes from the viewer's tenant, which is the share's company.
    await env.OPEN_BRAIN_DB.prepare(`
      INSERT INTO team_knowledge_deliveries(id,share_id,company_id,source_tenant_id,resource_type,resource_id,revision,
        viewer_tenant_id,viewer_principal,access_path,rank,injected_token_estimate,query_hash,created_at)
      SELECT json_extract(i.value,'$.id'),json_extract(i.value,'$.share_id'),t.company_id,json_extract(i.value,'$.source_tenant_id'),
        json_extract(i.value,'$.resource_type'),json_extract(i.value,'$.resource_id'),json_extract(i.value,'$.revision'),
        t.tenant_id,?,?,json_extract(i.value,'$.rank'),json_extract(i.value,'$.tokens'),?,?
      FROM json_each(?) i JOIN team_knowledge_tenants t ON t.tenant_id = ?
    `).bind(actor.principal, accessPath, queryHash, Date.now(), JSON.stringify(rows), actor.tenantId).run();
  } catch {
    // Delivery telemetry is best effort and must never fail or change a search.
  }
}

async function recordDeliveries(env: Env, actor: TeamActor, query: string, items: SharedSearchItem[], options?: SharedDeliveryOptions) {
  if (!options || !items.length) return;
  const pending = writeDeliveries(env, actor, query, options.accessPath, items);
  if (options.waitUntil) {
    try {
      options.waitUntil(pending);
      return;
    } catch {
      // No execution context (for example in tests); fall back to awaiting the bounded write.
    }
  }
  await pending;
}

export async function searchSharedKnowledge(env: Env, actor: TeamActor, query: string, limit = 20, options?: SharedDeliveryOptions) {
  const items = (await querySharedKnowledge(env, actor, query, limit)).map(toSearchItem);
  await recordDeliveries(env, actor, query, items, options);
  return items;
}

function fitToBudget(rows: SharedSearchRow[], budgetTokens: number) {
  const kept = [...rows];
  while (kept.length > 1 && kept.reduce((sum, row) => sum + itemTokens(row), 0) > budgetTokens) kept.pop();
  const last = kept[0];
  if (last && kept.length === 1 && itemTokens(last) > budgetTokens) {
    const shortened = shortenExcerpt(last, budgetTokens);
    return { items: shortened ? [shortened] : [], truncated: true };
  }
  return { items: kept.map(toSearchItem), truncated: kept.length < rows.length };
}

function sharedBudget(value: unknown) {
  // The REST body is not validated upstream, so it is held to the range the MCP tool enforces.
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(Math.min(16_000, Math.max(512, value)) * SEARCH_AUGMENT_BUDGET_SHARE)
    : SEARCH_AUGMENT_DEFAULT_TOKENS;
}

export async function sharedKnowledgeForSearch(env: Env, actor: TeamActor, request: Record<string, unknown>, options?: SharedDeliveryOptions) {
  if (!teamKnowledgeEnabled(env) || !actor.principal || request.strict_project || request.project_id || request.scope === "mine" ||
      request.include_history || request.include_suppressed || request.at || request.task_context || request.generation_id || request.ranking_profile_id ||
      request.business_category_id || request.work_type || request.entity_id || request.decision_type ||
      request.decision_status || request.confirmation_state || request.reason_text || typeof request.q !== "string") return {};
  const limit = typeof request.limit === "number" && Number.isFinite(request.limit)
    ? Math.min(SEARCH_AUGMENT_LIMIT, Math.floor(request.limit))
    : SEARCH_AUGMENT_LIMIT;
  if (limit <= 0) return { shared_knowledge: [] };
  const { items, truncated } = fitToBudget(await querySharedKnowledge(env, actor, request.q, limit), sharedBudget(request.token_budget));
  await recordDeliveries(env, actor, request.q, items, options);
  return truncated ? { shared_knowledge: items, shared_knowledge_truncated: true } : { shared_knowledge: items };
}

export async function getSharedKnowledge(env: Env, actor: TeamActor, id: string) {
  if (!teamKnowledgeEnabled(env) || actor.projectId) throw missing();
  const row = await env.OPEN_BRAIN_DB.prepare(`${VISIBLE_SHARES} AND s.id = ?`)
    .bind(...visibleBindings(actor), id).first<SharedResult>();
  if (!row) throw missing();
  return row;
}

export async function recentTeamShares(env: Env, actor: TeamActor) {
  if (!teamKnowledgeEnabled(env) || actor.projectId) return [];
  const { results } = await env.OPEN_BRAIN_DB.prepare(`
    SELECT id,kind,title,source_tenant_id,updated_at FROM (${VISIBLE_SHARES})
    ORDER BY updated_at DESC,id LIMIT 15
  `).bind(...visibleBindings(actor)).all();
  return results;
}

export async function previewTeamShare(env: Env, actor: TeamActor, input: ShareInput) {
  const member = await requireMember(env, actor, input.targets.length ? 2 : 1);
  const source = await sourceForShare(env, actor, input);
  if (source.scope !== "private" || !source.legacy_private) {
    throw new HttpError(409, "private_policy_required", "Set the existing sharing scope to private before selecting a role audience");
  }
  const targets = [...new Set(input.targets)].sort();
  if (!Number.isInteger(input.minimumRank) || input.minimumRank < 1 || input.minimumRank > 3 ||
      (input.expiresAt != null && input.expiresAt <= Date.now())) {
    throw new HttpError(400, "invalid_audience", "A valid role and future expiration are required");
  }
  const matches = await env.OPEN_BRAIN_DB.prepare(`
    SELECT tenant_id FROM team_knowledge_tenants WHERE company_id = ? AND tenant_id != ?
      AND tenant_id IN (SELECT value FROM json_each(?))
  `).bind(member.company_id, actor.tenantId, JSON.stringify(targets)).all<{ tenant_id: string }>();
  if (matches.results.length !== targets.length) throw new HttpError(400, "invalid_audience", "Select other tenants in your company");
  const current = await env.OPEN_BRAIN_DB.prepare(`
    SELECT id,minimum_rank,target_tenants,expires_at FROM team_knowledge_shares
    WHERE source_tenant_id = ? AND resource_type = ? AND resource_id = ? AND kind = 'role'
  `).bind(actor.tenantId, input.type, input.id).first<{ id: string; minimum_rank: number; target_tenants: string; expires_at: number | null }>();
  return { source, member, targets, current };
}

export async function setTeamShare(env: Env, actor: TeamActor, input: ShareInput) {
  const { source, member, targets, current } = await previewTeamShare(env, actor, input);
  if (input.expectedShareId !== undefined && input.expectedShareId !== (current?.id ?? null)) {
    throw new HttpError(409, "share_conflict", "Review the current audience again");
  }
  const id = ulid();
  const write = await env.OPEN_BRAIN_DB.prepare(`
    INSERT INTO team_knowledge_shares(id,company_id,source_tenant_id,resource_type,resource_id,kind,
      policy_id,policy_version,minimum_rank,target_tenants,expires_at,updated_at)
    SELECT ?,?,?,?,?, 'role', p.id,p.policy_version,?,?,?,? FROM resource_access_policies p
    JOIN team_knowledge_sources d ON d.tenant_id = p.tenant_id AND d.resource_type = p.resource_type AND d.resource_id = p.resource_id
    WHERE p.id = ? AND p.policy_version = ? AND p.scope = 'private' AND ${PRIVATE_ORIGIN}
    ON CONFLICT(source_tenant_id,resource_type,resource_id,kind) DO UPDATE SET
      id = excluded.id,company_id = excluded.company_id,policy_id = excluded.policy_id,
      policy_version = excluded.policy_version,minimum_rank = excluded.minimum_rank,
      target_tenants = excluded.target_tenants,expires_at = excluded.expires_at,updated_at = excluded.updated_at
    WHERE team_knowledge_shares.id = ?
  `).bind(id, member.company_id, actor.tenantId, input.type, input.id, input.minimumRank, JSON.stringify(targets),
    input.expiresAt ?? null, Date.now(), source.policy_id, source.policy_version, current?.id ?? null).run();
  if (write.meta.changes !== 1) throw new HttpError(409, "share_conflict", "Review the current audience again");
  return { id };
}

export async function requestSharedPublication(env: Env, actor: TeamActor, input: ShareSource) {
  const member = await requireMember(env, actor, 2);
  const source = await sourceForShare(env, actor, input);
  const id = ulid();
  await env.OPEN_BRAIN_DB.prepare(`
    INSERT INTO team_knowledge_publications(id,company_id,source_tenant_id,resource_type,resource_id,policy_id,
      policy_version,source_revision,title,content,requested_by,requested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, member.company_id, actor.tenantId, input.type, input.id, source.policy_id, source.policy_version,
    source.revision, source.title, source.content, actor.principal, Date.now()).run();
  return { id };
}

export async function pendingSharedPublications(env: Env, actor: TeamActor) {
  const member = await requireMember(env, actor, 4);
  const now = Date.now();
  return (await env.OPEN_BRAIN_DB.prepare(`
    SELECT v.id,v.source_tenant_id,v.resource_type,v.title,v.content,v.source_revision,v.requested_at
    FROM team_knowledge_publications v
    JOIN team_knowledge_tenants t ON t.tenant_id = v.source_tenant_id AND t.company_id = v.company_id
    JOIN resource_access_policies p ON p.id = v.policy_id AND p.policy_version = v.policy_version
    JOIN team_knowledge_sources d ON d.tenant_id = v.source_tenant_id AND d.resource_type = v.resource_type AND d.resource_id = v.resource_id
    WHERE v.company_id = ? AND v.approved_at IS NULL AND ${ACTIVE_SOURCE}
    ORDER BY v.requested_at DESC,v.id DESC LIMIT 30
  `).bind(member.company_id, now, now).all()).results;
}

export async function publishSharedVersion(env: Env, actor: TeamActor, proposalId: string) {
  const member = await requireMember(env, actor, 4);
  const now = Date.now();
  const db = env.OPEN_BRAIN_DB;
  const key = ulid();
  const writes = await db.batch([
    db.prepare(`
      UPDATE team_knowledge_publications AS v SET approved_by = ?, approved_at = ?
      WHERE v.id = ? AND v.company_id = ? AND v.approved_at IS NULL
        AND EXISTS (
          SELECT 1 FROM resource_access_policies p
          JOIN team_knowledge_tenants t ON t.tenant_id = p.tenant_id
          JOIN team_knowledge_sources d ON d.tenant_id = p.tenant_id AND d.resource_type = p.resource_type AND d.resource_id = p.resource_id
          WHERE p.id = v.policy_id AND p.policy_version = v.policy_version AND t.company_id = v.company_id
            AND d.revision = v.source_revision AND d.content = v.content AND d.title = v.title AND ${ACTIVE_SOURCE}
        )
        AND NOT EXISTS (
          SELECT 1 FROM team_knowledge_shares s
          JOIN team_knowledge_publications old ON old.id = s.publication_id
          WHERE s.source_tenant_id = v.source_tenant_id AND s.resource_type = v.resource_type AND s.resource_id = v.resource_id
            AND (old.requested_at > v.requested_at OR (old.requested_at = v.requested_at AND old.id >= v.id)
              OR (old.policy_version = v.policy_version AND old.source_revision = v.source_revision AND old.content = v.content AND old.title = v.title))
        )
    `).bind(actor.principal, now, proposalId, member.company_id, now, now),
    db.prepare(`
      INSERT INTO team_knowledge_shares(id,company_id,source_tenant_id,resource_type,resource_id,kind,policy_id,
        policy_version,minimum_rank,publication_id,updated_at)
      SELECT ?,company_id,source_tenant_id,resource_type,resource_id,'all',policy_id,policy_version,1,id,?
        FROM team_knowledge_publications WHERE id = ? AND company_id = ? AND changes() = 1
      ON CONFLICT(source_tenant_id,resource_type,resource_id,kind) DO UPDATE SET company_id = excluded.company_id,
        policy_id = excluded.policy_id,policy_version = excluded.policy_version,
        publication_id = excluded.publication_id,updated_at = excluded.updated_at
    `).bind(key, now, proposalId, member.company_id)
  ]);
  if (writes[0]?.meta.changes !== 1 || writes[1]?.meta.changes !== 1) {
    throw new HttpError(409, "publication_conflict", "The proposal was superseded or its source changed");
  }
  return db.prepare("SELECT id FROM team_knowledge_shares WHERE company_id = ? AND publication_id = ?")
    .bind(member.company_id, proposalId).first<{ id: string }>().then(row => {
      if (!row) throw new HttpError(409, "publication_conflict", "The publication changed");
      return row;
    });
}

export async function revokeSharedKnowledge(env: Env, actor: TeamActor, shareId: string, kind: "all" | "role" = "role") {
  const member = await requireMember(env, actor);
  const row = await env.OPEN_BRAIN_DB.prepare(`
    SELECT s.*,p.owner_principal FROM team_knowledge_shares s
    JOIN resource_access_policies p ON p.id = s.policy_id
    WHERE s.id = ? AND s.company_id = ? AND s.kind = ?
  `).bind(shareId, member.company_id, kind).first<{
    kind: "all" | "role"; source_tenant_id: string; owner_principal: string; updated_at: number; publication_id: string | null;
  }>();
  if (!row || (row.kind === "all" ? member.rank !== 4 :
    row.source_tenant_id !== actor.tenantId || (!actor.isTenantAdmin && row.owner_principal !== actor.principal))) throw missing();
  const result = await env.OPEN_BRAIN_DB.prepare("DELETE FROM team_knowledge_shares WHERE id = ? AND company_id = ? AND updated_at = ? AND publication_id IS ?")
    .bind(shareId, member.company_id, row.updated_at, row.publication_id).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "share_conflict", "Review the current audience again");
  return { revoked: true };
}

export async function teamKnowledgeSharingState(env: Env, actor: TeamActor, input: ShareSource) {
  const member = await requireMember(env, actor);
  const source = await sourceForShare(env, actor, input);
  const { results } = await env.OPEN_BRAIN_DB.prepare(`
    SELECT id,kind,minimum_rank,target_tenants,expires_at,publication_id
    FROM team_knowledge_shares WHERE company_id = ? AND policy_id = ? AND policy_version = ?
  `).bind(member.company_id, source.policy_id, source.policy_version).all<{
    id: string; kind: string; minimum_rank: number; target_tenants: string; expires_at: number | null; publication_id: string | null;
  }>();
  return { rank: member.rank, scope: source.scope, items: results.map(row => ({ ...row, target_tenants: JSON.parse(row.target_tenants) })) };
}

async function readableWatch(env: Env, actor: TeamActor, ref: string) {
  if (!ref.startsWith("local:")) {
    const item = await getSharedKnowledge(env, actor, ref);
    if (item.resource_type !== "memory") throw missing();
    return { title: item.title, sourceTenantId: item.source_tenant_id, resourceId: item.resource_id, eventKind: item.kind === "all" ? "published" : "edited" };
  }
  const id = ref.slice("local:".length);
  const now = Date.now();
  const row = await env.OPEN_BRAIN_DB.prepare(`
    SELECT COALESCE(NULLIF(m.summary,''),substr(m.content,1,160)) AS title
    FROM memories m JOIN team_knowledge_sources d ON d.tenant_id = m.tenant_id AND d.resource_type = 'memory' AND d.resource_id = m.id
    WHERE m.tenant_id = ? AND m.id = ? AND ${ACTIVE_SOURCE}
      AND ${memoryReadAccessSql("m", { principal: actor.principal, isAdmin: actor.isTenantAdmin })}
  `).bind(actor.tenantId, id, now, now).first<{ title: string }>();
  if (!row) throw missing();
  return { title: row.title, sourceTenantId: actor.tenantId, resourceId: id, eventKind: "edited" };
}

export async function watchSharedKnowledge(env: Env, actor: TeamActor, ref: string, active: boolean) {
  await requireMember(env, actor);
  const db = env.OPEN_BRAIN_DB;
  if (!active) {
    await db.prepare("DELETE FROM team_knowledge_watches WHERE tenant_id = ? AND principal = ? AND ref = ?")
      .bind(actor.tenantId, actor.principal, ref).run();
    return { watching: false };
  }
  const source = await readableWatch(env, actor, ref);
  await db.prepare(`
    INSERT OR IGNORE INTO team_knowledge_watches(tenant_id,principal,ref,source_tenant_id,resource_id,event_kind,after_event)
    VALUES(?,?,?,?,?,?,COALESCE((SELECT MAX(id) FROM team_knowledge_events),0))
  `).bind(actor.tenantId, actor.principal, ref, source.sourceTenantId, source.resourceId, source.eventKind).run();
  return { watching: true };
}

export async function teamKnowledgeWatchStatus(env: Env, actor: TeamActor, ref: string) {
  await requireMember(env, actor);
  await readableWatch(env, actor, ref);
  const row = await env.OPEN_BRAIN_DB.prepare("SELECT 1 FROM team_knowledge_watches WHERE tenant_id = ? AND principal = ? AND ref = ?")
    .bind(actor.tenantId, actor.principal, ref).first();
  return { watching: Boolean(row) };
}

export async function teamKnowledgeInbox(env: Env, actor: TeamActor) {
  if (!await membership(env, actor)) return [];
  const now = Date.now();
  const events = await env.OPEN_BRAIN_DB.prepare(`
    WITH readable_share AS (${VISIBLE_SHARES}),
    my_watches AS (SELECT * FROM team_knowledge_watches WHERE tenant_id = ? AND principal = ?),
    readable_watches AS (
      SELECT w.*, s.title FROM my_watches w JOIN readable_share s ON s.id = w.ref AND s.resource_type = 'memory'
      UNION ALL
      SELECT w.*, d.title FROM my_watches w
      JOIN memories m ON m.tenant_id = w.tenant_id AND m.id = w.resource_id AND w.ref = 'local:' || m.id
      JOIN team_knowledge_sources d ON d.tenant_id = m.tenant_id AND d.resource_type = 'memory' AND d.resource_id = m.id
      WHERE ${ACTIVE_SOURCE} AND ${memoryReadAccessSql("m", { principal: actor.principal, isAdmin: actor.isTenantAdmin })}
    ), accessible_events AS (
      SELECT e.id,e.kind,e.version,e.created_at,w.ref AS share_id,w.title,
        EXISTS(SELECT 1 FROM team_knowledge_receipts r WHERE r.tenant_id = w.tenant_id AND r.principal = w.principal AND r.event_id = e.id) AS is_read,
        row_number() OVER(PARTITION BY e.id ORDER BY (w.ref LIKE 'local:%') DESC,w.ref) AS occurrence
      FROM readable_watches w
      JOIN team_knowledge_events e ON e.source_tenant_id = w.source_tenant_id AND e.resource_id = w.resource_id
        AND e.kind = w.event_kind AND e.id > w.after_event
    )
    SELECT id,kind,version,created_at,share_id,title,is_read FROM accessible_events WHERE occurrence = 1
    ORDER BY id DESC LIMIT 100
  `).bind(...visibleBindings(actor), actor.tenantId, actor.principal, now, now)
    .all<{ id: number; kind: string; version: string; created_at: number; share_id: string; title: string; is_read: number }>();
  return events.results.map(event => ({ ...event, is_read: Boolean(event.is_read) }));
}

export async function acknowledgeTeamKnowledgeEvent(env: Env, actor: TeamActor, eventId: number) {
  if (!(await teamKnowledgeInbox(env, actor)).some(event => event.id === eventId)) throw missing();
  await env.OPEN_BRAIN_DB.prepare("INSERT OR IGNORE INTO team_knowledge_receipts(tenant_id,principal,event_id) VALUES(?,?,?)")
    .bind(actor.tenantId, actor.principal, eventId).run();
  return { acknowledged: true };
}

export async function teamKnowledgeEventVersions(env: Env, actor: TeamActor, eventId: number) {
  const event = (await teamKnowledgeInbox(env, actor)).find(item => item.id === eventId);
  if (!event) throw missing();
  const db = env.OPEN_BRAIN_DB;
  if (event.share_id.startsWith("local:")) {
    const id = event.share_id.slice(6);
    const versions = await db.prepare(`
      SELECT v.version AS revision,v.summary AS title,v.content
      FROM memory_versions v JOIN memories m ON m.tenant_id = v.tenant_id AND m.id = v.memory_id
      WHERE v.tenant_id = ? AND v.memory_id = ? AND m.owner_principal = ?
        AND v.version <= ? AND m.deleted_at IS NULL AND m.lifecycle_state = 'active'
      ORDER BY v.version DESC LIMIT 2
    `).bind(actor.tenantId, id, actor.principal, Number(event.version)).all();
    return { event, versions: versions.results.length === 2 ? versions.results : [] };
  }
  const share = await getSharedKnowledge(env, actor, event.share_id);
  if (share.kind !== "all") return { event, versions: [] };
  const versions = await db.prepare(`
    WITH readable AS (${VISIBLE_SHARES})
    SELECT v.source_revision AS revision,v.title,v.content
    FROM readable r
    JOIN team_knowledge_shares s ON s.id = r.id
    JOIN team_knowledge_publications selected ON selected.id = ?
    JOIN team_knowledge_publications v ON v.source_tenant_id = r.source_tenant_id
      AND v.resource_type = r.resource_type AND v.resource_id = r.resource_id
      AND v.company_id = s.company_id AND v.policy_id = s.policy_id AND v.policy_version = s.policy_version
    WHERE r.id = ? AND r.kind = 'all' AND v.approved_at IS NOT NULL
      AND (v.requested_at < selected.requested_at OR (v.requested_at = selected.requested_at AND v.id <= selected.id))
    ORDER BY v.requested_at DESC,v.id DESC LIMIT 2
  `).bind(...visibleBindings(actor), event.version, event.share_id).all();
  return { event, versions: versions.results.length === 2 ? versions.results : [] };
}
