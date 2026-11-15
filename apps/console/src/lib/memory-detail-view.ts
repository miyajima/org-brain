import { memoryDisplayCopy } from "./dashboard-copy";

export type MemoryKind = "episodic" | "semantic" | "org_knowledge" | "fact" | "decision" | "constraint" | "pitfall" | "preference";

export type MemoryRow = {
  id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags: string[];
  source: string;
  external_key: string | null;
  created_at: number;
  kind: MemoryKind;
  lifecycle_state: "active" | "suppressed" | "consolidated" | "promoted";
  current_version: number;
  last_accessed_at: number | null;
  confidence_score: number | null;
  utility_score: number | null;
  owner_principal: string | null;
  created_by_principal: string | null;
  deleted_at: number | null;
  deleted_by_principal: string | null;
  delete_reason: string | null;
  updated_at: number | null;
  reference_count: number;
  used_count: number;
  consumer_count: number;
  net_saved_tokens: number;
  injected_tokens: number;
  capture_origin: "observed" | "synthetic" | "repair" | "legacy";
  capture_route: "realtime_hook" | "initial_import" | "manual" | "repair" | "legacy";
  capture_batch_id: string | null;
  verification_state: "verified" | "partial" | "unverified" | "rejected";
  answer_eligibility: "blocked" | "caution" | "eligible";
  attention_severity: "critical" | "warning" | "blocked" | "healthy";
  attention_reasons: string[];
  evaluated_at: number;
};

export type MemorySearchResult = {
  kind: "memory" | "doc";
  id: string;
  summary: string | null;
  content_preview: string;
  score: number | null;
  source: string;
  created_at: number;
  memory_kind?: MemoryKind;
  lifecycle_state?: "active" | "suppressed" | "consolidated" | "promoted";
  current_version?: number;
};

export type MemoryProfileItem = {
  id: string;
  project_id: string | null;
  summary: string;
  content_preview: string;
  source: string;
  created_at: number;
  tags: string[];
  memory_kind: MemoryKind;
  lifecycle_state: "active" | "suppressed" | "consolidated" | "promoted";
  current_version: number;
  last_accessed_at: number | null;
  confidence_score: number | null;
  utility_score: number | null;
};

export type MemoryDetailResponse = {
  tenant_id: string;
  memory_id: string;
  memory: {
    id: string;
    source: string;
    external_key: string | null;
    created_at: number;
    kind: MemoryKind;
    current_version: number;
    last_accessed_at: number | null;
    confidence_score: number | null;
    utility_score: number | null;
    actor_type: string | null;
    actor_id: string | null;
    owner_principal: string | null;
    created_by_principal: string | null;
    deleted_at: number | null;
    deleted_by_principal: string | null;
    delete_reason: string | null;
    project_id: string | null;
    content: string;
    summary: string | null;
    tags: string[];
    lifecycle_state: string;
    updated_at: number | null;
    reference_count: number;
    used_count: number;
    consumer_count: number;
    net_saved_tokens: number;
    injected_tokens: number;
    reuse_rule: string | null;
    capture_origin: "observed" | "synthetic" | "repair" | "legacy";
    capture_route: "realtime_hook" | "initial_import" | "manual" | "repair" | "legacy";
    capture_batch_id: string | null;
    verification_state: "verified" | "partial" | "unverified" | "rejected";
    verified_at: number | null;
    learning: Record<string, unknown> | null;
    quality_dimensions: Record<string, number> | null;
  } | null;
  versions: Array<{
    version: number;
    operation: string;
    summary: string | null;
    kind: string;
    lifecycle_state: string;
    actor_type: string | null;
    actor_id: string | null;
    created_at: number;
  }>;
  rationales: Array<{
    id: string;
    decision_type: string;
    conclusion: string;
    reason_summary: string;
    status: string;
    confirmation_state: string;
    confidence_score: number | null;
    created_at: number;
    confirmed_at: number | null;
    evidence: Array<{
      id: string;
      evidence_type: string;
      evidence_ref: string;
      relation: string;
      note: string | null;
      weight_score: number | null;
      content_hash: string | null;
      observed_at: number | null;
      attestation_ref: string | null;
    }>;
  }>;
};

type DetailRecord = {
  id: string;
  kind: "memory" | "doc";
  title: string;
  summary: string;
  preview: string;
  source: string;
  project_id: string | null;
  external_key: string | null;
  created_at: number;
  tags: string[];
  score: number | null;
  content: string;
  memory_kind: MemoryKind;
  lifecycle_state: "active" | "suppressed" | "consolidated" | "promoted";
  current_version: number;
  last_accessed_at: number | null;
  confidence_score: number | null;
  utility_score: number | null;
  owner_principal: string | null;
  created_by_principal: string | null;
  deleted_at: number | null;
  reference_count: number;
  used_count: number;
  consumer_count: number;
  net_saved_tokens: number;
  injected_tokens: number;
  answer_eligibility: "blocked" | "caution" | "eligible" | null;
  attention_severity: "critical" | "warning" | "blocked" | "healthy" | null;
  attention_reasons: string[];
  evaluated_at: number | null;
};

