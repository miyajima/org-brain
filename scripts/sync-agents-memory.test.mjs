import { describe, expect, it } from "vitest";
import { renderOrgBrainMarkdown, resolveApiBase } from "./sync-agents-memory.mjs";

describe("sync-agents-memory helpers", () => {
  it("uses ORGBRAIN_API_BASE as a fallback alias when canonical URL is absent", () => {
    expect(resolveApiBase({ ORGBRAIN_API_BASE: "https://legacy.example.test" })).toBe("https://legacy.example.test");
    expect(
      resolveApiBase({
        ORGBRAIN_API_URL: "https://canonical.example.test",
        ORGBRAIN_API_BASE: "https://legacy.example.test"
      })
    ).toBe("https://canonical.example.test");
  });

  it("exports stable metadata for downstream agent imports", () => {
    const markdown = renderOrgBrainMarkdown(
      [
        {
          id: "mem-1",
          tenant_id: "team-a",
          project_id: "org-brain",
          source: "codex",
          external_key: "codex:turn-1",
          summary: "Use shared memory",
          content: "Prefer MCP context enrichment before implementation.",
          created_at: 1_700_000_000_000,
          kind: "semantic",
          lifecycle_state: "active"
        }
      ],
      "codex",
      "team-a"
    );

    expect(markdown).toContain("tenant: \"team-a\"");
    expect(markdown).toContain("project_id: \"org-brain\"");
    expect(markdown).toContain("source: \"codex\"");
    expect(markdown).toContain("external_key: \"codex:turn-1\"");
    expect(markdown).toContain("memory_kind: \"semantic\"");
    expect(markdown).toContain("lifecycle_state: \"active\"");
  });
});
