import { sha256 } from "./hash";
import type { AgentMemoryEventV1, ExtractedMemoryCandidate, MemoryExtractionResult } from "./memory-extractor";
import {
  buildProjectCategoryIdentity,
  buildMemoryCaptureCandidateJson,
  extractDurableMemoryDrafts,
  normalizeMemoryPaths,
  screenSensitiveMemory
} from "./memory-capture-v2-runtime.mjs";

export type SensitiveMemoryPolicy = {
  mode: "deny" | "restricted_7d";
  allowed_principals: string[];
};

export type DurableMemoryKind = "fact" | "decision" | "constraint" | "pitfall" | "preference";

export type MemoryCaptureV2Options = {
  workspaceRoot?: string | null;
  sensitivePolicy?: SensitiveMemoryPolicy;
  maxCandidates?: number;
  captureProfile?: Record<string, unknown> | null;
};

export async function extractMemoryCandidatesV2(
  event: AgentMemoryEventV1,
  options: MemoryCaptureV2Options = {}
): Promise<MemoryExtractionResult> {
  const result = extractDurableMemoryDrafts(event, {
    workspace_root: options.workspaceRoot ?? null,
    sensitive_policy: options.sensitivePolicy ?? { mode: "deny", allowed_principals: [] },
    max_candidates: options.maxCandidates ?? 3,
    ...(options.captureProfile ? { capture_profile: options.captureProfile } : {})
  });
  const projectId = event.project_id?.trim() || null;
  const scopeType = projectId ? "project" as const : "tenant" as const;
  const candidates: ExtractedMemoryCandidate[] = [];
  const suppliedReferences = (event.source_references ?? []).slice(0, 32).flatMap((reference) => {
    const ref = normalizeMemoryPaths(reference.ref, options.workspaceRoot ?? null);
    const screened = screenSensitiveMemory(ref, options.sensitivePolicy ?? { mode: "deny", allowed_principals: [] });
    if (!screened.allowed || !screened.text) return [];
    return [{
      ...reference,
      ref: screened.text,
      ...(reference.title
        ? { title: normalizeMemoryPaths(reference.title, options.workspaceRoot ?? null) }
        : {})
    }];
  });
  for (const [index, draft] of result.drafts.entries()) {
    const canonicalKey = await sha256(`${event.tenant_id}\0${projectId ?? "global"}\0${draft.kind}\0${draft.canonical_text}`);
    const contentHash = await sha256(draft.content);
    candidates.push({
      candidate_id: `${event.event_id}:candidate:${index + 1}`,
      tenant_id: event.tenant_id,
      project_id: projectId,
      kind: draft.kind,
      scope_type: scopeType,
      scope_key: projectId ?? event.tenant_id,
      confirmation_state: draft.kind === "decision" || draft.kind === "constraint" ? "proposed" : "candidate",
      content: draft.content,
      summary: draft.summary,
      tags: draft.tags,
      entities: [],
      source: event.source,
      source_references: suppliedReferences.length > 0 ? suppliedReferences : draft.source_references,
      actor_type: event.actor_type?.trim() || "agent",
      actor_id: event.actor_id?.trim() || event.source,
      valid_from: draft.valid_from,
      valid_until: draft.valid_until,
      confidence_score: draft.confidence_score,
      rationale: [draft.rationale, draft.reuse_rule ? `Reuse: ${draft.reuse_rule}` : null].filter(Boolean).join("\n") || null,
      evidence: draft.evidence,
      canonical_key: canonicalKey,
      content_hash: contentHash,
      conflicts: []
    });
  }
  return {
    event_id: event.event_id,
    extractor: "durable-rules-v2",
    candidates,
    excluded: result.excluded.map((item) => ({
      reason: [
        "duplicate",
        "unsafe_instruction",
        "transient",
        "candidate_limit",
        "credential_detected",
        "sensitive_default_deny"
      ].includes(item.reason)
        ? item.reason as MemoryExtractionResult["excluded"][number]["reason"]
        : "low_signal",
      preview: item.preview ?? item.reason
    })),
    redactions: {
      secrets: result.sensitivity.counts.secrets,
      email_addresses: result.sensitivity.counts.email_addresses,
      phone_numbers: result.sensitivity.counts.phone_numbers
    },
    raw_transcript_persisted: false
  };
}

export async function deterministicProjectCategory(tenantId: string, projectId: string | null) {
  const sourceKey = `${tenantId}\0${projectId || "global"}`;
  return buildProjectCategoryIdentity(tenantId, projectId, await sha256(sourceKey));
}

export {
  buildProjectCategoryIdentity,
  buildMemoryCaptureCandidateJson,
  extractDurableMemoryDrafts,
  normalizeMemoryPaths,
  screenSensitiveMemory,
  stripMemoryUiDirectives
} from "./memory-capture-v2-runtime.mjs";
export {
  assessMemoryCaptureDraft,
  deriveMemoryCaptureHookProfile,
  enforceMemoryCaptureHookProfile,
  isVerifiableMemoryEvidence
} from "./memory-capture-profile-runtime.mjs";
export { MEMORY_CAPTURE_HOOK_PROFILE } from "./memory-capture-profile.generated.mjs";
