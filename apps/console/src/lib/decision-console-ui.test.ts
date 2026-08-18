import { describe, expect, it } from "vitest";
import {
  decisionEditorRedirect,
  decisionIndexRedirect,
  normalizeDecisionBriefing,
  normalizeDecisionTrace
} from "./decision-console-ui";

describe("decision console UI contracts", () => {
  it("normalizes a decision briefing", () => {
    const value = normalizeDecisionBriefing({
      contract_version: "decision-console/v1",
      generated_at: 1,
      counts: { new: 1 },
      items: [{
        id: "d1", title: "Choose a durable API", decision: "Use v2", reason_summary: "Stable contract",
        status: "active", confidence: 0.9, confirmation_state: "reviewed", updated_at: 1,
        artifact_count: 1, flags: ["new"], next_action: { label: "Open", action: "open", href: "/decisions/d1" }
      }]
    });
    expect(value.items[0]?.id).toBe("d1");
    expect(value.counts.new).toBe(1);
  });

  it("rejects malformed traces", () => {
    expect(() => normalizeDecisionTrace({ nodes: "invalid", edges: [] })).toThrow();
  });

  it("preserves scope and arbitrary query parameters across the legacy redirect", () => {
    const target = decisionEditorRedirect(new URL("https://console.test/decisions?selected=d%2F1&tenant_id=t1&project_id=p1&lang=ja&q=cache"));
    expect(target).toBe("/decisions/new?tenant_id=t1&project_id=p1&lang=ja&q=cache&edit=d%2F1");
    expect(decisionIndexRedirect(new URL(
      "https://console.test/decisions?tenant_id=t1&project_id=p1&lang=ja&q=cache&view=results"
    ))).toBe("/?tenant_id=t1&project_id=p1&lang=ja&q=cache");
  });
});
