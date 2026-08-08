import { describe, expect, it } from "vitest";
import { chooseFocusNode, filterKnowledgeGraph, graphDeepLink, knowledgeGraphCanvasSize, knowledgeNodeVisualKind, layoutKnowledgeGraph, normalizeKnowledgeGraph } from "./knowledge-graph-ui";

const graph = normalizeKnowledgeGraph({
  nodes: [
    { id: "m", source_id: "m", type: "memory", label: "Memory", degree: 3, usage_count_30d: 4 },
    { id: "d", source_id: "d", type: "decision", label: "Decision", degree: 1 },
    { id: "p", source_id: "p", type: "project", label: "Project", degree: 0 }
  ],
  edges: [
    { id: "e", source: "m", target: "d", relation: "supports", directed: true, inferred: false, weight: 1 },
    { id: "missing", source: "m", target: "x", relation: "bad" }
  ],
  clusters: []
});

describe("knowledge graph view model", () => {
  it("drops dangling edges and chooses the highest-signal focus", () => {
    expect(graph.edges.map((edge) => edge.id)).toEqual(["e"]);
    expect(chooseFocusNode(graph.nodes)?.id).toBe("m");
  });

  it("lays out identical data deterministically inside the viewport", () => {
    const first = layoutKnowledgeGraph(graph, "m", 900, 600);
    expect(layoutKnowledgeGraph(graph, "m", 900, 600)).toEqual(first);
    expect(first.every((node) => node.x >= 0 && node.x <= 900 && node.y >= 0 && node.y <= 600)).toBe(true);
    expect(first.find((node) => node.id === "m")?.selected).toBe(true);
  });

  it("filters both nodes and edges", () => {
    const filtered = filterKnowledgeGraph(graph, "decision");
    expect(filtered.nodes).toHaveLength(1);
    expect(filtered.edges).toHaveLength(0);
  });

  it("handles empty and single-node graphs without inventing coordinates", () => {
    expect(layoutKnowledgeGraph(normalizeKnowledgeGraph({ nodes: [], edges: [], clusters: [] }))).toEqual([]);
    const single = normalizeKnowledgeGraph({
      nodes: [{ id: "only", source_id: "only", type: "memory", label: "Only node" }],
      edges: [],
      clusters: []
    });
    expect(layoutKnowledgeGraph(single)).toMatchObject([
      { id: "only", selected: true, neighbor: false, x: 470, y: 331.2 }
    ]);
  });

  it("lays out the 150-node response cap deterministically and within bounds", () => {
    const capped = normalizeKnowledgeGraph({
      nodes: Array.from({ length: 150 }, (_, index) => ({
        id: `memory:${index}`,
        source_id: String(index),
        type: "memory",
        label: `Memory ${index}`,
        degree: index % 7,
        usage_count_30d: index % 5
      })),
      edges: [],
      clusters: []
    });
    const first = layoutKnowledgeGraph(capped, "memory:0");
    const canvas = knowledgeGraphCanvasSize(capped.nodes.length);
    expect(first).toHaveLength(150);
    expect(layoutKnowledgeGraph(capped, "memory:0")).toEqual(first);
    expect(canvas.width).toBeGreaterThan(940);
    expect(canvas.height).toBeGreaterThan(720);
    expect(first.every((node) => node.x >= 0 && node.x <= canvas.width && node.y >= 0 && node.y <= canvas.height)).toBe(true);
    const focus = first.find((node) => node.selected)!;
    const radialBands = new Set(first.filter((node) => !node.selected).map((node) => Math.round(Math.hypot(node.x - focus.x, node.y - focus.y) / 25)));
    expect(radialBands.size).toBeGreaterThan(4);
    expect(new Set(first.map((node) => `${node.x.toFixed(3)}:${node.y.toFixed(3)}`)).size).toBe(150);
  });

  it("keeps cyclic recorded edges while producing a finite deterministic layout", () => {
    const cyclic = normalizeKnowledgeGraph({
      nodes: ["a", "b", "c"].map((id) => ({ id, source_id: id, type: "memory", label: id })),
      edges: [
        { id: "ab", source: "a", target: "b", relation: "next", directed: true },
        { id: "bc", source: "b", target: "c", relation: "next", directed: true },
        { id: "ca", source: "c", target: "a", relation: "next", directed: true }
      ],
      clusters: []
    });
    const positions = layoutKnowledgeGraph(cyclic, "a");
    expect(cyclic.edges).toHaveLength(3);
    expect(positions).toHaveLength(3);
    expect(positions.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(layoutKnowledgeGraph(cyclic, "a")).toEqual(positions);
  });

  it("uses valid Console deep links and retains authoritative scope", () => {
    const scope = new URLSearchParams({ tenant_id: "acme", project_id: "project 1", lang: "ja" });
    const decision = normalizeKnowledgeGraph({
      nodes: [{
        id: "decision:d1",
        source_id: "d1",
        type: "decision",
        label: "Decision",
        deep_link: "/decision-memories/d1?tenant_id=spoofed"
      }]
    }).nodes[0];
    expect(graphDeepLink(decision, scope)).toBe("/decisions?tenant_id=acme&project_id=project+1&lang=ja&selected=d1");

    const task = { ...decision, id: "task:t 1", source_id: "t 1", type: "task" as const, deep_link: "/tasks/t%201?lang=en" };
    expect(graphDeepLink(task, scope)).toBe("/tasks/t%201?tenant_id=acme&project_id=project+1&lang=ja");
  });

  it("classifies semantic node shapes without relying on color", () => {
    expect(knowledgeNodeVisualKind({ type: "decision", kind: "decision", status: "active" })).toBe("decision");
    expect(knowledgeNodeVisualKind({ type: "memory", kind: "lesson", status: "active" })).toBe("lesson");
    expect(knowledgeNodeVisualKind({ type: "memory", kind: "pitfall", status: "active" })).toBe("warning");
    expect(knowledgeNodeVisualKind({ type: "task", kind: "task", status: "failed" })).toBe("warning");
    expect(knowledgeNodeVisualKind({ type: "resource", kind: "document", status: null })).toBe("evidence");
  });
});
