import { describe, expect, it } from "vitest";
import { CloudflareVectorRetrievalIndex } from "../src/retrieval-index-service";

describe("CloudflareVectorRetrievalIndex", () => {
  it("uses real embedding output and tenant namespaces for upsert and query", async () => {
    const embedded: unknown[] = [];
    const upserts: any[] = [];
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
      async deleteByIds() {
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
    expect(hits).toEqual([{ id: "memory-1", score: 0.92 }]);
  });
});
