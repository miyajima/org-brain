import type { Queue } from "@cloudflare/workers-types";
import type { Envelope, TaskCreatedPayload, TaskResultPayload } from "@org-brain/shared";

type TaskEnvelope = Envelope<TaskCreatedPayload | TaskResultPayload>;

type WorkflowInstance = {
  sendEvent(input: {
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
};

type WorkflowBinding = {
  get(id: string): Promise<WorkflowInstance>;
};

export type Env = {
  OPEN_BRAIN_DB: D1Database;
  CAP_PLAN_OUT: Queue<TaskEnvelope>;
  CAP_CODE_OUT: Queue<TaskEnvelope>;
  CAP_REVIEW_OUT: Queue<TaskEnvelope>;
  WF_SPEC2CODE: WorkflowBinding;
};
