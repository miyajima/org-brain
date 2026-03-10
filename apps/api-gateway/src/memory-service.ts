import { HttpError, ulid } from "@org-brain/shared";
import type { Env } from "./types";

type UpsertMemoryItem = {
  external_key: string;
  content: string;
  summary?: string;
  tags?: string[];
  created_at?: number;
  project_id?: string | null;
};

type UpsertMemoryRequest = {
  tenant_id?: string;
  source?: string;
  items: UpsertMemoryItem[];
};

type MemoryRow = {
  id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: string;
  external_key: string | null;
  created_at: number;
};

function parseString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  }
  return trimmed;
}

function parseTags(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "tags must be an array of strings");
  }
  const tags = raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .slice(0, 16);
  return [...new Set(tags)];
}

function parseUpsertRequest(raw: unknown): { tenantId: string; source: string; items: UpsertMemoryItem[] } {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = raw as UpsertMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const source = body.source ? parseString(body.source, "source").slice(0, 64) : "openclaw";
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new HttpError(400, "invalid_payload", "items must be a non-empty array");
  }
  if (body.items.length > 200) {
    throw new HttpError(400, "invalid_payload", "items must be <= 200");
  }

  const items = body.items.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new HttpError(400, "invalid_payload", `items[${i}] must be an object`);
    }
    const key = parseString((item as UpsertMemoryItem).external_key, `items[${i}].external_key`).slice(0, 256);
    const content = parseString((item as UpsertMemoryItem).content, `items[${i}].content`);
    const summaryRaw = (item as UpsertMemoryItem).summary;
    const summary = typeof summaryRaw === "string" ? summaryRaw.trim().slice(0, 1000) : undefined;
    const createdAtRaw = (item as UpsertMemoryItem).created_at;
    const createdAt =
      typeof createdAtRaw === "number" && Number.isFinite(createdAtRaw) ? Math.floor(createdAtRaw) : undefined;
    const projectRaw = (item as UpsertMemoryItem).project_id;
    const projectId = typeof projectRaw === "string" ? projectRaw.trim().slice(0, 128) : null;
    const tags = parseTags((item as UpsertMemoryItem).tags);
    return {
      external_key: key,
      content: content.slice(0, 20_000),
      summary,
      created_at: createdAt,
      project_id: projectId,
      tags
    };
  });

  return { tenantId, source, items };
}

function parseTagsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export async function upsertMemories(env: Env, rawBody: unknown) {
  const { tenantId, source, items } = parseUpsertRequest(rawBody);
  let inserted = 0;
  let updated = 0;

  // Keep the last item for each external key inside one request.
  const dedupedByKey = new Map<string, UpsertMemoryItem>();
  for (const item of items) dedupedByKey.set(item.external_key, item);

  for (const item of dedupedByKey.values()) {
    const now = Date.now();
    const createdAt = item.created_at ?? now;
    const tagsJson = JSON.stringify(item.tags ?? []);

    const existing = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id FROM memories WHERE tenant_id = ? AND external_key = ?"
    )
      .bind(tenantId, item.external_key)
      .first<{ id: string }>();

    if (existing) {
      await env.OPEN_BRAIN_DB.batch([
        env.OPEN_BRAIN_DB.prepare(
          "UPDATE memories SET project_id = ?, content = ?, summary = ?, tags_json = ?, source = ?, created_at = ? WHERE tenant_id = ? AND id = ?"
        ).bind(
          item.project_id ?? null,
          item.content,
          item.summary ?? null,
          tagsJson,
          source,
          createdAt,
          tenantId,
          existing.id
        ),
        env.OPEN_BRAIN_DB.prepare("DELETE FROM memories_fts WHERE memory_id = ? AND tenant_id = ?").bind(
          existing.id,
          tenantId
        ),
        env.OPEN_BRAIN_DB.prepare("INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)").bind(
          existing.id,
          tenantId,
          item.content
        )
      ]);
      updated += 1;
      continue;
    }

    const id = ulid();
    await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO memories(id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at) VALUES(?,?,?,?,?,?,?,?,?)"
      ).bind(
        id,
        tenantId,
        item.project_id ?? null,
        item.content,
        item.summary ?? null,
        tagsJson,
        source,
        item.external_key,
        createdAt
      ),
      env.OPEN_BRAIN_DB.prepare("INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)").bind(
        id,
        tenantId,
        item.content
      )
    ]);
    inserted += 1;
  }

  return {
    tenant_id: tenantId,
    source,
    inserted,
    updated
  };
}

export async function listMemories(env: Env, tenantId: string, limit = 100, source?: string) {
  const safeLimit = Math.max(1, Math.min(500, limit));
  const hasSource = typeof source === "string" && source.trim().length > 0;
  const sql = hasSource
    ? `SELECT id, project_id, content, summary, tags_json, source, external_key, created_at
       FROM memories
       WHERE tenant_id = ? AND source = ?
       ORDER BY created_at DESC
       LIMIT ?`
    : `SELECT id, project_id, content, summary, tags_json, source, external_key, created_at
       FROM memories
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`;

  const stmt = env.OPEN_BRAIN_DB.prepare(sql);
  const result = hasSource
    ? await stmt.bind(tenantId, source?.trim(), safeLimit).all<MemoryRow>()
    : await stmt.bind(tenantId, safeLimit).all<MemoryRow>();

  return result.results.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    content: row.content,
    summary: row.summary,
    tags: parseTagsJson(row.tags_json),
    source: row.source,
    external_key: row.external_key,
    created_at: row.created_at
  }));
}
