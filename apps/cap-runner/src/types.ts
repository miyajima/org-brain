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
};

export type CapabilityResult = {
  outputRef: string;
  summary: string;
};

export type MailboxPushRequest = MailboxEvent;
