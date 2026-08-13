import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("verified learning locked retrieval fixture", () => {
  it("expands to 300 next-task queries without raw transcripts", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/memory-learning-retrieval-locked-v1.json", import.meta.url), "utf8"));
    const queries = fixture.expansion.themes.flatMap((theme: string) =>
      fixture.expansion.query_styles.map((style: string) => ({ theme, style }))
    );
    expect(queries).toHaveLength(fixture.expected_query_count);
    expect(fixture.raw_transcript_persisted).toBe(false);
  });
});

