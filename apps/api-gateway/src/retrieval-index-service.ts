import {
  buildRetrievalUnits,
  type MemorySourceReference,
  type RetrievalIndex,
  type RetrievalIndexDocument,
  type RetrievalIndexHit,
  type RetrievalIndexQuery
} from "@org-brain/shared";
import type { Env } from "./types";
import { extractRetrievalUnitsV4 } from "./retrieval-v4-extraction-service";

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5" as const;
export const EMBEDDING_MODEL_V3 = "@cf/qwen/qwen3-embedding-0.6b" as const;
export const RERANKER_MODEL_V3 = "@cf/baai/bge-reranker-base" as const;
const BATCH_SIZE = 16;
const DELETE_BATCH_SIZE = 100;
const UPSERT_CONCURRENCY = 3;

function extractEmbeddings(output: unknown): number[][] {
  if (!output || typeof output !== "object") {
    throw new Error("embedding provider returned an invalid response");
  }
  const data = (output as { data?: unknown }).data;
  if (
    !Array.isArray(data) ||
    data.length === 0 ||
    data.some(
      (vector) =>
        !Array.isArray(vector) ||
        vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
    )
  ) {
    throw new Error("embedding provider returned no numeric vector");
  }
  return data as number[][];
}

export class CloudflareVectorRetrievalIndex implements RetrievalIndex {
  readonly kind = "semantic" as const;
  readonly provider: string = `cloudflare-workers-ai:${EMBEDDING_MODEL}+vectorize`;

  constructor(
    protected readonly ai: Ai,
    private readonly index: Vectorize,
    private readonly namespaceSuffix = ""
  ) {}

  protected namespace(tenantId: string): string {
    return `${tenantId}${this.namespaceSuffix}`;
  }

  async available(): Promise<boolean> {
    try {
      await this.index.describe();
      return true;
    } catch {
      return false;
    }
  }

  protected async embed(text: string): Promise<number[]> {
    return (await this.embedMany([text]))[0];
  }

  protected async embedMany(texts: string[]): Promise<number[][]> {
    const output = await this.ai.run(EMBEDDING_MODEL, {
      text: texts.map((text) => text.slice(0, 20_000)),
      pooling: "cls"
    });
    return extractEmbeddings(output);
  }

