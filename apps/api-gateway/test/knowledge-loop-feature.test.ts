import { describe, expect, it } from "vitest";
import { assertKnowledgeLoopWritable, isKnowledgeLoopWritable } from "../src/knowledge-loop-feature";
import type { Env } from "../src/types";

const env = (mode: "off" | "preview" | "on" | undefined, allowlist?: string): Env => ({
  RETROSPECTIVE_MODE: mode,
  KNOWLEDGE_LOOP_PREVIEW_WRITE_TENANTS_JSON: allowlist
} as Env);

describe("knowledge loop preview write boundary", () => {
  it("keeps on writable and preview fail-closed by default", () => {
    expect(isKnowledgeLoopWritable(env("on"), "RETROSPECTIVE_MODE", "tenant-a")).toBe(true);
    expect(isKnowledgeLoopWritable(env("preview"), "RETROSPECTIVE_MODE", "tenant-a")).toBe(false);
    expect(() => assertKnowledgeLoopWritable(env("preview"), "RETROSPECTIVE_MODE", "tenant-a"))
      .toThrowError(expect.objectContaining({ status: 409, code: "feature_preview" }));
  });

  it("writes only for an explicitly allowlisted preview tenant", () => {
    const configured = env("preview", JSON.stringify(["tenant-a"]));
    expect(isKnowledgeLoopWritable(configured, "RETROSPECTIVE_MODE", "tenant-a")).toBe(true);
    expect(isKnowledgeLoopWritable(configured, "RETROSPECTIVE_MODE", "tenant-b")).toBe(false);
  });

  it("surfaces malformed configuration as a server misconfiguration", () => {
    expect(() => assertKnowledgeLoopWritable(env("preview", "{"), "RETROSPECTIVE_MODE", "tenant-a"))
      .toThrowError(expect.objectContaining({ status: 500, code: "misconfigured" }));
  });
});
