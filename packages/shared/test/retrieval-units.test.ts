import { describe, expect, it } from "vitest";
import {
  analyzeRetrievalIntent,
  buildRetrievalUnits,
  retrievalQueryTokens,
  retrievalUnitLexicalSpecificity
} from "../src/retrieval-units";

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
    expect(analyzeRetrievalIntent("What milestone happened four weeks ago?")).toMatchObject({
      relative_age_ms: 28 * 24 * 60 * 60 * 1000
    });
    expect(analyzeRetrievalIntent("What did I cook a couple of days ago?")).toMatchObject({
      relative_age_ms: 2 * 24 * 60 * 60 * 1000
    });
    expect(analyzeRetrievalIntent("What did I try last weekend?")).toMatchObject({
      relative_age_ms: 7 * 24 * 60 * 60 * 1000
    });
    expect(analyzeRetrievalIntent("Who did I meet last Tuesday?")).toMatchObject({
      relative_weekday: 2
    });
    expect(analyzeRetrievalIntent("What chord progression did you create?")).toMatchObject({
      speaker: "assistant"
    });
    expect(analyzeRetrievalIntent("How many siblings do I have?")).toMatchObject({
      speaker: "user",
      unit_types: expect.arrayContaining(["fact", "event"])
    });
    expect(analyzeRetrievalIntent("Any ideas on how I can find inspiration?").unit_types).toContain(
      "preference"
    );
  });

  it("keeps source event time separate from record validity", async () => {
    const units = await buildRetrievalUnits({
      id: "memory-event-time",
      tenant_id: "tenant-1",
      project_id: null,
      content: "user: I attended the event last month.",
      summary: null,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_100,
      valid_from: 1_650_000_000_000,
      valid_until: null,
      source_references: [{
        type: "session",
        ref: "session-event",
        captured_at: 1_600_000_000_000
      }]
    });
    expect(units.every((unit) => unit.event_at === 1_600_000_000_000)).toBe(true);
    expect(units.every((unit) => unit.valid_from === 1_650_000_000_000)).toBe(true);
  });

  it("scores rare query terms above generic intent words", () => {
    const scores = retrievalUnitLexicalSpecificity([
      { id: "exact", text: "I currently use Trader Joe's lavender shampoo." },
      { id: "generic", text: "I currently use the updated workflow." },
      { id: "other", text: "The workflow is currently available." }
    ], "What brand of shampoo do I currently use?");
    expect(scores.get("exact")).toBeGreaterThan(scores.get("generic") ?? 0);
  });

  it("keeps subject terms when a query starts with conversational framing", () => {
    const tokens = retrievalQueryTokens(
      "I've been thinking about making a cocktail. Any recommendations?"
    );
    expect(tokens).toEqual(expect.arrayContaining(["cocktail"]));
    expect(tokens).not.toEqual(expect.arrayContaining(["been", "thinking", "recommendations"]));
    expect(retrievalQueryTokens(
      "Which publications cover doctors participating in conferences?"
    )).toEqual(expect.arrayContaining([
      "publication", "paper", "article", "doctor", "physician", "participate", "conference"
    ]));
    expect(retrievalQueryTokens("buisiness milestone")).toContain("business");
    expect(retrievalQueryTokens(
      "I am planning another theme park weekend; any suggestions?"
    )).toEqual(["theme", "park"]);
  });
});