  async upsert(documents: RetrievalIndexDocument[]): Promise<void> {
    const batches: RetrievalIndexDocument[][] = [];
    for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
      batches.push(documents.slice(offset, offset + BATCH_SIZE));
    }
    let nextBatch = 0;
    const worker = async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++];
        const values = await this.embedMany(batch.map((document) => document.text));
        const vectors = batch.map((document, index) => ({
          id: document.id,
          namespace: this.namespace(document.tenant_id),
          values: values[index],
          metadata: {
            tenant_id: document.tenant_id,
            project_id: document.project_id ?? "",
            memory_id: document.memory_id ?? document.id,
            unit_type: document.unit_type ?? "memory",
            speaker: document.speaker ?? "",
            updated_at: document.updated_at
          }
        }));
        await this.index.upsert(vectors);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(UPSERT_CONCURRENCY, batches.length) }, () => worker())
    );
  }

  async remove(_tenantId: string, ids: string[]): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += DELETE_BATCH_SIZE) {
      await this.index.deleteByIds(ids.slice(offset, offset + DELETE_BATCH_SIZE));
    }
  }

  async query(input: RetrievalIndexQuery): Promise<RetrievalIndexHit[]> {
    const vector = await this.embed(input.query);
    const result = await this.index.query(vector, {
      topK: input.limit,
      namespace: this.namespace(input.tenant_id),
      returnMetadata: "indexed",
      filter: input.project_id ? { project_id: { $eq: input.project_id } } : undefined
    });
    return result.matches.map((match) => ({
      id: match.id,
      score: Math.max(0, Math.min(1, match.score))
    }));
  }

  async rebuild(documents: AsyncIterable<RetrievalIndexDocument>): Promise<void> {
    let batch: RetrievalIndexDocument[] = [];
    for await (const document of documents) {
      batch.push(document);
      if (batch.length >= BATCH_SIZE) {
        await this.upsert(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await this.upsert(batch);
  }
}

export function getSemanticRetrievalIndex(env: Env): RetrievalIndex | null {
  if (!env.AI || !env.MEMORY_VECTOR_INDEX) return null;
  return new CloudflareVectorRetrievalIndex(env.AI, env.MEMORY_VECTOR_INDEX);
}

export function getV3SemanticRetrievalIndex(env: Env): RetrievalIndex | null {
  if (!env.AI || !env.MEMORY_VECTOR_INDEX_V3) return null;
  return new CloudflareVectorRetrievalIndexV3(env.AI, env.MEMORY_VECTOR_INDEX_V3);
}

export function getV4SemanticRetrievalIndex(env: Env): RetrievalIndex | null {
  if (!env.AI || !env.MEMORY_VECTOR_INDEX_V3) return null;
  return new CloudflareVectorRetrievalIndexV3(
    env.AI,
    env.MEMORY_VECTOR_INDEX_V3,
    ":hybrid_v4"
  );
}

function generationNamespace(generationId: string) {
  return `:generation:${generationId.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 96)}`;
}

export function getGenerationSemanticRetrievalIndex(env: Env, generationId: string): RetrievalIndex | null {
  if (!env.AI || !env.MEMORY_VECTOR_INDEX_V3) return null;
  return new CloudflareVectorRetrievalIndexV3(
    env.AI,
    env.MEMORY_VECTOR_INDEX_V3,
    generationNamespace(generationId)
  );
}

export async function syncRetrievalGenerationUnitsToSemanticIndex(
  env: Env,
  tenantId: string,
  generationId: string,
  unitIds: string[]
): Promise<RetrievalProjectionStatus> {
  const index = getGenerationSemanticRetrievalIndex(env, generationId);
  if (!index) return { available: false, provider: null, indexed: 0 };
  try {
    const uniqueIds = [...new Set(unitIds)].slice(0, 5_000);
    if (uniqueIds.length === 0) return { available: true, provider: index.provider, indexed: 0 };
    const documents: RetrievalIndexDocument[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      const chunk = uniqueIds.slice(offset, offset + 100);
      const rows = (await env.OPEN_BRAIN_DB.prepare(
        `SELECT id, source_id, tenant_id, project_id, unit_type, text, created_at
         FROM retrieval_units
         WHERE generation_id = ? AND tenant_id = ? AND id IN (${chunk.map(() => "?").join(",")})`
      ).bind(generationId, tenantId, ...chunk).all<{
        id: string;
        source_id: string;
        tenant_id: string;
        project_id: string | null;
        unit_type: string;
        text: string;
        created_at: number;
      }>()).results;
      documents.push(...rows.map((row) => ({
        id: row.id,
        memory_id: row.source_id,
        tenant_id: row.tenant_id,
        project_id: row.project_id,
        unit_type: row.unit_type,
        speaker: null,
        text: row.text,
        entities: [],
        updated_at: row.created_at
      })));
    }
    await index.upsert(documents);
    return { available: true, provider: index.provider, indexed: documents.length };
  } catch (error) {
    return {
      available: true,
      provider: index.provider,
      indexed: 0,
      error: error instanceof Error ? error.message : "generation semantic index update failed"
    };
  }
}

export async function searchRetrievalGenerationSemanticIndex(
  env: Env,
  generationId: string,
  input: RetrievalIndexQuery
): Promise<{ hits: RetrievalIndexHit[]; provider: string } | null> {
  const index = getGenerationSemanticRetrievalIndex(env, generationId);
  if (!index || !(await index.available())) return null;
  return { hits: await index.query({ ...input, limit: Math.min(50, input.limit) }), provider: index.provider };
}

class CloudflareVectorRetrievalIndexV3 extends CloudflareVectorRetrievalIndex {
  readonly provider = `cloudflare-workers-ai:${EMBEDDING_MODEL_V3}+vectorize`;

  constructor(
    private readonly v3Ai: Ai,
    index: Vectorize,
    namespaceSuffix = ""
  ) {
    super(v3Ai, index, namespaceSuffix);
  }

  protected override async embed(text: string): Promise<number[]> {
    return (await this.embedMany([text]))[0];
  }

  protected override async embedMany(texts: string[]): Promise<number[][]> {
    const output = await this.v3Ai.run(EMBEDDING_MODEL_V3, {
      text: texts.map((text) => text.slice(0, 4_000))
    });
    return extractEmbeddings(output);
  }
}

export type RetrievalProjectionStatus = {
  available: boolean;
  provider: string | null;
  indexed: number;
  error?: string;
};

function parseEntities(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function syncMemoryIdsToSemanticIndex(
  env: Env,
  tenantId: string,
  ids: string[]
): Promise<RetrievalProjectionStatus> {
  const index = getSemanticRetrievalIndex(env);
  if (!index) return { available: false, provider: null, indexed: 0 };
  try {
    const uniqueIds = [...new Set(ids)].slice(0, 200);
    if (uniqueIds.length === 0) return { available: true, provider: index.provider, indexed: 0 };
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, tenant_id, project_id, content, summary, entities_json, updated_at, created_at
       FROM memories
       WHERE tenant_id = ? AND id IN (${placeholders})
         AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')`
    )
      .bind(tenantId, ...uniqueIds)
      .all<{
        id: string;
        tenant_id: string;
        project_id: string | null;
        content: string;
        summary: string | null;
        entities_json: string | null;
        updated_at: number | null;
        created_at: number;
      }>();
    const documents = rows.results.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      project_id: row.project_id,
      text: `${row.summary ?? ""}\n${row.content}`.trim(),
      entities: parseEntities(row.entities_json),
      updated_at: row.updated_at ?? row.created_at
    }));
    await index.upsert(documents);
    return { available: true, provider: index.provider, indexed: documents.length };
  } catch (error) {
    return {
      available: true,
      provider: index.provider,
      indexed: 0,
      error: error instanceof Error ? error.message : "semantic index update failed"
    };
  }
}

