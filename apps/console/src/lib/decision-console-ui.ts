export type ConsoleLocale = "en" | "ja" | "zh";

export type DecisionBriefingItem = {
  id: string;
  project_id: string | null;
  title: string;
  decision: string;
  reason_summary: string;
  status: string;
  confidence: number;
  confirmation_state: string;
  valid_until: number | null;
  updated_at: number;
  artifact_count: number;
  flags: string[];
  next_action: { label: string; action: string; href: string };
};

export type DecisionBriefing = {
  contract_version: string;
  generated_at: number;
  counts: Record<string, number>;
  items: DecisionBriefingItem[];
  truncated: boolean;
};

export type DecisionTraceNode = {
  id: string;
  type: "decision" | "reason" | "evidence" | "artifact" | "skill" | "agent" | "result";
  stage: "decision" | "reason" | "evidence" | "artifact" | "skill" | "agent" | "result";
  label: string;
  summary: string | null;
  status: string | null;
  deep_link: string | null;
  metadata: Record<string, unknown>;
};

export type DecisionTraceEdge = {
  id: string;
  source: string;
  target: string;
  relation: string;
  inferred: boolean;
};

export type DecisionTrace = {
  contract_version: string;
  generated_at: number;
  decision: Record<string, unknown>;
  access_policy?: Record<string, unknown> | null;
  stages: Record<string, DecisionTraceNode[]>;
  nodes: DecisionTraceNode[];
  edges: DecisionTraceEdge[];
  truncated: boolean;
  omitted_node_count: number;
  omitted_edge_count: number;
  include_inferred: boolean;
};

export type SkillAssetSummary = {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
  status: string;
  current_version_id: string | null;
  published_version_id: string | null;
  source_decision_id: string | null;
  owner_principal: string;
  valid_until: number | null;
  generation_task_id: string | null;
  updated_at: number;
  published_at: number | null;
};

export type AgentSummary = {
  id: string;
  project_id: string | null;
  agent_key: string;
  name: string;
  role: string;
  status: string;
  current_loadout_id: string | null;
  source_decision_id: string | null;
  last_used_at: number | null;
  updated_at: number;
  loadout_name: string | null;
  binding_count: number;
};

const EMPTY_BRIEFING: DecisionBriefing = {
  contract_version: "decision-console/v1",
  generated_at: 0,
  counts: {},
  items: [],
  truncated: false
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Decision Console payload was invalid");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Decision Console payload was missing ${field}`);
  return value;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function emptyDecisionBriefing(): DecisionBriefing {
  return { ...EMPTY_BRIEFING, counts: {}, items: [] };
}

export function emptyDecisionTrace(): DecisionTrace {
  return {
    contract_version: "decision-console/v1",
    generated_at: 0,
    decision: {},
    access_policy: null,
    stages: {},
    nodes: [],
    edges: [],
    truncated: false,
    omitted_node_count: 0,
    omitted_edge_count: 0,
    include_inferred: false
  };
}

export function normalizeDecisionBriefing(value: unknown): DecisionBriefing {
  const root = record(value);
  if (!Array.isArray(root.items)) throw new Error("Decision briefing items were invalid");
  const counts = root.counts && typeof root.counts === "object" && !Array.isArray(root.counts)
    ? Object.fromEntries(Object.entries(root.counts as Record<string, unknown>).map(([key, count]) => [key, finiteNumber(count)]))
    : {};
  return {
    contract_version: typeof root.contract_version === "string" ? root.contract_version : "decision-console/v1",
    generated_at: finiteNumber(root.generated_at),
    counts,
    items: root.items.map((raw) => {
      const item = record(raw);
      const action = record(item.next_action);
      return {
        id: stringValue(item.id, "decision id"),
        project_id: typeof item.project_id === "string" ? item.project_id : null,
        title: stringValue(item.title, "decision title"),
        decision: typeof item.decision === "string" ? item.decision : "",
        reason_summary: typeof item.reason_summary === "string" ? item.reason_summary : "",
        status: typeof item.status === "string" ? item.status : "unknown",
        confidence: finiteNumber(item.confidence),
        confirmation_state: typeof item.confirmation_state === "string" ? item.confirmation_state : "unknown",
        valid_until: typeof item.valid_until === "number" ? item.valid_until : null,
        updated_at: finiteNumber(item.updated_at),
        artifact_count: finiteNumber(item.artifact_count),
        flags: Array.isArray(item.flags) ? item.flags.filter((flag): flag is string => typeof flag === "string") : [],
        next_action: {
          label: typeof action.label === "string" ? action.label : "Open",
          action: typeof action.action === "string" ? action.action : "open",
          href: typeof action.href === "string" ? action.href : `/decisions/${String(item.id)}`
        }
      };
    }),
    truncated: root.truncated === true
  };
}

export function normalizeDecisionTrace(value: unknown): DecisionTrace {
  const root = record(value);
  if (!Array.isArray(root.nodes) || !Array.isArray(root.edges)) throw new Error("Decision trace was invalid");
  const nodes = root.nodes.map((raw) => {
    const node = record(raw);
    const stage = stringValue(node.stage, "trace stage") as DecisionTraceNode["stage"];
    return {
      id: stringValue(node.id, "trace node id"),
      type: stringValue(node.type, "trace node type") as DecisionTraceNode["type"],
      stage,
      label: stringValue(node.label, "trace node label"),
      summary: typeof node.summary === "string" ? node.summary : null,
      status: typeof node.status === "string" ? node.status : null,
      deep_link: typeof node.deep_link === "string" ? node.deep_link : null,
      metadata: node.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)
        ? node.metadata as Record<string, unknown>
        : {}
    };
  });
  const edges = root.edges.map((raw) => {
    const edge = record(raw);
    return {
      id: stringValue(edge.id, "trace edge id"),
      source: stringValue(edge.source, "trace edge source"),
      target: stringValue(edge.target, "trace edge target"),
      relation: typeof edge.relation === "string" ? edge.relation : "related",
      inferred: edge.inferred === true
    };
  });
  const stages = Object.fromEntries(Object.entries(record(root.stages ?? {})).map(([stage, entries]) => [
    stage,
    Array.isArray(entries) ? entries.map((entry) => nodes.find((node) => node.id === record(entry).id)).filter(Boolean) : []
  ])) as Record<string, DecisionTraceNode[]>;
  return {
    contract_version: typeof root.contract_version === "string" ? root.contract_version : "decision-console/v1",
    generated_at: finiteNumber(root.generated_at),
    decision: record(root.decision ?? {}),
    access_policy: root.access_policy && typeof root.access_policy === "object" ? root.access_policy as Record<string, unknown> : null,
    stages,
    nodes,
    edges,
    truncated: root.truncated === true,
    omitted_node_count: finiteNumber(root.omitted_node_count),
    omitted_edge_count: finiteNumber(root.omitted_edge_count),
    include_inferred: root.include_inferred === true
  };
}

