import type {
  RetrievalIndex,
  RetrievalIndexDocument,
  RetrievalIndexHit,
  RetrievalIndexQuery
} from "@org-brain/shared";
import type { Env } from "./types";

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5" as const;
const BATCH_SIZE = 64;

function extractEmbedding(output: unknown): number[] {
  if (!output || typeof output !== "object") {
    throw new Error("embedding provider returned an invalid response");
  }
  const data = (output as { data?: unknown }).data;
  if (
    !Array.isArray(data) ||
    !Array.isArray(data[0]) ||
    data[0].some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("embedding provider returned no numeric vector");
  }
  return data[0] as number[];
}

export class CloudflareVectorRetrievalIndex implements RetrievalIndex {
  readonly kind = "semantic" as const;
  readonly provider = `cloudflare-workers-ai:${EMBEDDING_MODEL}+vectorize`;

  constructor(
    private readonly ai: Ai,
    private readonly index: Vectorize
  ) {}

  async available(): Promise<boolean> {
    try {
      await this.index.describe();
      return true;
    } catch {
      return false;
    }
  }

  private async embed(text: string): Promise<number[]> {
    const output = await this.ai.run(EMBEDDING_MODEL, {
      text: [text.slice(0, 20_000)],
      pooling: "cls"
    });
    return extractEmbedding(output);
  }

  async upsert(documents: RetrievalIndexDocument[]): Promise<void> {
    for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
      const batch = documents.slice(offset, offset + BATCH_SIZE);
      const vectors = await Promise.all(
        batch.map(async (document) => ({
          id: document.id,
          namespace: document.tenant_id,
          values: await this.embed(document.text),
          metadata: {
            tenant_id: document.tenant_id,
            project_id: document.project_id ?? "",
            updated_at: document.updated_at
          }
        }))
      );
      await this.index.upsert(vectors);
    }
  }

  async remove(_tenantId: string, ids: string[]): Promise<void> {
    if (ids.length > 0) await this.index.deleteByIds(ids);
  }

  async query(input: RetrievalIndexQuery): Promise<RetrievalIndexHit[]> {
    const vector = await this.embed(input.query);
    const result = await this.index.query(vector, {
      topK: input.limit,
      namespace: input.tenant_id,
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