export async function removeMemoryIdsFromSemanticIndex(
  env: Env,
  tenantId: string,
  ids: string[]
): Promise<RetrievalProjectionStatus> {
  const index = getSemanticRetrievalIndex(env);
  if (!index) return { available: false, provider: null, indexed: 0 };
  try {
    await index.remove(tenantId, ids);
    return { available: true, provider: index.provider, indexed: 0 };
  } catch (error) {
    return {
      available: true,
      provider: index.provider,
      indexed: 0,
      error: error instanceof Error ? error.message : "semantic index delete failed"
    };
  }
}

export async function rebuildSemanticIndex(
  env: Env,
  tenantId: string,
  projectId?: string | null
): Promise<RetrievalProjectionStatus> {
  const index = getSemanticRetrievalIndex(env);
  if (!index) return { available: false, provider: null, indexed: 0 };
  let indexed = 0;
  try {
    async function* documents(): AsyncIterable<RetrievalIndexDocument> {
      let cursor = "";
      while (true) {
        const rows = await env.OPEN_BRAIN_DB.prepare(
          `SELECT id, tenant_id, project_id, content, summary, entities_json, updated_at, created_at
           FROM memories
           WHERE tenant_id = ? AND id > ?
             AND (? IS NULL OR project_id = ?)
             AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
           ORDER BY id
           LIMIT 200`
        )
          .bind(tenantId, cursor, projectId ?? null, projectId ?? null)
          .all<{
            id: string;
            tenant_id: string;
            project_id: string | null;
            content: string;
            summary: string | null;
            entities_json: string | null;
            updated_at: number | null;
            created_at: number;
          }>();
        if (rows.results.length === 0) return;
        for (const row of rows.results) {
          cursor = row.id;
          indexed += 1;
          yield {
            id: row.id,
            tenant_id: row.tenant_id,
            project_id: row.project_id,
            text: `${row.summary ?? ""}\n${row.content}`.trim(),
            entities: parseEntities(row.entities_json),
            updated_at: row.updated_at ?? row.created_at
          };
        }
      }
    }
    await index.rebuild(documents());
    return { available: true, provider: index.provider, indexed };
  } catch (error) {
    return {
      available: true,
      provider: index.provider,
      indexed,
      error: error instanceof Error ? error.message : "semantic index rebuild failed"
    };
  }
}

