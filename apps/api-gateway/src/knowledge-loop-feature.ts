import { HttpError } from "@org-brain/shared";
import type { Env } from "./types";

export type KnowledgeLoopFeatureKey =
  | "KNOWLEDGE_PACK_ONBOARDING_MODE"
  | "ORGANIZATION_DASHBOARD_MODE"
  | "METRIC_IMPORT_MODE"
  | "RETROSPECTIVE_MODE"
  | "IMPROVEMENT_ACTIONS_MODE";

function previewWriteTenants(env: Env): Set<string> {
  const raw = env.KNOWLEDGE_LOOP_PREVIEW_WRITE_TENANTS_JSON?.trim();
  if (!raw) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(500, "misconfigured", "KNOWLEDGE_LOOP_PREVIEW_WRITE_TENANTS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !value.trim())) {
    throw new HttpError(500, "misconfigured", "KNOWLEDGE_LOOP_PREVIEW_WRITE_TENANTS_JSON must be an array of tenant ids");
  }
  return new Set(parsed.map((value) => value.trim()));
}

export function isKnowledgeLoopWritable(env: Env, key: KnowledgeLoopFeatureKey, tenantId: string): boolean {
  const mode = env[key];
  if (mode === "on") return true;
  return mode === "preview" && previewWriteTenants(env).has(tenantId);
}

export function assertKnowledgeLoopWritable(env: Env, key: KnowledgeLoopFeatureKey, tenantId: string): void {
  const mode = env[key];
  if (!mode || mode === "off") throw new HttpError(404, "feature_disabled", "This measurement feature is disabled");
  if (!isKnowledgeLoopWritable(env, key, tenantId)) {
    throw new HttpError(409, "feature_preview", "This measurement feature is in preview-only mode");
  }
}
