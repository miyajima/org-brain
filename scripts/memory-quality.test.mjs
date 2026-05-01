import { describe, expect, it } from "vitest";
import { classifyMemoryQuality } from "./lib/memory-quality.mjs";

describe("memory-quality classifier", () => {
  it("deletes route-only and meta-only hook summaries", () => {
    expect(
      classifyMemoryQuality({
        summary: "tetori | agent-turn-complete | route=inline/current-agent",
        content: "route=inline/current-agent",
        tags: ["codex", "hook", "agent-turn-complete", "tetori"]
      })
    ).toMatchObject({ action: "delete" });

    expect(
      classifyMemoryQuality({
        summary: ".agents | agent-turn-complete | 必要な作業は終わっています。ほかに進める内容があれば、そのまま書いてください。",
        content: "必要な作業は終わっています。ほかに進める内容があれば、そのまま書いてください。",
        tags: ["codex", "hook", "agent-turn-complete", ".agents"]
      }).action
    ).toBe("delete");
  });

  it("promotes project facts and structured learning entries", () => {
    expect(
      classifyMemoryQuality({
        summary: "org-brain | project-fact | production D1 is source of truth",
        content: "# Project Fact\n\n## Result\nproduction D1 is source of truth",
        tags: ["openclaw", "hook", "learning-loop", "project-fact", "org-brain"]
      })
    ).toMatchObject({ action: "promote", reason: "structured-project-fact" });
  });

  it("keeps project facts that are already curated semantic memories", () => {
    expect(
      classifyMemoryQuality({
        summary: "org-brain | project-fact | production D1 is source of truth",
        content: "# Project Fact\n\n## Result\nproduction D1 is source of truth",
        tags: ["openclaw", "hook", "learning-loop", "project-fact", "curated-memory", "org-brain"],
        kind: "semantic",
        lifecycle_state: "active"
      })
    ).toMatchObject({ action: "keep", reason: "structured-project-fact-ready" });
  });

  it("keeps reusable diagnosis or command-result memories", () => {
    expect(
      classifyMemoryQuality({
        summary: "org-brain | promoted-memory | 原因は Cloudflare OAuth ログイン未完了でした。",
        content:
          "原因は Cloudflare OAuth ログイン未完了でした。対処として `wrangler login` を実行し、`wrangler whoami` の成功を確認しました。",
        tags: ["codex", "hook", "promoted", "diagnosis", "org-brain"]
      })
    ).toMatchObject({ action: "keep", reason: "cause-and-fix" });
  });

  it("deletes vague promoted rows without concrete reuse detail", () => {
    expect(
      classifyMemoryQuality({
        summary: "smart-block | promoted-memory | 原因は特定して修正しました。",
        content: "原因は特定して修正しました。",
        tags: ["codex", "hook", "promoted", "diagnosis", "smart-block"]
      })
    ).toMatchObject({ action: "delete" });

    expect(
      classifyMemoryQuality({
        summary: "omopay | promoted-memory | 実行結果です。",
        content: "実行結果です。",
        tags: ["codex", "hook", "promoted", "policy", "omopay"]
      })
    ).toMatchObject({ action: "delete", reason: "meta-only-title" });
  });

  it("deletes generated rollups so they can be rebuilt from high-quality rows", () => {
    expect(
      classifyMemoryQuality({
        summary: "org-brain | canonical-memory | policy | 8 stable summaries",
        content: "# Canonical Memory Map",
        tags: ["org-brain", "maintenance", "canonical-memory"]
      })
    ).toMatchObject({ action: "delete", reason: "generated-rollup" });
  });

  it("deletes count-only quality-v2 rollups", () => {
    expect(
      classifyMemoryQuality({
        summary: "org-brain | canonical-memory | policy | 8 stable summaries",
        content: "# Canonical Memory Map",
        tags: ["org-brain", "maintenance", "canonical-memory", "quality-v2"]
      })
    ).toMatchObject({ action: "delete", reason: "count-only-rollup" });
  });

  it("keeps concrete quality-v2 rollups generated after cleanup", () => {
    expect(
      classifyMemoryQuality({
        summary: "org-brain | policy | deployment requires cap-runner and api-gateway",
        content: "# Canonical Memory Map",
        tags: ["org-brain", "maintenance", "canonical-memory", "quality-v2"]
      })
    ).toMatchObject({ action: "keep", reason: "quality-v2-rollup" });
  });
});