export async function searchSemanticIndex(
  env: Env,
  input: RetrievalIndexQuery
): Promise<{ hits: RetrievalIndexHit[]; provider: string } | null> {
  const index = getSemanticRetrievalIndex(env);
  if (!index || !(await index.available())) return null;
  return { hits: await index.query(input), provider: index.provider };
}

export async function syncMemoryIdsToV3SemanticIndex(
  env: Env,
  tenantId: string,
  memoryIds: string[]
): Promise<RetrievalProjectionStatus> {
  const index = getV3SemanticRetrievalIndex(env);
  if (!index) return { available: false, provider: null, indexed: 0 };
  try {
    const uniqueIds = [...new Set(memoryIds)].slice(0, 200);
    if (uniqueIds.length === 0) return { available: true, provider: index.provider, indexed: 0 };
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, memory_id, tenant_id, project_id, unit_type, speaker, text, created_at
       FROM memory_retrieval_units
       WHERE tenant_id = ? AND memory_id IN (${placeholders})
       ORDER BY memory_id, id`
    )
      .bind(tenantId, ...uniqueIds)
      .all<{
        id: string;
        memory_id: string;
        tenant_id: string;
        project_id: string | null;
        unit_type: string;
        speaker: string | null;
        text: string;
        created_at: number;
      }>();
    const documents: RetrievalIndexDocument[] = rows.results.map((row) => ({
      id: row.id,
      memory_id: row.memory_id,
      tenant_id: row.tenant_id,
      project_id: row.project_id,
      unit_type: row.unit_type,
      speaker: row.speaker,
      text: row.text,
      entities: [],
      updated_at: row.created_at
    }));
    await index.upsert(documents);
    return { available: true, provider: index.provider, indexed: documents.length };
  } catch (error) {
    return {
      available: true,
      provider: index.provider,
      indexed: 0,
      error: error instanceof Error ? error.message : "hybrid_v3 semantic index update failed"
    };
  }
}

export async function searchV3SemanticIndex(
  env: Env,
  input: RetrievalIndexQuery
): Promise<{ hits: RetrievalIndexHit[]; provider: string } | null> {
  const index = getV3SemanticRetrievalIndex(env);
  if (!index || !(await index.available())) return null;
  return { hits: await index.query({ ...input, limit: Math.min(50, input.limit) }), provider: index.provider };
}

export async function syncMemoryIdsToV4SemanticIndex(
  env: Env,
  tenantId: string,
  memoryIds: string[]
): Promise<RetrievalProjectionStatus> {
  const index = getV4SemanticRetrievalIndex(env);
  if (!index) return { available: false, provider: null, indexed: 0 };
  try {
    const uniqueIds = [...new Set(memoryIds)].slice(0, 200);
    if (uniqueIds.length === 0) return { available: true, provider: index.provider, indexed: 0 };
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, memory_id, tenant_id, project_id, unit_type, speaker, text, created_at
       FROM memory_retrieval_units_v4
       WHERE tenant_id = ? AND memory_id IN (${placeholders})
       ORDER BY memory_id, id`
    ).bind(tenantId, ...uniqueIds).all<{
      id: string;
      memory_id: string;
      tenant_id: string;
      project_id: string | null;
      unit_type: string;
      speaker: string | null;
      text: string;
      created_at: number;
    }>();
    const documents: RetrievalIndexDocument[] = rows.results.map((row) => ({
      id: row.id,
      memory_id: row.memory_id,
      tenant_id: row.tenant_id,
      project_id: row.project_id,
      unit_type: row.unit_type,
      speaker: row.speaker,
      text: row.text,
      entities: [],
      updated_at: row.created_at
    }));
    await index.upsert(documents);
    return { available: true, provider: `${index.provider}:hybrid_v4`, indexed: documents.length };
  } catch (error) {
    return {
      available: true,
      provider: index.provider,
      indexed: 0,
      error: error instanceof Error ? error.message : "hybrid_v4 semantic index update failed"
    };
  }
}

