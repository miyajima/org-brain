export type RuntimeSensitiveMemoryPolicy = {
  mode: "deny" | "restricted_7d";
  allowed_principals: string[];
};

export type RuntimeDurableMemoryKind = "fact" | "decision" | "constraint" | "pitfall" | "preference";

export type RuntimeMemoryEvidence = {
  type: string;
  ref: string;
  note?: string;
};

export type RuntimeMemorySourceReference = {
  type: string;
  ref: string;
  captured_at?: number;
};

export type RuntimeMemoryDraft = {
  kind: RuntimeDurableMemoryKind;
  content: string;
  summary: string;
  rationale: string | null;
  reuse_rule: string | null;
  evidence: RuntimeMemoryEvidence[];
  source_references: RuntimeMemorySourceReference[];
  tags: string[];
  valid_from: number;
  valid_until: number;
  confidence_score: number;
  utility_score: number;
  canonical_text: string;
  visibility: "restricted" | "project" | "tenant";
  allowed_principals: string[];
  sensitive: boolean;
  gaps: string | null;
  quality_score?: number;
  capture_profile_id?: string;
};

export type RuntimeSensitivityResult = {
  allowed: boolean;
  hard_reject: boolean;
  reason: string | null;
  text: string;
  restricted: boolean;
  allowed_principals?: string[];
  counts: {
    secrets: number;
    email_addresses: number;
    phone_numbers: number;
    addresses: number;
    sensitive_domains: number;
  };
};

export type RuntimeMemoryExtractionResult = {
  drafts: RuntimeMemoryDraft[];
  excluded: Array<{ reason: string; preview?: string; candidate_hash?: string | null }>;
  sensitivity: RuntimeSensitivityResult;
  raw_transcript_persisted: false;
};

export const DURABLE_MEMORY_KINDS: readonly RuntimeDurableMemoryKind[];
export const MEMORY_CAPTURE_V2_MAX_CANDIDATES: number;

export function stripMemoryUiDirectives(value: unknown): string;
export function normalizeMemoryPaths(value: unknown, workspaceRoot?: string | null): string;
export function screenSensitiveMemory(value: unknown, policy?: RuntimeSensitiveMemoryPolicy): RuntimeSensitivityResult;
export function buildProjectCategoryIdentity(
  tenantId: string,
  projectId: string | null,
  digestHex: string
): {
  id: string;
  slug: string;
  label: string;
  description: string;
  source_key: string;
};
export function buildMemoryCaptureCandidateJson(record: Record<string, unknown>): Record<string, unknown>;
export function extractDurableMemoryDrafts(
  input: {
    event_id: string;
    tenant_id: string;
    project_id?: string | null;
    source: string;
    occurred_at: number;
    text: string;
  },
  options?: {
    workspace_root?: string | null;
    sensitive_policy?: RuntimeSensitiveMemoryPolicy;
    max_candidates?: number;
    capture_profile?: Record<string, unknown>;
  }
): RuntimeMemoryExtractionResult;
