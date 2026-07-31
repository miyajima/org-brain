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
        normalized_at: 123
      }]
    })).toEqual([expect.objectContaining({
      text: "I now prefer tea.",
      unit_type: "profile",
      event_at: 123,
      metadata: expect.objectContaining({ subject: "user", object: "tea" })
    })]);
  });
});
