import { describe, expect, it } from "vitest";
import { layoutKnowledgeGraph, normalizeKnowledgeGraph } from "./knowledge-graph-ui";

const NODE_COUNT = 150;
const EDGE_COUNT = 300;
const SAMPLE_COUNT = 50;
const MAX_SELECTION_P95_MS = 100;

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1);
  return ordered[index] ?? 0;
}

describe("dashboard UI performance acceptance", () => {
  it("keeps selection and deterministic layout below 100ms at the graph bounds", () => {
    const graph = normalizeKnowledgeGraph({
      nodes: Array.from({ length: NODE_COUNT }, (_, index) => ({
        id: `memory:scale-${index}`,
        source_id: `scale-${index}`,
        type: "memory",
        kind: index % 3 === 0 ? "semantic" : "episodic",
        label: `Scale memory ${index}`,
        summary: `Bounded graph node ${index}`,
        project_id: "project-dashboard-scale",
        status: "active",
        confidence: 0.8,
        updated_at: 1_800_000_000_000 - index,
        last_used_at: null,
        usage_count_30d: index % 20,
        degree: 4,
        cluster_ids: ["project:project-dashboard-scale"]
      })),
      edges: Array.from({ length: EDGE_COUNT }, (_, index) => ({
        id: `edge:${index}`,
        source: `memory:scale-${index % NODE_COUNT}`,
        target: `memory:scale-${(index + 17) % NODE_COUNT}`,
        relation: "supports",
        directed: true,
        inferred: false,
        weight: 1,
        confidence: 0.8
      })),
      clusters: [{
        id: "project:project-dashboard-scale",
        kind: "project",
        label: "Scale project",
        node_ids: Array.from({ length: NODE_COUNT }, (_, index) => `memory:scale-${index}`)
      }],
      truncated: true,
      omitted_node_count: 42
    });
    const samples: number[] = [];
    let selectedIndex = 0;
    let positioned = layoutKnowledgeGraph(graph, graph.nodes[0]?.id);

    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const selected = graph.nodes[selectedIndex % graph.nodes.length]?.id;
      selectedIndex += 1;
      const startedAt = performance.now();
      positioned = layoutKnowledgeGraph(graph, selected);
      samples.push(performance.now() - startedAt);
    }

    const p95Ms = percentile(samples, 95);
    expect(positioned).toHaveLength(NODE_COUNT);
    expect(p95Ms, `knowledge graph selection/layout p95 was ${p95Ms.toFixed(2)}ms`)
      .toBeLessThanOrEqual(MAX_SELECTION_P95_MS);
    console.info("dashboard-ui-performance", JSON.stringify({
      nodes: NODE_COUNT,
      edges: EDGE_COUNT,
      samples: SAMPLE_COUNT,
      selection_layout_p95_ms: Number(p95Ms.toFixed(3))
    }));
  });
});
