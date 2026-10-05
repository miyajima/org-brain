import { describe, expect, it } from "vitest";
import {
  parseGeminiV4Units,
  RETRIEVAL_V4_GEMINI_MODEL
} from "../src/retrieval-v4-extraction-service";

describe("retrieval v4 structured extraction", () => {
  it("pins Gemini to ingestion extraction and validates structured units", () => {
    expect(RETRIEVAL_V4_GEMINI_MODEL).toBe("gemini-3.5-flash-lite");
    expect(parseGeminiV4Units({
      units: [{
        text: "I now prefer tea.",
        speaker: "user",
        unit_type: "profile",
        subject: "user",
        predicate: "prefers",
        object: "tea",
        polarity: "positive",
        domain: "preference",
        event_at: 123,
        mentioned_at: 456
      }]
    })).toEqual([expect.objectContaining({
      text: "I now prefer tea.",
      unit_type: "profile",
      event_at: 123,
      metadata: expect.objectContaining({ subject: "user", object: "tea", mentioned_at: 456 })
    })]);
  });

  it("does not promote a mentioned or legacy normalized date to event occurrence", () => {
    const units = parseGeminiV4Units({ units: [
      { text: "The approved policy mentions 2030.", normalized_at: 1_893_456_000_000 },
      { text: "An invalid time must remain unknown.", event_at: Infinity, mentioned_at: NaN, ends_at: Infinity }
    ] });
    expect(units[0]).toMatchObject({ event_at: null, metadata: { mentioned_at: 1_893_456_000_000, event_time_basis: "source_capture" } });
    expect(units[1]).toMatchObject({ event_at: null, metadata: { mentioned_at: null, ends_at: null } });
  });
});
