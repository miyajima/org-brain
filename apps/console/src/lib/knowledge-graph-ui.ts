import type {
  DashboardKnowledgeCluster,
  DashboardKnowledgeEdge,
  DashboardKnowledgeGraphResponse,
  DashboardKnowledgeNode,
  DashboardNodeType
} from "@org-brain/contracts";

export type KnowledgeNodeType = DashboardNodeType;

export type KnowledgeGraphNode = Omit<DashboardKnowledgeNode, "kind" | "summary" | "updated_at"> & {
  kind: string;
  summary: string;
  updated_at: number;
  usage_count_30d_recorded: boolean;
  degree_recorded: boolean;
};

export type KnowledgeGraphEdge = DashboardKnowledgeEdge;
export type KnowledgeGraphCluster = DashboardKnowledgeCluster;

export type KnowledgeGraph = Omit<DashboardKnowledgeGraphResponse, "contract_version" | "nodes"> & {
  nodes: KnowledgeGraphNode[];
};

export type KnowledgeNodeVisualKind = "memory" | "decision" | "lesson" | "warning" | "evidence" | "project" | "task";

export type PositionedKnowledgeNode = KnowledgeGraphNode & {
  x: number;
  y: number;
  radius: number;
  selected: boolean;
  neighbor: boolean;
};

