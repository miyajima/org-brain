import { describe, expect, it } from "vitest";
import { analyzeRetrievalIntent, buildRetrievalUnits } from "../src/retrieval-units";

describe("retrieval units", () => {
  it("builds session, turn, and generic atomic fallback units without query input", async () => {
    const units = await buildRetrievalUnits({
      id: "memory-1",
      tenant_id: "tenant-1",
      project_id: "project-1",
      content: [
        "user: I used to prefer coffee.",
        "assistant: You recommended a compact brewer.",
        "user: I now prefer jasmine tea and bought 3 boxes."
      ].join("\n"),
      summary: "Drink preference changed",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_100,
      valid_from: 1_700_000_000_000,
      valid_until: null,
      source_references: [{ type: "session", ref: "session-1" }]
    });
    expect(units.some((unit) => unit.unit_type === "session")).toBe(true);
    expect(units.filter((unit) => unit.unit_type === "turn")).toHaveLength(3);
    expect(units.some((unit) => unit.unit_type === "update")).toBe(true);
    expect(units.every((unit) => unit.extraction_state === "degraded")).toBe(true);
    expect(units.every((unit) => /^[a-f0-9]{64}$/.test(unit.content_hash))).toBe(true);
  });

  it("applies temporal and speaker intent only when explicitly requested", () => {
    expect(analyzeRetrievalIntent("What is the latest thing I said I prefer?")).toMatchObject({
      temporal_direction: "latest",
      speaker: "user"
    });
    expect(analyzeRetrievalIntent("What device supports the protocol?")).toMatchObject({
      temporal_direction: null,
      speaker: null
    });
  });
});
