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