export type KnowledgeGraphCanvasSize = {
  width: number;
  height: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableText(value: unknown): string | null {
  const parsed = text(value);
  return parsed || null;
}

const NODE_TYPES = new Set<KnowledgeNodeType>(["project", "memory", "decision", "resource", "entity", "task"]);
const CLUSTER_TYPES = new Set<KnowledgeGraphCluster["kind"]>(["project", "domain", "memory_kind"]);

export function knowledgeNodeVisualKind(node: Pick<KnowledgeGraphNode, "type" | "kind" | "status">): KnowledgeNodeVisualKind {
  const signal = `${node.kind} ${node.status ?? ""}`.toLowerCase();
  if (/warning|risk|conflict|stale|failed|danger|pitfall/.test(signal)) return "warning";
  if (/lesson|learning|learned/.test(signal)) return "lesson";
  if (node.type === "project") return "project";
  if (node.type === "resource" || node.type === "entity") return "evidence";
  if (node.type === "decision") return "decision";
  if (node.type === "task") return "task";
  return "memory";
}

export function normalizeKnowledgeGraph(value: unknown): KnowledgeGraph {
  const source = record(value);
  const nodes = Array.isArray(source.nodes) ? source.nodes.map((raw): KnowledgeGraphNode | null => {
    const item = record(raw);
    const id = text(item.id);
    const type = NODE_TYPES.has(item.type as KnowledgeNodeType) ? item.type as KnowledgeNodeType : null;
    if (!id || !type) return null;
    return {
      id,
      source_id: text(item.source_id, id),
      type,
      kind: text(item.kind, type),
      label: text(item.label, id),
      summary: text(item.summary),
      project_id: nullableText(item.project_id),
      status: nullableText(item.status),
      confidence: nullableNumber(item.confidence),
      updated_at: numeric(item.updated_at),
      last_used_at: nullableNumber(item.last_used_at),
      usage_count_30d: Math.max(0, numeric(item.usage_count_30d)),
      degree: Math.max(0, numeric(item.degree)),
      usage_count_30d_recorded: item.usage_count_30d != null && item.usage_count_30d !== "",
      degree_recorded: item.degree != null && item.degree !== "",
      cluster_ids: Array.isArray(item.cluster_ids) ? item.cluster_ids.map((entry) => text(entry)).filter(Boolean) : [],
      ...(text(item.deep_link) ? { deep_link: text(item.deep_link) } : {})
    };
  }).filter((item): item is KnowledgeGraphNode => Boolean(item)) : [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(source.edges) ? source.edges.map((raw): KnowledgeGraphEdge | null => {
    const item = record(raw);
    const id = text(item.id);
    const edgeSource = text(item.source);
    const target = text(item.target);
    if (!id || !nodeIds.has(edgeSource) || !nodeIds.has(target)) return null;
    return {
      id,
      source: edgeSource,
      target,
      relation: text(item.relation, "related"),
      directed: item.directed === true,
      inferred: false,
      weight: Math.max(0, numeric(item.weight, 1)),
      confidence: nullableNumber(item.confidence)
    };
  }).filter((item): item is KnowledgeGraphEdge => Boolean(item)) : [];

  const clusters = Array.isArray(source.clusters) ? source.clusters.map((raw): KnowledgeGraphCluster | null => {
    const item = record(raw);
    const id = text(item.id);
    const kind = CLUSTER_TYPES.has(item.kind as KnowledgeGraphCluster["kind"]) ? item.kind as KnowledgeGraphCluster["kind"] : null;
    if (!id || !kind) return null;
    return {
      id,
      kind,
      label: text(item.label, id),
      node_ids: Array.isArray(item.node_ids) ? item.node_ids.map((entry) => text(entry)).filter((entry) => nodeIds.has(entry)) : []
    };
  }).filter((item): item is KnowledgeGraphCluster => Boolean(item)) : [];

  return {
    nodes,
    edges,
    clusters,
    truncated: source.truncated === true,
    omitted_node_count: Math.max(0, numeric(source.omitted_node_count))
  };
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function chooseFocusNode(nodes: KnowledgeGraphNode[], selectedId?: string | null): KnowledgeGraphNode | null {
  return nodes.find((node) => node.id === selectedId || node.source_id === selectedId)
    ?? [...nodes].sort((left, right) => right.degree - left.degree || right.usage_count_30d - left.usage_count_30d || right.updated_at - left.updated_at)[0]
    ?? null;
}

export function filterKnowledgeGraph(graph: KnowledgeGraph, type: KnowledgeNodeType | "all"): KnowledgeGraph {
  if (type === "all") return graph;
  const nodes = graph.nodes.filter((node) => node.type === type);
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    clusters: graph.clusters.map((cluster) => ({ ...cluster, node_ids: cluster.node_ids.filter((id) => ids.has(id)) })).filter((cluster) => cluster.node_ids.length > 0)
  };
}

export function knowledgeGraphCanvasSize(nodeCount: number): KnowledgeGraphCanvasSize {
  const densitySteps = Math.max(0, Math.ceil((Math.max(0, Math.floor(nodeCount)) - 30) / 30));
  return {
    width: 940 + densitySteps * 260,
    height: 720 + densitySteps * 140
  };
}

export function layoutKnowledgeGraph(
  graph: KnowledgeGraph,
  selectedId?: string | null,
  width?: number,
  height?: number
): PositionedKnowledgeNode[] {
  const focus = chooseFocusNode(graph.nodes, selectedId);
  if (!focus) return [];
  const canvas = knowledgeGraphCanvasSize(graph.nodes.length);
  const layoutWidth = width ?? canvas.width;
  const layoutHeight = height ?? canvas.height;
  const neighborIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.source === focus.id) neighborIds.add(edge.target);
    if (edge.target === focus.id) neighborIds.add(edge.source);
  }
  const focusX = layoutWidth * 0.5;
  const focusY = layoutHeight * 0.46;
  const ordered = [...graph.nodes].sort((left, right) => {
    if (left.id === focus.id) return -1;
    if (right.id === focus.id) return 1;
    const neighborDelta = Number(neighborIds.has(right.id)) - Number(neighborIds.has(left.id));
    return neighborDelta || stableHash(left.id) - stableHash(right.id);
  });
  const radialNodes = ordered.filter((node) => node.id !== focus.id);
  const ringCount = Math.max(1, Math.min(7, Math.ceil(Math.sqrt(radialNodes.length / 4.5))));
  const maximumRingX = Math.max(58, layoutWidth / 2 - 90);
  const maximumRingY = Math.max(58, Math.min(focusY - 76, layoutHeight - focusY - 90));
  const minimumRingX = Math.min(150, maximumRingX);
  const minimumRingY = Math.min(120, maximumRingY);
  const rings = Array.from({ length: ringCount }, (_, ringIndex) => {
    const progress = ringCount === 1 ? 0 : ringIndex / (ringCount - 1);
    const ringX = minimumRingX + (maximumRingX - minimumRingX) * progress;
    const ringY = minimumRingY + (maximumRingY - minimumRingY) * progress;
    const circumference = Math.PI * (3 * (ringX + ringY) - Math.sqrt((3 * ringX + ringY) * (ringX + 3 * ringY)));
    return { ringX, ringY, capacity: Math.max(6, Math.floor(circumference / 104)) };
  });
  const placement = new Map<string, { ringIndex: number; index: number; count: number }>();
  let cursor = 0;
  rings.forEach((ring, ringIndex) => {
    const remaining = radialNodes.length - cursor;
    if (remaining <= 0) return;
    const count = ringIndex === rings.length - 1 ? remaining : Math.min(remaining, ring.capacity);
    radialNodes.slice(cursor, cursor + count).forEach((node, index) => placement.set(node.id, { ringIndex, index, count }));
    cursor += count;
  });

  return ordered.map((node) => {
    const selected = node.id === focus.id;
    const neighbor = neighborIds.has(node.id);
    if (selected) return { ...node, x: focusX, y: focusY, radius: 52, selected, neighbor };
    const nodePlacement = placement.get(node.id) ?? { ringIndex: 0, index: 0, count: 1 };
    const ring = rings[nodePlacement.ringIndex];
    const angleOffset = ((stableHash(`${focus.id}:${nodePlacement.ringIndex}`) % 360) / 180) * Math.PI + nodePlacement.ringIndex * 2.399963;
    const angle = angleOffset + (Math.PI * 2 * nodePlacement.index) / nodePlacement.count;
    const x = Math.max(62, Math.min(layoutWidth - 62, focusX + Math.cos(angle) * ring.ringX));
    const y = Math.max(58, Math.min(layoutHeight - 58, focusY + Math.sin(angle) * ring.ringY));
    const base = node.type === "project" ? 25 : node.type === "memory" ? 31 : 27;
    return { ...node, x, y, radius: Math.min(40, base + Math.sqrt(node.degree + node.usage_count_30d) * 1.6), selected, neighbor };
  });
}

