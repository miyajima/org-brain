import type { Queue } from "@cloudflare/workers-types";
import type { Envelope, TaskCreatedPayload, TaskResultPayload } from "@org-brain/shared";

type TaskEnvelope = Envelope<TaskCreatedPayload | TaskResultPayload>;

export type WorkflowBinding = {
  create(input: {
    id?: string;
    params: {
      tenant_id: string;
      project_id: string;
      spec_ref: string;
    };
  }): Promise<{ id: string }>;
  get(id: string): Promise<{
    status(): Promise<{
      status: string;
      output?: unknown;
      error?: unknown;
    }>;
  }>;
};

export type Env = {
  OPEN_BRAIN_DB: D1Database;
  OPEN_BRAIN_BUCKET: R2Bucket;
  ORG_BUS_OUT: Queue<TaskEnvelope>;
  WF_SPEC2CODE: WorkflowBinding;
  API_KEY: string;
  MCP_TENANT_POLICY_JSON?: string;
  MCP_ACCESS_AUD?: string;
  MCP_SERVICE_TOKENS_JSON?: string;
};