export async function searchV4SemanticIndex(
  env: Env,
  input: RetrievalIndexQuery
): Promise<{ hits: RetrievalIndexHit[]; provider: string } | null> {
  const index = getV4SemanticRetrievalIndex(env);
  if (!index || !(await index.available())) return null;
  return {
    hits: await index.query({ ...input, limit: Math.min(50, input.limit) }),
    provider: `${index.provider}:hybrid_v4`
  };
}

export async function removeMemoryIdsFromV4SemanticIndex(
  env: Env,
  tenantId: string,
  memoryIds: string[]
): Promise<RetrievalProjectionStatus> {
  const index = getV4SemanticRetrievalIndex(env);
  if (!index) return { available: false, provider: null, indexed: 0 };
  try {
    const uniqueIds = [...new Set(memoryIds)].slice(0, 200);
    if (uniqueIds.length === 0) return { available: true, provider: index.provider, indexed: 0 };
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM memory_retrieval_units_v4
       WHERE tenant_id = ? AND memory_id IN (${placeholders})`
    ).bind(tenantId, ...uniqueIds).all<{ id: string }>();
    await index.remove(tenantId, rows.results.map((row) => row.id));
    return { available: true, provider: `${index.provider}:hybrid_v4`, indexed: 0 };
  } catch (error) {
    return {
      available: true,
      provider: index.provider,
      indexed: 0,
      error: error instanceof Error ? error.message : "hybrid_v4 semantic index delete failed"
    };
  }
}

export async function removeMemoryIdsFromV3SemanticIndex(
  env: Env,
  tenantId: string,
  memoryIds: string[]
): Promise<RetrievalProjectionStatus> {
  const index = getV3SemanticRetrievalIndex(env);
  if (!index) return { available: false, provider: null, indexed: 0 };
  try {
    const uniqueIds = [...new Set(memoryIds)].slice(0, 200);
    if (uniqueIds.length === 0) return { available: true, provider: index.provider, indexed: 0 };
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM memory_retrieval_units
       WHERE tenant_id = ? AND memory_id IN (${placeholders})`
    )
      .bind(tenantId, ...uniqueIds)
      .all<{ id: string }>();
    await index.remove(tenantId, rows.results.map((row) => row.id));
    return { available: true, provider: index.provider, indexed: 0 };
  } catch (error) {
    return {
      available: true,
      provider: index.provider,
      indexed: 0,
      error: error instanceof Error ? error.message : "hybrid_v3 semantic index delete failed"
    };
  }
}

function normalizeRerankerScore(value: number): number {
  if (value >= 0 && value <= 1) return value;
  return 1 / (1 + Math.exp(-value));
}

export async function rerankV3MemoryCandidates(
  env: Env,
  query: string,
  candidates: Array<{ id: string; text: string }>
): Promise<{ scores: Map<string, number>; provider: string } | null> {
  if (!env.AI) return null;
  if (candidates.length === 0) {
    return {
      scores: new Map<string, number>(),
      provider: `cloudflare-workers-ai:${RERANKER_MODEL_V3}`
    };
  }
  const selected = candidates.slice(0, 20);
  const output = await env.AI.run(RERANKER_MODEL_V3, {
    query,
    contexts: selected.map((candidate) => ({ text: candidate.text.slice(0, 8_000) })),
    top_k: selected.length
  });
  const response = (output as unknown as { response?: unknown }).response;
  if (!Array.isArray(response)) throw new Error("reranker returned no response array");
  const scores = new Map<string, number>();
  for (const [position, item] of response.entries()) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: number; index?: number; score?: number };
    const index = Number.isInteger(row.id) ? Number(row.id) : Number.isInteger(row.index) ? Number(row.index) : position;
    if (index < 0 || index >= selected.length || typeof row.score !== "number" || !Number.isFinite(row.score)) continue;
    scores.set(selected[index].id, normalizeRerankerScore(row.score));
  }
  if (scores.size === 0) throw new Error("reranker returned no numeric scores");
  return { scores, provider: `cloudflare-workers-ai:${RERANKER_MODEL_V3}` };
}

