import type { CapabilityName, Envelope, TaskCreatedPayload, TaskResultPayload } from "@org-brain/shared";

type TaskEnvelope = Envelope<TaskCreatedPayload | TaskResultPayload>;

type MailboxEvent = {
  type: string;
  payload: Record<string, unknown>;
  ts?: number;
};

export type Env = {
  OPEN_BRAIN_DB: D1Database;
  OPEN_BRAIN_BUCKET: R2Bucket;
  ORG_BUS_OUT: Queue<TaskEnvelope>;
  LEASES: DurableObjectNamespace;
  MAILBOX: DurableObjectNamespace;
  /** Optional versioned autonomy policy injected by the deployment. */
  AUTONOMY_POLICY_JSON?: string;
  /** Optional managed AI council endpoint. Fail-closed when absent or unavailable. */
  AUTONOMY_JUDGE_URL?: string;
  /** Optional bearer credential for the managed AI council endpoint. */
  AUTONOMY_JUDGE_API_KEY?: string;
  /** Provider credentials are configured as Worker secrets. */
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  SKILL_GENERATION_PROVIDERS_JSON?: string;
};

export type CapabilityContext = {
  env: Env;
  tenantId: string;
  projectId?: string;
  taskId: string;
  capability: CapabilityName;
  inputRef: string;
  constraints?: Record<string, unknown>;
  measurement?: {
    runId: string;
    sessionId?: string;
    unit: "task" | "session";
    variant: "control" | "treatment";
    referenceModel: string;
    memoryEnabled: boolean;
    memoryWriteEnabled: boolean;
  };
};

export type CapabilityResult = {
  outputRef: string;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  retrievalCount: number;
  retrievedIds: string[];
};

export type MailboxPushRequest = MailboxEvent;
