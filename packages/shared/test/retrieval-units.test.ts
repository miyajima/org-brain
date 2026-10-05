import { describe, expect, it } from "vitest";
import {
  analyzeRetrievalIntent,
  buildRetrievalUnits,
  buildRetrievalUnitsV4,
  retrievalQueryTokens,
  retrievalSubjectQueryTokens,
  retrievalUnitLexicalSpecificity
} from "../src/retrieval-units";

describe("retrieval units", () => {
  const provenanceRecord = {
    id: "source-versioned", tenant_id: "tenant-1", project_id: "project-1",
    content: "The policy mentions 2030-01-01. I attended the launch on 2025-02-03.",
    summary: null, created_at: Date.UTC(2026, 0, 1), updated_at: Date.UTC(2026, 0, 2),
    valid_from: null, valid_until: null, current_version: 3, content_hash: "a".repeat(64),
    source_references: [{ type: "file", ref: "docs/release.md", captured_at: Date.UTC(2026, 0, 1) }],
    rationale: "Synthetic validation permits bounded replay.",
    reuse_rule: "Only synthetic fixtures after checking their digest; never use production inputs."
  };

  it("separates mentioned dates from explicit event time and retains exact source lineage", async () => {
    const units = await buildRetrievalUnitsV4(provenanceRecord);
    const policy = units.find((unit) => unit.unit_type === "atomic" && unit.text.includes("policy"))!;
    expect(policy.event_at).toBe(provenanceRecord.created_at);
    expect(JSON.parse(policy.metadata_json)).toMatchObject({
      mentioned_at: Date.UTC(2030, 0, 1), event_time_basis: "source_capture",
      source_memory_id: provenanceRecord.id, source_version: 3,
      source_content_hash: provenanceRecord.content_hash, evidence_status: "extracted_unverified"
    });
    const event = units.find((unit) => unit.unit_type === "timeline" && unit.text.includes("attended"))!;
    expect(event.event_at).toBe(Date.UTC(2025, 1, 3));
    expect(JSON.parse(event.metadata_json)).toMatchObject({
      mentioned_at: Date.UTC(2025, 1, 3), starts_at: Date.UTC(2025, 1, 3), event_time_basis: "explicit_event_text"
    });
  });

  it.each([
    "The deployment is scheduled on 2030-01-01.",
    "The deployment may occur on 2030-01-01.",
    "The policy deadline is on 2030-01-01.",
    "We planned to attend the launch on 2030-01-01.",
    "We will attend the launch on 2030-01-01.",
    "We did not attend the launch on 2030-01-01.",
    "2030-01-01にデプロイを実施する予定です。",
    "2030-01-01に障害が発生するかもしれません。",
    "方針の期限は2030-01-01です。",
    "2030-01-01に参加した場合は検証してください。",
    "2030-01-01に参加したら検証する。"
  ])("keeps a planned, modal, negative or deadline date as mentioned time: %s", async (content) => {
    const units = await buildRetrievalUnitsV4({ ...provenanceRecord, content });
    const dated = units.filter((unit) => JSON.parse(unit.metadata_json).mentioned_at !== undefined);
    expect(dated.length).toBeGreaterThan(0);
    for (const unit of dated) {
      expect(unit.event_at).toBe(provenanceRecord.created_at);
      expect(JSON.parse(unit.metadata_json)).toMatchObject({
        mentioned_at: Date.UTC(2030, 0, 1), event_time_basis: "source_capture"
      });
      if (unit.unit_type === "timeline") expect(JSON.parse(unit.metadata_json).starts_at).toBeNull();
    }
  });

  it.each([
    "The deployment completed on 2025-02-03.",
    "The incident occurred on 2025-02-03.",
    "2025-02-03にイベントに参加した。",
    "2025-02-03に障害が発生しました。"
  ])("retains an explicit realized event date without attesting execution: %s", async (content) => {
    const units = await buildRetrievalUnitsV4({ ...provenanceRecord, content });
    const event = units.find((unit) => unit.unit_type === "timeline")!;
    expect(event.event_at).toBe(Date.UTC(2025, 1, 3));
    expect(JSON.parse(event.metadata_json)).toMatchObject({
      mentioned_at: Date.UTC(2025, 1, 3), event_time_basis: "explicit_event_text", evidence_status: "extracted_unverified"
    });
  });

  it("anchors structured output to the persisted source and preserves complete conditional reuse", async () => {
    const units = await buildRetrievalUnitsV4(provenanceRecord, { structuredUnits: [{
      text: "Use bounded replay.", event_at: Date.UTC(2025, 1, 3),
      metadata: { source_memory_id: "forged", source_version: 999, source_content_hash: "forged", evidence_status: "verified" }
    }] });
    expect(JSON.parse(units[0].metadata_json)).toMatchObject({
      source_memory_id: provenanceRecord.id, source_version: 3,
      source_content_hash: provenanceRecord.content_hash, evidence_status: "extracted_unverified"
    });
    expect(units.find((unit) => JSON.parse(unit.metadata_json).channel === "reuse_or_avoidance")?.text)
      .toBe(`Reuse or avoid: ${provenanceRecord.reuse_rule}`);
    expect(units.find((unit) => JSON.parse(unit.metadata_json).channel === "rationale")?.text)
      .toBe(`Rationale: ${provenanceRecord.rationale}`);
    expect(JSON.parse(units[0].source_ref_json)).toEqual(provenanceRecord.source_references[0]);
  });

  it("keeps canonical support when a structured extractor repeats the same projection", async () => {
    const prior = await buildRetrievalUnitsV4(provenanceRecord);
    const structuredUnits = prior.filter((unit) => unit.unit_type !== "segment").map((unit) => ({
      text: unit.text, speaker: unit.speaker, event_at: unit.event_at,
      unit_type: unit.unit_type as "atomic" | "profile" | "ledger" | "timeline",
      metadata: { evidence_status: "verified" }
    }));
    const units = await buildRetrievalUnitsV4(provenanceRecord, { structuredUnits });
    expect(new Set(units.map((unit) => unit.id)).size).toBe(units.length);
    expect(units.filter((unit) => JSON.parse(unit.metadata_json).channel === "reuse_or_avoidance")).toHaveLength(1);
    expect(units.every((unit) => JSON.parse(unit.metadata_json).evidence_status === "extracted_unverified")).toBe(true);
  });

  it("builds generic v4 profile, timeline, atomic, and segment channels", async () => {
    const units = await buildRetrievalUnitsV4({
      id: "memory-v4",
      tenant_id: "tenant-1",
      project_id: "project-1",
      content: [
        "user: I used to prefer coffee.",
        "user: I now prefer jasmine tea.",
        "system: Always use the approved release policy.",
        "user: I attended the launch in 2025."
      ].join("\n"),
      summary: "Preference and policy changed",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_100,
      valid_from: null,
      valid_until: null,
      source_references: [{ type: "session", ref: "session-v4" }]
    });
    expect(units.map((unit) => unit.unit_type)).toEqual(expect.arrayContaining([
      "atomic", "profile", "timeline", "segment"
    ]));
    expect(units.every((unit) => unit.extractor_version === "4.1")).toBe(true);
    expect(units.every((unit) => JSON.parse(unit.metadata_json))).toBeTruthy();
    expect(units.find((unit) => unit.unit_type === "segment")?.segment_id).toMatch(/^seg_/);
  });

  it("uses record kind as a deterministic fallback without inventing timeline events", async () => {
    const units = await buildRetrievalUnitsV4({
      id: "memory-kind-fallback",
      tenant_id: "tenant-1",
      project_id: "project-1",
      kind: "constraint",
      content: "release001 durable answer: run backend validation after migration",
      summary: "Backend validation requirement",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_100,
      valid_from: null,
      valid_until: null,
      source_references: [{ type: "file", ref: "docs/release.md" }]
    });
    expect(units.map((unit) => unit.unit_type)).toEqual(expect.arrayContaining([
      "atomic", "profile", "segment"
    ]));
    expect(units.some((unit) => unit.unit_type === "timeline")).toBe(false);
    expect(units.find((unit) => unit.unit_type === "atomic")?.text).toContain("release001");
  });

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
    expect(retrievalSubjectQueryTokens("What is the total number of siblings I have?"))
      .toEqual(expect.arrayContaining(["sibling", "brother", "sister"]));
    expect(retrievalSubjectQueryTokens("What was my previous occupation?"))
      .toEqual(expect.arrayContaining(["occupation", "job", "role", "career"]));
    expect(retrievalSubjectQueryTokens("What type of cocktail recipe did I try last weekend?"))
      .toEqual(["cocktail", "recipe"]);
    expect(retrievalSubjectQueryTokens("What is the name of my hamster?"))
      .toEqual(expect.arrayContaining(["hamster", "pet", "rodent"]));
  });
});