export function trimText(value: string | null | undefined, limit = 180): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}...`;
}

export function buildDetailRecord(
  selected: string,
  corpusItems: MemoryRow[],
  searchResults: MemorySearchResult[],
  profileItems: MemoryProfileItem[]
): DetailRecord | null {
  const row = corpusItems.find((item) => item.id === selected);
  if (row) {
    return {
      id: row.id,
      kind: "memory",
      title: memoryDisplayCopy(row.summary, row.content).title,
      summary: row.summary || "",
      preview: trimText(row.content, 320),
      source: row.source,
      project_id: row.project_id,
      external_key: row.external_key,
      created_at: row.created_at,
      tags: row.tags ?? [],
      score: searchResults.find((item) => item.id === selected)?.score ?? null,
      content: row.content,
      memory_kind: row.kind,
      lifecycle_state: row.lifecycle_state,
      current_version: row.current_version,
      last_accessed_at: row.last_accessed_at,
      confidence_score: row.confidence_score,
      utility_score: row.utility_score,
      owner_principal: row.owner_principal ?? null,
      created_by_principal: row.created_by_principal ?? null,
      deleted_at: row.deleted_at ?? null,
      reference_count: row.reference_count ?? 0,
      used_count: row.used_count ?? 0,
      consumer_count: row.consumer_count ?? 0,
      net_saved_tokens: row.net_saved_tokens ?? 0,
      injected_tokens: row.injected_tokens ?? 0,
      answer_eligibility: row.answer_eligibility,
      attention_severity: row.attention_severity,
      attention_reasons: row.attention_reasons ?? [],
      evaluated_at: row.evaluated_at
    };
  }

  const searchItem = searchResults.find((item) => item.id === selected);
  if (searchItem) {
    const profileItem = profileItems.find((item) => item.id === selected);
    return {
      id: searchItem.id,
      kind: searchItem.kind,
      title: memoryDisplayCopy(searchItem.summary, searchItem.content_preview).title,
      summary: searchItem.summary || "",
      preview: trimText(searchItem.content_preview, 320),
      source: searchItem.source,
      project_id: profileItem?.project_id ?? null,
      external_key: null,
      created_at: searchItem.created_at,
      tags: profileItem?.tags ?? [],
      score: searchItem.score,
      content: searchItem.content_preview,
      memory_kind: profileItem?.memory_kind ?? searchItem.memory_kind ?? "episodic",
      lifecycle_state: profileItem?.lifecycle_state ?? searchItem.lifecycle_state ?? "active",
      current_version: profileItem?.current_version ?? searchItem.current_version ?? 1,
      last_accessed_at: profileItem?.last_accessed_at ?? null,
      confidence_score: profileItem?.confidence_score ?? null,
      utility_score: profileItem?.utility_score ?? null
      , owner_principal: null,
      created_by_principal: null,
      deleted_at: null,
      reference_count: 0,
      used_count: 0,
      consumer_count: 0,
      net_saved_tokens: 0,
      injected_tokens: 0,
      answer_eligibility: null,
      attention_severity: null,
      attention_reasons: [],
      evaluated_at: null
    };
  }

  const profileItem = profileItems.find((item) => item.id === selected);
  if (profileItem) {
    return {
      id: profileItem.id,
      kind: "memory",
      title: memoryDisplayCopy(profileItem.summary, profileItem.content_preview).title,
      summary: profileItem.summary,
      preview: trimText(profileItem.content_preview, 320),
      source: profileItem.source,
      project_id: profileItem.project_id,
      external_key: null,
      created_at: profileItem.created_at,
      tags: profileItem.tags,
      score: null,
      content: profileItem.content_preview,
      memory_kind: profileItem.memory_kind,
      lifecycle_state: profileItem.lifecycle_state,
      current_version: profileItem.current_version,
      last_accessed_at: profileItem.last_accessed_at,
      confidence_score: profileItem.confidence_score,
      utility_score: profileItem.utility_score
      , owner_principal: null,
      created_by_principal: null,
      deleted_at: null,
      reference_count: 0,
      used_count: 0,
      consumer_count: 0,
      net_saved_tokens: 0,
      injected_tokens: 0,
      answer_eligibility: null,
      attention_severity: null,
      attention_reasons: [],
      evaluated_at: null
    };
  }

  return null;
}

export function buildDetailRecordFromMemoryDetail(payload: MemoryDetailResponse | null): DetailRecord | null {
  const memory = payload?.memory;
  if (!memory) return null;
  return {
    id: memory.id || payload?.memory_id || "",
    kind: "memory",
    title: memoryDisplayCopy(memory.summary, memory.content).title,
    summary: memory.summary || "",
    preview: trimText(memory.content, 320),
    source: memory.source || "memory",
    project_id: memory.project_id,
    external_key: memory.external_key,
    created_at: memory.created_at,
    tags: memory.tags ?? [],
    score: null,
    content: memory.content,
    memory_kind: memory.kind,
    lifecycle_state: memory.lifecycle_state as DetailRecord["lifecycle_state"],
    current_version: memory.current_version,
    last_accessed_at: memory.last_accessed_at,
    confidence_score: memory.confidence_score,
    utility_score: memory.utility_score,
    owner_principal: memory.owner_principal ?? null,
    created_by_principal: memory.created_by_principal ?? null,
    deleted_at: memory.deleted_at ?? null,
    reference_count: memory.reference_count ?? 0,
    used_count: memory.used_count ?? 0,
    consumer_count: memory.consumer_count ?? 0,
    net_saved_tokens: memory.net_saved_tokens ?? 0,
    injected_tokens: memory.injected_tokens ?? 0,
    answer_eligibility: null,
    attention_severity: null,
    attention_reasons: [],
    evaluated_at: null
  };
}

