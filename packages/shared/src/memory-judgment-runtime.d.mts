export const MEMORY_JUDGMENT_VERSION: "memory-judgment/v1";
export const MEMORY_JUDGMENT_MODEL: "typesafe/jev-1.13";
export const MEMORY_JUDGMENT_ENDPOINT: string;
export const MEMORY_CAPTURE_ASSESSMENT_VERSION: "memory-capture-assessment/v1";
export const MEMORY_JUDGMENT_THRESHOLDS: readonly number[];
export interface MemoryJudgmentCandidate {
  id: string;
  text: string;
  protected_reasons?: string[];
  conflicts?: unknown[];
  [key: string]: unknown;
}
export interface MemoryJudgmentPolicy {
  mode: "off" | "shadow" | "active";
  capture_assessment_mode: "off" | "shadow";
  threshold: number;
  model: string;
  max_request_bytes: number;
  timeout_ms: number;
  version: string;
}
export interface MemoryJudgmentDecision {
  id: string;
  action: "retain" | "review" | "omit";
  requires_review: boolean;
  reason_codes: string[];
  basis?: "prediction";
  scores?: Record<string, number>;
  duplicate_of?: string;
  capture_assessment?: MemoryCaptureAssessment;
}
export interface MemoryJudgmentChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface MemoryJudgmentScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface MemoryCaptureAssessment {
  version: "memory-capture-assessment/v1";
  mode: "shadow";
  basis: "prediction";
  applied: false;
  classification: MemoryJudgmentChoiceAnswer & {
    effective_label: "decision" | "success" | "failure" | "unknown";
    existing_label: "decision" | "success" | "failure" | null;
    matches_existing: boolean | null;
  };
  utility: MemoryJudgmentScoreAnswer & { value: number | null };
  registration: Pick<MemoryJudgmentDecision, "action" | "requires_review" | "reason_codes">;
}
export interface MemoryJudgmentResult {
  policy_version: string;
  stage: "capture" | "use";
  mode: MemoryJudgmentPolicy["mode"];
  capture_assessment_mode: "off" | "shadow";
  threshold: number;
  basis: "prediction";
  applied: boolean;
  status: "skipped" | "judged" | "fallback";
  reason_code: string | null;
  cache_hit: boolean;
  request_count: number;
  resolved_model: string | null;
  usage: Record<string, unknown> | null;
  provider_cost: number | null;
  elapsed_ms: number;
  decisions: MemoryJudgmentDecision[];
}
export interface MemoryJudgmentRequest { model: string; state: unknown; questions: Record<string, unknown> }
export interface MemoryJudgmentResponse { model: string; answers: Record<string, { type: "noul"; noul: number } | MemoryJudgmentChoiceAnswer | MemoryJudgmentScoreAnswer>; usage?: Record<string, unknown> | null }
export type MemoryJudgmentTransport = (request: MemoryJudgmentRequest, options: { signal: AbortSignal }) => Promise<MemoryJudgmentResponse>;
export function createMemoryJudge(options?: {
  transport?: MemoryJudgmentTransport;
  cache?: { get(key: string): unknown | Promise<unknown>; set(key: string, value: unknown): unknown | Promise<unknown> };
}): (input: { stage: "capture" | "use"; context?: Record<string, unknown>; candidates?: MemoryJudgmentCandidate[]; policy?: Partial<MemoryJudgmentPolicy>; active_qualified?: boolean }) => Promise<MemoryJudgmentResult>;
export function createOpenRouterMemoryTransport(options?: { apiKey?: string; fetcher?: typeof fetch }): MemoryJudgmentTransport;
export function normalizeJudgmentPolicy(input?: Partial<MemoryJudgmentPolicy>): MemoryJudgmentPolicy;
export function decideMemoryCandidate(stage: "capture" | "use", candidate: MemoryJudgmentCandidate, scores: Record<string, number>, threshold?: number): MemoryJudgmentDecision;
export function stableJudgmentJson(value: unknown): string;
export function judgmentHash(value: unknown): Promise<string>;
export function memoryJudgmentPolicyHash(threshold?: number): Promise<string>;
export function redactJudgmentValue(value: unknown): unknown;
export function validateJudgmentResponse(raw: unknown, questions: Record<string, unknown>): MemoryJudgmentResponse;
