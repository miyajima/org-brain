import type { Queue } from "@cloudflare/workers-types";
import type { Envelope, TaskCreatedPayload, TaskResultPayload } from "@org-brain/shared";

type TaskEnvelope = Envelope<TaskCreatedPayload | TaskResultPayload>;

export type Env = {
  OPEN_BRAIN_DB: D1Database;
  OPEN_BRAIN_BUCKET: R2Bucket;
  ORG_BUS_OUT: Queue<TaskEnvelope>;
  API_KEY: string;
  API_TENANT_POLICY_JSON?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_TENANT_POLICY_JSON?: string;
  ACCESS_JWKS_JSON?: string;
  MCP_TENANT_POLICY_JSON?: string;
  MCP_ACCESS_AUD?: string;
  MCP_SERVICE_TOKENS_JSON?: string;
};
