import { describe, expect, it } from "vitest";
import {
  CloudflareVectorRetrievalIndex,
  EMBEDDING_MODEL_V3,
  RERANKER_MODEL_V3,
  getGenerationSemanticRetrievalIndex,
  rerankV3MemoryCandidates
} from "../src/retrieval-index-service";

describe("CloudflareVectorRetrievalIndex", () => {
  it("embeds and upserts documents in bounded high-throughput batches", async () => {
    const embeddingBatchSizes: number[] = [];
    const upsertBatchSizes: number[] = [];
    const ai = {
      async run(_model: string, input: { text: string[] }) {
        embeddingBatchSizes.push(input.text.length);
        return { data: input.text.map(() => [0.1, 0.2, 0.3]) };
      }
    };
    const vector = {
      async upsert(items: unknown[]) {
        upsertBatchSizes.push(items.length);
        return { mutationId: "mutation-batch" };
      }
    };
    const index = new CloudflareVectorRetrievalIndex(ai as any, vector as any);
    await index.upsert(Array.from({ length: 33 }, (_, itemIndex) => ({
      id: `memory-${itemIndex}`,
      tenant_id: "tenant-a",
      project_id: "project-a",
      text: `semantic memory ${itemIndex}`,
      entities: [],
      updated_at: itemIndex
    })));

    expect(embeddingBatchSizes.sort((left, right) => right - left)).toEqual([16, 16, 1]);
    expect(upsertBatchSizes.sort((left, right) => right - left)).toEqual([16, 16, 1]);
  });

  it("uses real embedding output and tenant namespaces for upsert and query", async () => {
    const embedded: unknown[] = [];
    const upserts: any[] = [];
    const deletes: string[][] = [];
    const queries: any[] = [];
    const ai = {
      async run(_model: string, input: unknown) {
        embedded.push(input);
        return { data: [[0.1, 0.2, 0.3]] };
      }
    };
    const vector = {
      async describe() {
        return { dimensions: 3 };
      },
      async upsert(items: unknown[]) {
        upserts.push(...items);
        return { mutationId: "mutation-1" };
      },
      async deleteByIds(ids: string[]) {
        deletes.push(ids);
        return { mutationId: "mutation-2" };
      },
      async query(values: number[], options: unknown) {
        queries.push({ values, options });
        return { matches: [{ id: "memory-1", score: 0.92 }], count: 1 };
      }
    };
    const index = new CloudflareVectorRetrievalIndex(ai as any, vector as any);

    await index.upsert([{
      id: "memory-1",
      tenant_id: "tenant-a",
      project_id: "project-a",
      text: "semantic memory",
      entities: [],
      updated_at: 123
    }]);
    const hits = await index.query({
      tenant_id: "tenant-a",
      project_id: "project-a",
      query: "related meaning",
      limit: 5
    });
    await index.remove("tenant-a", Array.from({ length: 205 }, (_, index) => `unit-${index}`));

    expect(embedded).toHaveLength(2);
    expect(upserts[0]).toMatchObject({
      id: "memory-1",
      namespace: "tenant-a",
      metadata: { tenant_id: "tenant-a", project_id: "project-a" }
    });
    expect(queries[0].options).toMatchObject({
      namespace: "tenant-a",
      filter: { project_id: { $eq: "project-a" } }
    });
    expect(deletes.map((ids) => ids.length)).toEqual([100, 100, 5]);
    expect(hits).toEqual([{ id: "memory-1", score: 0.92 }]);
  });

  it("reports a healthy reranker binding even when there are no candidates", async () => {
    const result = await rerankV3MemoryCandidates(
      { AI: { run: async () => { throw new Error("must not run"); } } } as any,
      "no matching memory",
      []
    );

    expect(result?.scores.size).toBe(0);
    expect(result?.provider).toBe(`cloudflare-workers-ai:${RERANKER_MODEL_V3}`);
  });

  it("isolates verified-learning vectors by generation and uses Qwen embeddings", async () => {
    const models: string[] = [];
    const upserts: any[] = [];
    const queries: any[] = [];
    const ai = {
      async run(model: string) {
        models.push(model);
        return { data: [[0.1, 0.2, 0.3]] };
      }
    };
    const vector = {
      async describe() { return { dimensions: 3 }; },
      async upsert(items: unknown[]) { upserts.push(...items); return { mutationId: "learning-upsert" }; },
      async query(_values: number[], options: unknown) {
        queries.push(options);
        return { matches: [{ id: "unit-learning-1", score: 0.97 }] };
      }
    };
    const index = getGenerationSemanticRetrievalIndex({
      AI: ai,
      MEMORY_VECTOR_INDEX_V3: vector
    } as any, "gen_verified_learning");
    expect(index).not.toBeNull();

    await index!.upsert([{
      id: "unit-learning-1",
      memory_id: "memory-learning-1",
      tenant_id: "tenant-a",
      project_id: "project-a",
      unit_type: "segment",
      text: "trigger conclusion rationale reuse outcome",
      entities: [],
      updated_at: 123
    }]);
    const hits = await index!.query({ tenant_id: "tenant-a", project_id: "project-a", query: "avoid this failure", limit: 5 });

    expect(models).toEqual([EMBEDDING_MODEL_V3, EMBEDDING_MODEL_V3]);
    expect(upserts[0]).toMatchObject({
      namespace: "tenant-a:generation:gen_verified_learning",
      metadata: { memory_id: "memory-learning-1", unit_type: "segment" }
    });
    expect(queries[0]).toMatchObject({ namespace: "tenant-a:generation:gen_verified_learning" });
    expect(hits).toEqual([{ id: "unit-learning-1", score: 0.97 }]);
  });
});
