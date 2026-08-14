export type TaskCommitmentAnswer = {
  option_id?: string | null;
  label: string;
  raw?: string | null;
};

export type TaskCommitment = {
  record_type: "task_commitment";
  schema_version: 1;
  task_key: string;
  decision_key: string;
  question_fingerprint: string;
  question: string;
  answer: TaskCommitmentAnswer;
  authority: "explicit_user";
  confirmation_state: "user_confirmed" | "user_corrected";
  ask_policy: "reuse_until_superseded";
  scope: { level: "task"; project_id: string | null };
  evidence: { type: "request_user_input_result"; digest: string };
  semantic_aliases?: Array<{
    alias_fingerprint: string;
    question: string;
    certification: "ai_consensus_certified";
    prompt_hash: string;
    verifier_version: string;
    created_at: number;
    expires_at: number;
  }>;
  created_at?: number;
  expires_at?: number | null;
};