export async function backfillV3RetrievalUnits(
  env: Env,
  options: {
    tenantId: string;
    projectId?: string | null;
    cursor?: string | null;
    limit?: number;
  }
) {
  const limit = Math.max(1, Math.min(50, options.limit ?? 25));
  const checkpoint = options.cursor === undefined || options.cursor === null
    ? await env.OPEN_BRAIN_DB.prepare(
        `SELECT cursor, processed_memories, projected_units
         FROM retrieval_projection_backfills
         WHERE tenant_id = ? AND project_id = ?`
      ).bind(options.tenantId, options.projectId ?? "").first<{
        cursor: string;
        processed_memories: number;
        projected_units: number;
      }>()
    : null;
  const cursor = options.cursor ?? checkpoint?.cursor ?? "";
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, content, summary, source_refs_json,
            created_at, updated_at, valid_from, valid_until, content_hash
     FROM memories
     WHERE tenant_id = ? AND id > ?
       AND (? IS NULL OR project_id = ?)
       AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
     ORDER BY id
     LIMIT ?`
  )
    .bind(
      options.tenantId,
      cursor,
      options.projectId ?? null,
      options.projectId ?? null,
      limit
    )
    .all<{
      id: string;
      tenant_id: string;
      project_id: string | null;
      content: string;
      summary: string | null;
      source_refs_json: string | null;
      created_at: number;
      updated_at: number | null;
      valid_from: number | null;
      valid_until: number | null;
      content_hash: string;
    }>();
  const memoryIds = rows.results.map((row) => row.id);
  const index = getV3SemanticRetrievalIndex(env);
  if (index && memoryIds.length > 0) {
    const placeholders = memoryIds.map(() => "?").join(",");
    const previousUnits = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM memory_retrieval_units
       WHERE tenant_id = ? AND memory_id IN (${placeholders})`
    ).bind(options.tenantId, ...memoryIds).all<{ id: string }>();
    await index.remove(options.tenantId, previousUnits.results.map((unit) => unit.id));
  }
  let projectedUnits = 0;
  for (const row of rows.results) {
    let sourceReferences: MemorySourceReference[] = [];
    try {
      const parsed = JSON.parse(row.source_refs_json || "[]");
      if (Array.isArray(parsed)) sourceReferences = parsed as MemorySourceReference[];
    } catch {
      sourceReferences = [];
    }
    const units = await buildRetrievalUnits({
      id: row.id,
      tenant_id: row.tenant_id,
      project_id: row.project_id,
      content: row.content,
      summary: row.summary,
      created_at: row.created_at,
      updated_at: row.updated_at ?? row.created_at,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      source_references: sourceReferences
    });
    const statements: D1PreparedStatement[] = [
      env.OPEN_BRAIN_DB.prepare(
        "DELETE FROM memory_retrieval_units_fts WHERE tenant_id = ? AND memory_id = ?"
      ).bind(row.tenant_id, row.id),
      env.OPEN_BRAIN_DB.prepare(
        "DELETE FROM memory_retrieval_units WHERE tenant_id = ? AND memory_id = ?"
      ).bind(row.tenant_id, row.id)
    ];
    for (const unit of units) {
      statements.push(
        env.OPEN_BRAIN_DB.prepare(
          `INSERT INTO memory_retrieval_units(
            id, memory_id, tenant_id, project_id, unit_type, speaker, text,
            event_at, valid_from, valid_until, source_ref_json, source_span_start,
            source_span_end, content_hash, extractor, extractor_version,
            extraction_state, degraded_reason, created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          unit.id, unit.memory_id, unit.tenant_id, unit.project_id, unit.unit_type,
          unit.speaker, unit.text, unit.event_at, unit.valid_from, unit.valid_until,
          unit.source_ref_json, unit.source_span_start, unit.source_span_end,
          unit.content_hash, unit.extractor, unit.extractor_version,
          unit.extraction_state, unit.degraded_reason, unit.created_at
        ),
        env.OPEN_BRAIN_DB.prepare(
          "INSERT INTO memory_retrieval_units_fts(unit_id, memory_id, tenant_id, text) VALUES(?,?,?,?)"
        ).bind(unit.id, unit.memory_id, unit.tenant_id, unit.text)
      );
    }
    for (let offset = 0; offset < statements.length; offset += 50) {
      await env.OPEN_BRAIN_DB.batch(statements.slice(offset, offset + 50));
    }
    projectedUnits += units.length;
    if (
      env.RETRIEVAL_PROJECTION_QUEUE &&
      (env.HYBRID_V3_MODE === "canary" || env.HYBRID_V3_MODE === "on")
    ) {
      await env.RETRIEVAL_PROJECTION_QUEUE.send({
        version: 1,
        tenant_id: row.tenant_id,
        memory_id: row.id,
        content_hash: row.content_hash,
        requested_at: Date.now()
      }, { contentType: "json" });
    }
  }
  const vectorize = await syncMemoryIdsToV3SemanticIndex(env, options.tenantId, memoryIds);
  const nextCursor = rows.results.at(-1)?.id ?? cursor;
  const done = rows.results.length < limit;
  const totalProcessed = Number(checkpoint?.processed_memories ?? 0) + rows.results.length;
  const totalProjectedUnits = Number(checkpoint?.projected_units ?? 0) + projectedUnits;
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO retrieval_projection_backfills(
       tenant_id, project_id, cursor, processed_memories, projected_units, state, updated_at
     ) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, project_id) DO UPDATE SET
       cursor = excluded.cursor,
       processed_memories = excluded.processed_memories,
       projected_units = excluded.projected_units,
       state = excluded.state,
       updated_at = excluded.updated_at`
  ).bind(
    options.tenantId,
    options.projectId ?? "",
    nextCursor,
    totalProcessed,
    totalProjectedUnits,
    done ? "complete" : "running",
    Date.now()
  ).run();
  return {
    tenant_id: options.tenantId,
    project_id: options.projectId ?? null,
    processed_memories: rows.results.length,
    projected_units: projectedUnits,
    total_processed_memories: totalProcessed,
    total_projected_units: totalProjectedUnits,
    next_cursor: nextCursor || null,
    done,
    vectorize
  };
}

export async function backfillV4RetrievalUnits(
  env: Env,
  options: {
    tenantId: string;
    projectId?: string | null;
    cursor?: string | null;
    limit?: number;
  }
) {
  const limit = Math.max(1, Math.min(50, options.limit ?? 25));
  const checkpoint = options.cursor === undefined || options.cursor === null
    ? await env.OPEN_BRAIN_DB.prepare(
        `SELECT cursor, processed_memories, projected_units
         FROM retrieval_projection_v4_backfills
         WHERE tenant_id = ? AND project_id = ?`
      ).bind(options.tenantId, options.projectId ?? "").first<{
        cursor: string;
        processed_memories: number;
        projected_units: number;
      }>()
    : null;
  const cursor = options.cursor ?? checkpoint?.cursor ?? "";
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, content, summary, source_refs_json,
            created_at, updated_at, valid_from, valid_until, content_hash
     FROM memories
     WHERE tenant_id = ? AND id > ?
       AND (? IS NULL OR project_id = ?)
       AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
     ORDER BY id
     LIMIT ?`
  ).bind(
    options.tenantId,
    cursor,
    options.projectId ?? null,
    options.projectId ?? null,
    limit
  ).all<{
    id: string;
    tenant_id: string;
    project_id: string | null;
    content: string;
    summary: string | null;
    source_refs_json: string | null;
    created_at: number;
    updated_at: number | null;
    valid_from: number | null;
    valid_until: number | null;
    content_hash: string;
  }>();
  let projectedUnits = 0;
  const unitHashes: string[] = [];
  for (const row of rows.results) {
    let sourceReferences: MemorySourceReference[] = [];
    try {
      const parsed = JSON.parse(row.source_refs_json || "[]");
      if (Array.isArray(parsed)) sourceReferences = parsed as MemorySourceReference[];
    } catch {
      sourceReferences = [];
    }
    const units = await extractRetrievalUnitsV4(env, {
      id: row.id,
      tenant_id: row.tenant_id,
      project_id: row.project_id,
      content: row.content,
      summary: row.summary,
      created_at: row.created_at,
      updated_at: row.updated_at ?? row.created_at,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      source_references: sourceReferences
    });
    const statements: D1PreparedStatement[] = [
      env.OPEN_BRAIN_DB.prepare(
        "DELETE FROM memory_retrieval_units_v4_fts WHERE tenant_id = ? AND memory_id = ?"
      ).bind(row.tenant_id, row.id),
      env.OPEN_BRAIN_DB.prepare(
        "DELETE FROM memory_retrieval_units_v4 WHERE tenant_id = ? AND memory_id = ?"
      ).bind(row.tenant_id, row.id)
    ];
    for (const unit of units) {
      unitHashes.push(unit.content_hash);
      statements.push(
        env.OPEN_BRAIN_DB.prepare(
          `INSERT INTO memory_retrieval_units_v4(
            id, memory_id, tenant_id, project_id, unit_type, speaker, text,
            event_at, valid_from, valid_until, source_ref_json, source_span_start,
            source_span_end, content_hash, metadata_json, segment_id, extractor,
            extractor_version, extraction_state, degraded_reason, created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          unit.id, unit.memory_id, unit.tenant_id, unit.project_id, unit.unit_type,
          unit.speaker, unit.text, unit.event_at, unit.valid_from, unit.valid_until,
          unit.source_ref_json, unit.source_span_start, unit.source_span_end,
          unit.content_hash, unit.metadata_json, unit.segment_id, unit.extractor,
          unit.extractor_version, unit.extraction_state, unit.degraded_reason, unit.created_at
        ),
        env.OPEN_BRAIN_DB.prepare(
          "INSERT INTO memory_retrieval_units_v4_fts(unit_id, memory_id, tenant_id, text) VALUES(?,?,?,?)"
        ).bind(unit.id, unit.memory_id, unit.tenant_id, unit.text)
      );
    }
    for (let offset = 0; offset < statements.length; offset += 50) {
      await env.OPEN_BRAIN_DB.batch(statements.slice(offset, offset + 50));
    }
    projectedUnits += units.length;
  }
  const nextCursor = rows.results.at(-1)?.id ?? cursor;
  const done = rows.results.length < limit;
  const totalProcessed = Number(checkpoint?.processed_memories ?? 0) + rows.results.length;
  const totalProjectedUnits = Number(checkpoint?.projected_units ?? 0) + projectedUnits;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(unitHashes.sort().join("\0"))
  ).then((value) =>
    [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  );
  const vectorize = await syncMemoryIdsToV4SemanticIndex(
    env,
    options.tenantId,
    rows.results.map((row) => row.id)
  );
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO retrieval_projection_v4_backfills(
       tenant_id, project_id, cursor, processed_memories, projected_units,
       unit_digest, state, updated_at
     ) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, project_id) DO UPDATE SET
       cursor = excluded.cursor,
       processed_memories = excluded.processed_memories,
       projected_units = excluded.projected_units,
       unit_digest = excluded.unit_digest,
       state = excluded.state,
       updated_at = excluded.updated_at`
  ).bind(
    options.tenantId,
    options.projectId ?? "",
    nextCursor,
    totalProcessed,
    totalProjectedUnits,
    digest,
    done ? "complete" : "running",
    Date.now()
  ).run();
  return {
    tenant_id: options.tenantId,
    project_id: options.projectId ?? null,
    processed_memories: rows.results.length,
    projected_units: projectedUnits,
    total_processed_memories: totalProcessed,
    total_projected_units: totalProjectedUnits,
    unit_digest: digest,
    next_cursor: nextCursor || null,
    done,
    vectorize
  };
}
