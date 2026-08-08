import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CONTRACT_VERSION,
  dashboardActivityQuerySchema,
  dashboardKnowledgeGraphQuerySchema,
  dashboardStrataQuerySchema
} from "../src/index";

describe("dashboard/v1 contracts", () => {
  it("applies bounded defaults", () => {
    expect(dashboardActivityQuerySchema.parse({})).toMatchObject({ limit: 100 });
    expect(dashboardKnowledgeGraphQuerySchema.parse({})).toMatchObject({
      depth: 1,
      node_limit: 80,
      edge_limit: 160
    });
    expect(dashboardStrataQuerySchema.parse({ types: "canonical,decision" })).toMatchObject({
      types: ["canonical", "decision"],
      limit: 30
    });
    expect(DASHBOARD_CONTRACT_VERSION).toBe("dashboard/v1");
  });

  it("rejects ambiguous activity cursors and oversized windows", () => {
    expect(() => dashboardActivityQuerySchema.parse({ before: "a", after: "b" })).toThrow();
    expect(() => dashboardActivityQuerySchema.parse({
      from: 0,
      to: 8 * 24 * 60 * 60 * 1000
    })).toThrow();
  });

  it("requires graph focus type and id together", () => {
    expect(() => dashboardKnowledgeGraphQuerySchema.parse({ focus_type: "memory" })).toThrow();
    expect(() => dashboardKnowledgeGraphQuerySchema.parse({ focus_id: "mem-1" })).toThrow();
    expect(dashboardKnowledgeGraphQuerySchema.parse({
      focus_type: "memory",
      focus_id: "mem-1",
      depth: "2"
    })).toMatchObject({ focus_type: "memory", focus_id: "mem-1", depth: 2 });
  });
});
