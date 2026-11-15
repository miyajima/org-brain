import { describe, expect, it } from "vitest";
import { buildDetailRecord, buildDetailRecordFromMemoryDetail, trimText, type MemoryRow, type MemorySearchResult, type MemoryProfileItem, type MemoryDetailResponse } from "./memory-detail-view";

const row = { id: "id", summary: "Corpus", content: "Corpus content", source: "corpus", kind: "semantic", tags: ["corpus"], reference_count: 4 } as MemoryRow;
const search = { id: "id", kind: "memory", summary: "Search", content_preview: "Search content", source: "search", score: 0.6 } as MemorySearchResult;
const profile = { id: "id", summary: "Profile", content_preview: "Profile content", source: "profile", project_id: "project", tags: ["profile"], memory_kind: "decision", current_version: 3 } as MemoryProfileItem;

describe("memory detail view", () => {
  it("prefers the corpus and retains a search score", () => {
    expect(buildDetailRecord("id", [row], [search], [profile])).toMatchObject({ title: "Corpus", content: "Corpus content", tags: ["corpus"], score: 0.6, reference_count: 4 });
  });

  it("enriches a search result with profile fields, then falls back to the profile", () => {
    expect(buildDetailRecord("id", [], [search], [profile])).toMatchObject({ title: "Search", project_id: "project", tags: ["profile"], memory_kind: "decision", current_version: 3 });
    expect(buildDetailRecord("id", [], [], [profile])).toMatchObject({ title: "Profile", content: "Profile content", score: null });
    expect(buildDetailRecord("id", [], [search], [])).toMatchObject({ title: "Search", project_id: null, tags: [], memory_kind: "episodic", current_version: 1, reference_count: 0 });
    expect(buildDetailRecord("missing", [row], [search], [profile])).toBeNull();
  });

  it("handles absent detail and normalizes missing optional display values", () => {
    expect(buildDetailRecordFromMemoryDetail(null)).toBeNull();
    expect(buildDetailRecordFromMemoryDetail({ memory: null } as MemoryDetailResponse)).toBeNull();
    const detail = { memory_id: "fallback-id", memory: { ...row, id: "", summary: null, tags: null, reference_count: null } } as unknown as MemoryDetailResponse;
    expect(buildDetailRecordFromMemoryDetail(detail)).toMatchObject({ id: "fallback-id", summary: "", tags: [], score: null, reference_count: 0, attention_reasons: [] });
    expect(trimText("  one\n two  ", 5)).toBe("one ...");
    expect(trimText(null)).toBe("");
  });
});