export function graphDeepLink(node: KnowledgeGraphNode, scope: URLSearchParams): string {
  const params = new URLSearchParams(scope);
  const withParams = (pathname: string) => params.size > 0 ? `${pathname}?${params.toString()}` : pathname;
  if (node.deep_link) {
    try {
      const target = new URL(node.deep_link, "https://console.invalid");
      const allowed = node.type === "memory"
        ? target.pathname === "/memories"
        : node.type === "decision"
          ? target.pathname === "/decisions"
          : node.type === "resource"
            ? target.pathname === "/resources"
            : node.type === "task"
              ? /^\/tasks\/[^/]+$/.test(target.pathname)
              : target.pathname === "/memories/constellation";
      if (target.origin === "https://console.invalid" && allowed) {
        for (const [key, value] of target.searchParams) params.set(key, value);
        for (const [key, value] of scope) params.set(key, value);
        return withParams(target.pathname);
      }
    } catch {
      // Fall through to a canonical Console route for invalid API-provided links.
    }
  }
  if (node.type === "memory") {
    params.set("selected", node.source_id);
    return withParams("/memories");
  }
  if (node.type === "decision") {
    params.set("selected", node.source_id);
    return withParams("/decisions");
  }
  if (node.type === "resource") {
    params.set("selected", node.source_id);
    return withParams("/resources");
  }
  if (node.type === "task") return withParams(`/tasks/${encodeURIComponent(node.source_id)}`);
  params.set("selected", node.id);
  return withParams("/memories/constellation");
}
