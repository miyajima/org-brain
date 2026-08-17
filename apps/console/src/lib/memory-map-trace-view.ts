import type { MemoryMapTraceRationale, MemoryMapTraceResponse } from "@org-brain/contracts";

export const TRACE_STEP_IDS = ["decision", "reason", "evidence", "artifact"] as const;

export type TraceStepId = typeof TRACE_STEP_IDS[number];
export type TraceStepState = "available" | "missing" | "unverified" | "truncated";
export type EvidenceClaimKey = "decision" | "reason" | "cause" | "verification" | "other";

export type MemoryMapTraceStage = {
  id: TraceStepId;
  state: TraceStepState;
  count: number;
};

export type MemoryMapTraceView = {
  rationale: MemoryMapTraceRationale | null;
  rationaleId: string | null;
  isFailure: boolean;
  stages: MemoryMapTraceStage[];
};

const CONFIRMED_STATES = new Set(["confirmed", "reviewed", "user_confirmed", "user_corrected"]);

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function stageState(options: {
  available: boolean;
  verified?: boolean;
  truncated?: boolean;
}): TraceStepState {
  if (!options.available) return "missing";
  if (options.verified === false) return "unverified";
  if (options.truncated) return "truncated";
  return "available";
}

export function normalizeTraceStep(value: string | null | undefined): TraceStepId {
  return TRACE_STEP_IDS.includes(value as TraceStepId) ? value as TraceStepId : "decision";
}

export function isFailureRationale(rationale: MemoryMapTraceRationale | null | undefined): boolean {
  if (!rationale) return false;
  return rationale.derived.lesson_type === "failure"
    || rationale.decision_type === "failure_prevention"
    || hasText(rationale.derived.root_cause);
}

export function buildMemoryMapTraceView(
  payload: MemoryMapTraceResponse,
  rationaleId?: string | null
): MemoryMapTraceView {
  const requestedId = rationaleId ?? payload.selected_rationale_id;
  const rationale = payload.rationales.find((item) => item.id === requestedId)
    ?? payload.rationales[0]
    ?? null;
  if (!rationale) {
    return {
      rationale: null,
      rationaleId: null,
      isFailure: false,
      stages: TRACE_STEP_IDS.map((id) => ({ id, state: "missing", count: 0 }))
    };
  }

  const derived = rationale.derived;
  const confirmed = CONFIRMED_STATES.has(rationale.confirmation_state);
  const verified = payload.memory.verification_state === "verified";
  const decisionAvailable = hasText(rationale.conclusion)
    || hasText(derived.selected_value)
    || hasText(derived.decision)
    || hasText(derived.correction);
  const reasonAvailable = hasText(rationale.reason_summary)
    || hasText(derived.rationale)
    || hasText(derived.root_cause);
  const evidenceCount = rationale.evidence.length + rationale.resources.sources.length;
  const artifactCount = rationale.resources.artifacts.length;
  const reasonCount = (reasonAvailable ? 1 : 0) + derived.alternatives.length + derived.constraints.length;

  return {
    rationale,
    rationaleId: rationale.id,
    isFailure: isFailureRationale(rationale),
    stages: [
      { id: "decision", state: stageState({ available: decisionAvailable, verified: confirmed }), count: decisionAvailable ? 1 : 0 },
      { id: "reason", state: stageState({ available: reasonAvailable, verified: confirmed }), count: reasonCount },
      { id: "evidence", state: stageState({ available: evidenceCount > 0, verified, truncated: payload.completeness.truncated }), count: evidenceCount },
      { id: "artifact", state: stageState({ available: artifactCount > 0, verified, truncated: payload.completeness.truncated }), count: artifactCount }
    ]
  };
}

export function evidenceClaimKeys(relation: string): EvidenceClaimKey[] {
  const normalized = relation.trim().toLowerCase();
  if (!normalized.startsWith("supports")) return ["other"];
  const targets = normalized.replace(/^supports\s*[:/]?\s*/u, "")
    .split(/[,+|\s]+/u)
    .filter(Boolean);
  const claims = targets.map<EvidenceClaimKey>((target) => {
    if (["decision", "conclusion", "selected_value"].includes(target)) return "decision";
    if (["rationale", "reason", "why_it_worked"].includes(target)) return "reason";
    if (["symptom", "root_cause", "cause", "failed_approach"].includes(target)) return "cause";
    if (["correction", "verified_outcome", "avoidance_rule", "outcome", "verification"].includes(target)) return "verification";
    return "other";
  });
  return [...new Set(claims.length > 0 ? claims : ["other"])] as EvidenceClaimKey[];
}
