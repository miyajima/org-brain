import { describe, expect, it } from "vitest";
import { sha256 } from "@org-brain/shared";
import { extractMemoryCandidates } from "../src/memory-extraction-service";

describe("memory extraction comparison", () => {
  it("marks an existing durable statement as a duplicate without storing raw transcript", async () => {
    const content = "Backend validation must run with TZ=UTC for stable tests.";
    const hash = await sha256(content);
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async all() {
            if (sql.includes("SELECT id, content, content_hash")) {
              return {
                results: [{
                  id: "memory-existing",
                  content,
                  content_hash: hash,
                  canonical_key: null,
                  valid_until: null
                }]
              };
            }
            return { results: [] };
          }
        };
      }
    };

    const result = await extractMemoryCandidates(
      { OPEN_BRAIN_DB: db } as any,
      {
        event_id: "event-duplicate",
        tenant_id: "tenant-a",
        project_id: "project-a",
        source: "codex",
        occurred_at: Date.now(),
        text: content
      }
    );

    expect(result.raw_transcript_persisted).toBe(false);
    expect(result.candidates[0].review).toEqual({
      action: "duplicate",
      existing_memory_ids: ["memory-existing"],
      reason: "same canonical key or content hash already exists"
    });
  });
});
