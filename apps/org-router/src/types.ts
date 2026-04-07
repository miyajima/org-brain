import type { Queue } from "@cloudflare/workers-types";
import type { Envelope, TaskCreatedPayload, TaskResultPayload } from "@org-brain/shared";

type TaskEnvelope = Envelope<TaskCreatedPayload | TaskResultPayload>;

export type Env = {
  OPEN_BRAIN_DB: D1Database;
  CAP_PLAN_OUT: Queue<TaskEnvelope>;
  CAP_CODE_OUT: Queue<TaskEnvelope>;
  CAP_REVIEW_OUT: Queue<TaskEnvelope>;
};
