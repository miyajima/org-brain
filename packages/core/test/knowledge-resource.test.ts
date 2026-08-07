import { describe, expect, it } from "vitest";
import { assertConnectorFetchUri, chunkKnowledgeResourceText, groupDecisionArtifacts, normalizeKnowledgeResourceUri } from "../src/index";

describe("knowledge resource core", () => {
  it("normalizes stable URI identity without fragment locators", () => {
    expect(normalizeKnowledgeResourceUri(" HTTPS://Example.COM:443/path#decision ")).toBe("https://example.com/path");
  });

  it("rejects embedded credentials and private connector targets", () => {
    expect(() => normalizeKnowledgeResourceUri("https://user:secret@example.com/doc")).toThrow(/credentials/u);
    expect(() => assertConnectorFetchUri("https://127.0.0.1/doc")).toThrow(/private/u);
    expect(() => assertConnectorFetchUri("https://[fc00::1]/doc")).toThrow(/private/u);
    expect(() => assertConnectorFetchUri("https://[fe80::1]/doc")).toThrow(/private/u);
    expect(() => assertConnectorFetchUri("https://[::ffff:127.0.0.1]/doc")).toThrow(/private/u);
    expect(() => assertConnectorFetchUri("https://[::]/doc")).toThrow(/private/u);
    expect(() => assertConnectorFetchUri("https://100.64.0.1/doc")).toThrow(/private/u);
    expect(() => assertConnectorFetchUri("https://198.18.0.1/doc")).toThrow(/private/u);
  });

  it("chunks version text deterministically with locatable source spans", () => {
    const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}`;
    const chunks = chunkKnowledgeResourceText(text, { maxChars: 400, overlapChars: 25 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ index: 0, source_span_start: 0, source_span_end: 302 });
    expect(chunks[1].source_span_start).toBe(277);
    expect(chunks.map((chunk) => text.slice(chunk.source_span_start, chunk.source_span_end))).toEqual(chunks.map((chunk) => chunk.text));
  });

  it("groups only current confirmed links", () => {
    const base = {
      assertion_id: "a1",
      decision_ref: { source_type: "decision_memory" as const, source_id: "d1" },
      resource_id: "r1",
      resource_version_id: "v1",
      locator: null,
      excerpt_digest: null,
      note: null,
      valid_from: 1,
      valid_until: null,
      actor: "user:1",
      reviewed_by: null,
      created_at: 1
    };
    const grouped = groupDecisionArtifacts([
      { ...base, role: "output_artifact", confirmation_state: "confirmed" },
      { ...base, assertion_id: "a2", role: "output_artifact", confirmation_state: "proposal" }
    ]);
    expect(grouped.output_artifact.map((item) => item.assertion_id)).toEqual(["a1"]);
  });
});
