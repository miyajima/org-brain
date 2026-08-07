import { describe, expect, it } from "vitest";
import {
  decisionResourceLinkCreateSchema,
  knowledgeResourceCreateSchema,
  knowledgeResourceVersionCaptureSchema
} from "../src/index";

const digest = "a".repeat(64);

describe("knowledge resource contracts", () => {
  it("accepts a version-pinned confirmed rationale source", () => {
    expect(decisionResourceLinkCreateSchema.parse({
      decision_ref: { source_type: "decision_memory", source_id: "decision-1" },
      resource_id: "resource-1",
      resource_version_id: "version-1",
      role: "rationale_source",
      excerpt_digest: digest,
      locator: { page: 2, heading: "Decision" },
      idempotency_key: "link-1"
    }).confirmation_state).toBe("confirmed");
  });

  it("rejects an unpinned confirmed conclusion source", () => {
    expect(() => decisionResourceLinkCreateSchema.parse({
      decision_ref: { source_type: "decision_memory", source_id: "decision-1" },
      resource_id: "resource-1",
      role: "conclusion_source",
      idempotency_key: "link-1"
    })).toThrow(/pin a resource version/u);
  });

  it("bounds resource and snapshot input", () => {
    expect(knowledgeResourceCreateSchema.parse({
      resource_kind: "document",
      canonical_uri: "https://example.com/decision",
      title: "Decision record",
      source_system: "web",
      media_type: "text/html"
    }).visibility).toBe("tenant");
    expect(knowledgeResourceVersionCaptureSchema.parse({
      connector_id: "connector-1",
      content_hash: digest,
      snapshot_object_ref: "r2://tenant/resources/resource-1/version-1",
      extracted_text: "Decision and rationale",
      extracted_text_hash: digest
    }).extraction_state).toBe("ready");
  });
});
