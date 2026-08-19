import type { Queue } from "@cloudflare/workers-types";
import type {
  Envelope,
  RetrievalProjectionJob,
  TaskCreatedPayload,
  TaskResultPayload
} from "@org-brain/shared";

type TaskEnvelope = Envelope<TaskCreatedPayload | TaskResultPayload>;

export type Env = {
  OPEN_BRAIN_DB: D1Database;
  OPEN_BRAIN_BUCKET: R2Bucket;
  ORG_BUS_OUT: Queue<TaskEnvelope>;
  RETRIEVAL_PROJECTION_QUEUE?: Queue<RetrievalProjectionJob>;
  API_KEY: string;
  CONSOLE_API_KEY?: string;
  API_TENANT_POLICY_JSON?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_TENANT_POLICY_JSON?: string;
  ACCESS_JWKS_JSON?: string;
  OIDC_ISSUER?: string;
  OIDC_AUD?: string;
  OIDC_JWKS_JSON?: string;
  OIDC_TENANT_POLICY_JSON?: string;
  EMAIL_AUTH_ENABLED?: "true" | "false";
  EMAIL_AUTH_PEPPER?: string;
  EMAIL_WEBHOOK_URL?: string;
  EMAIL_WEBHOOK_SECRET?: string;
  SESSION_ALLOWED_ORIGIN?: string;
  MCP_TENANT_POLICY_JSON?: string;
  MCP_ACCESS_AUD?: string;
  MCP_AUTH_MODE?: "legacy" | "dual" | "access";
  MCP_SERVICE_TOKENS_JSON?: string;
  MCP_SERVICE_TOKENS_ADDITIONAL_JSON?: string;
  MCP_SERVICE_TOKENS_MACHINE_JSON?: string;
  AI?: Ai;
  MEMORY_VECTOR_INDEX?: Vectorize;
  MEMORY_VECTOR_INDEX_V3?: Vectorize;
  HYBRID_V3_MODE?: "off" | "shadow" | "canary" | "on";
  HYBRID_V4_MODE?: "off" | "shadow" | "canary" | "on";
  HYBRID_V3_SHADOW_SAMPLE_RATE?: string;
  HYBRID_V4_SHADOW_SAMPLE_RATE?: string;
  HYBRID_V3_CANARY_SAMPLE_RATE?: string;
  HYBRID_V4_CANARY_SAMPLE_RATE?: string;
  ORGBRAIN_MEMORY_CAPTURE_V2_MODE?: "off" | "shadow" | "on";
  ORGBRAIN_UNCONFIRMED_DECISION_BLOCKING?: "off" | "on";
  MEMORY_CLASSIFICATION_MODE?: "observe" | "require";
  RETRIEVAL_GENERATION_ROUTING?: "legacy" | "observe" | "enforce";
  RETRIEVAL_OPERATOR_PRINCIPALS_JSON?: string;
  GEMINI_API_KEY?: string;
  RETRIEVAL_V4_EXTRACTOR_MODEL?: string;
  API_RATE_LIMITER?: RateLimit;
  API_RATE_LIMIT_FAIL_OPEN?: "true" | "false";
  KNOWLEDGE_RESOURCE_INGESTION_ENABLED?: "true" | "false";
  DECISION_RESOURCE_LINKS_ENABLED?: "true" | "false";
  RESOURCE_RELATION_EXTRACTION_ENABLED?: "true" | "false";
  KNOWLEDGE_RESOURCE_CONNECTORS_JSON?: string;
  DOMAIN_PACKS_MODE?: "off" | "catalog" | "install";
  DOMAIN_METRICS_MODE?: "off" | "shadow" | "on";
  DOMAIN_WORKSPACES_MODE?: "off" | "preview" | "on";
  RETENTION_SWEEP_MODE?: "off" | "observe" | "enforce";
  OPS_WATCHDOG_TOKEN?: string;
  OPS_ALERT_WEBHOOK_URL?: string;
};