export function normalizeSkillAssets(value: unknown): SkillAssetSummary[] {
  const root = record(value);
  if (!Array.isArray(root.items)) throw new Error("Skill list was invalid");
  return root.items.map((raw) => {
    const item = record(raw);
    return {
      id: stringValue(item.id, "Skill id"),
      project_id: typeof item.project_id === "string" ? item.project_id : null,
      name: stringValue(item.name, "Skill name"),
      description: typeof item.description === "string" ? item.description : "",
      status: typeof item.status === "string" ? item.status : "draft",
      current_version_id: typeof item.current_version_id === "string" ? item.current_version_id : null,
      published_version_id: typeof item.published_version_id === "string" ? item.published_version_id : null,
      source_decision_id: typeof item.source_decision_id === "string" ? item.source_decision_id : null,
      owner_principal: typeof item.owner_principal === "string" ? item.owner_principal : "",
      valid_until: typeof item.valid_until === "number" ? item.valid_until : null,
      generation_task_id: typeof item.generation_task_id === "string" ? item.generation_task_id : null,
      updated_at: finiteNumber(item.updated_at),
      published_at: typeof item.published_at === "number" ? item.published_at : null
    };
  });
}

export function normalizeAgents(value: unknown): AgentSummary[] {
  const root = record(value);
  if (!Array.isArray(root.items)) throw new Error("Agent list was invalid");
  return root.items.map((raw) => {
    const item = record(raw);
    return {
      id: stringValue(item.id, "Agent id"),
      project_id: typeof item.project_id === "string" ? item.project_id : null,
      agent_key: stringValue(item.agent_key, "Agent key"),
      name: stringValue(item.name, "Agent name"),
      role: typeof item.role === "string" ? item.role : "",
      status: typeof item.status === "string" ? item.status : "unknown",
      current_loadout_id: typeof item.current_loadout_id === "string" ? item.current_loadout_id : null,
      source_decision_id: typeof item.source_decision_id === "string" ? item.source_decision_id : null,
      last_used_at: typeof item.last_used_at === "number" ? item.last_used_at : null,
      updated_at: finiteNumber(item.updated_at),
      loadout_name: typeof item.loadout_name === "string" ? item.loadout_name : null,
      binding_count: finiteNumber(item.binding_count)
    };
  });
}

export function decisionEditorRedirect(url: URL): string {
  const selected = url.searchParams.get("selected")?.trim();
  const params = new URLSearchParams(url.searchParams);
  params.delete("selected");
  params.delete("mode");
  params.delete("view");
  if (selected) params.set("edit", selected);
  const path = "/decisions/new";
  return params.size > 0 ? `${path}?${params.toString()}` : path;
}

export function decisionIndexRedirect(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete("mode");
  params.delete("view");
  const path = "/";
  return params.size > 0 ? `${path}?${params.toString()}` : path;
}

export function scopedHref(path: string, params: URLSearchParams): string {
  const url = new URL(path, "https://console.invalid");
  for (const key of ["tenant_id", "project_id", "lang"]) {
    const value = params.get(key)?.trim();
    if (value) url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
