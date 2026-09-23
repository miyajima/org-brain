export type AttemptRow = {
  id: string; tenant_id: string; project_id: string; action_key: string;
  action_label: string; attempt_type: "intervention" | "tool_result"; target: string; conditions_json: string; conditions_hash: string | null;
  outcome: "success" | "failure" | "inconclusive"; result_summary: string; change_hypothesis: string | null;
  failure_kind: "deterministic" | "transient" | "unknown" | null;
  performed_at: number; requested_by: string | null;
  executed_by_type: "principal" | "agent" | "unknown"; executed_by: string | null;
  evidence_json: string; verification_state: "verified" | "reported";
  source: string; source_key: string; supersedes_id: string | null; created_at: number;
};
export type PublicAttempt = Omit<AttemptRow, "conditions_json" | "evidence_json"> & {
  conditions: Record<string, string>;
  evidence: Array<{ ref_type: string; ref_id: string; content_hash: string }>;
  executed_by_name?: string;
  summary_ja?: string;
};
export declare const ATTEMPT_SCHEMA_SQL: string;
export declare function safeAttemptActionLabel(operation: string, tool: string, max?: number): string;
export declare function normalizeAttemptConditions(input: unknown): { conditions_json: string; conditions_hash: string | null };
export declare function normalizeAttempt(input: Record<string, unknown>, options?: { tenantId?: string; principal?: string | null; trusted?: boolean; now?: number }): AttemptRow;
export declare function normalizeAttemptUse(input: Record<string, unknown>, options?: { tenantId?: string; trusted?: boolean; now?: number }): {
  id: string; tenant_id: string; project_id: string; attempt_id: string; task_id: string | null;
  stage: "returned" | "injected" | "adopted" | "executed" | "result_checked";
  verification_state: "observed" | "reported" | "verified"; evidence_json: string; created_at: number
};
export declare function normalizeAttemptMetricEvent(input: Record<string, unknown>, options?: { tenantId?: string; trusted?: boolean; now?: number }): {
  id: string; tenant_id: string; project_id: string; kind: "context_query" | "preflight" | "feedback";
  source: string; action_key: string | null; conditions_hash: string | null;
  decision: "allow" | "warn" | "block" | null; reason: string | null;
  matched_attempt_id: string | null; related_event_id: string | null;
  feedback_verdict: "false_block" | "correct_block" | null; returned_count: number | null;
  evidence_json: string; verification_state: "observed" | "reported" | "verified"; created_at: number;
};
export declare function publicAttempt(row: AttemptRow): PublicAttempt;
export declare function attemptSummaryJa(attempt: PublicAttempt): string;
export declare function rankAttempts(rows: AttemptRow[], query?: string | null, limit?: number): PublicAttempt[];
export declare function preflightAttempt(attempts: PublicAttempt[], proposed: { action_key: string; conditions_hash: string | null; change_hypothesis?: string | null }): {
  decision: "block" | "warn" | "allow"; reason: string; prior_attempts: PublicAttempt[]
};
