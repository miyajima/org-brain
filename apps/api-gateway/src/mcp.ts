import {
  HttpError,
  sha256,
  validateMemoryContractV2Event,
  observeMemoryContractV2Event,
  observeMemoryLearningEvent,
  type OrgPermission,
  type OrgRole
} from "@org-brain/shared";
import type { Hono } from "hono";
import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse,
  type CallToolResult
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
  accessServiceSubject,
  authorizeMcpRequest,
  verifyMcpAccessAssertion,
  type McpAuthResult
} from "./mcp-security";
import { activateMcpClientInstallation } from "./mcp-client-installation-service";
import {
  ackAgentMessage,
  getAgentMessage,
  listAgentMessages,
  markAgentMessageRead,
  sendAgentMessage
} from "./agent-message-service";
import { getTask, getTaskEvents, createTask } from "./task-service";
import type { Env } from "./types";
import {
  createDecisionMemory,
  enrichContext,
  getDecisionReviewQueue,
  preActionDecisionGate,
  searchDecisionMemories
} from "./context-engine-service";
import {
  getMemoryProfile,
  listMemoriesCursorPage,
  refreshMemoryByRequest,
  retrieveMemoryContext,
  searchMemories,
  suppressMemoryByRequest,
  upsertMemories
} from "./memory-service";
import {
  captureMemoryWithInferredRationale,
  confirmProposedMemory,
  proposeMemoryWithRationale
} from "./rationale-service";
import { assertPermission } from "./rbac-service";
import { appendAuditEvent } from "./audit-service";
import { extractMemoryCandidates } from "./memory-extraction-service";
import { assertRequestRateLimit } from "./rate-limit-service";
import {
  createBusinessCategory,
  listBusinessCategories,
  updateBusinessCategory
} from "./business-category-service";
import {
  createMemoryFailurePattern,
  listMemoryFailurePatterns,
  memoryImpactReport,
  recordMemoryEffect,
  recordMemoryUsage,
  updateMemoryFailurePattern,
  updateMemoryUsageStates
} from "./memory-effect-service";
import { reportMemoryImpact, startMemoryImpact } from "./memory-impact-service";
import { getDomainContext, queryMetrics, searchManagedObjects } from "./domain-metric-service";
import { getDomainRecall, recordDomainRecallFeedback } from "./domain-recall-service";
import { ingestVerifiedKnowledgeBundle } from "./verified-ingestion-service";
import {
  getDecisionResources,
  getResourceDecisions,
  searchKnowledgeResources
} from "./resource-decision-service";
import {
  getTaskCommitmentContext,
  ingestLearningContractBatch
} from "./memory-contract-service";

type AgentProps = {
  tenantId: string;
  principal: string;
  allowedTenants: string[];
  defaultRole: OrgRole;
  authSource?: McpAuthResult["source"];
  runtimeActor?: string;
  clientInstallationId?: string;
  clientType?: string;
  clientPurpose?: string;
  ownerPrincipal?: string;
  allowedTools?: string[];
};

const sourceRefSchema = z.object({
  type: z.string().max(64).optional(),
  id: z.string().max(128).optional(),
  title: z.string().max(240).optional(),
  url: z.string().max(512).optional(),
  updatedAt: z.string().max(64).optional(),
  allowedPrincipals: z.array(z.string().min(1).max(128)).max(64).optional()
});

const ownerRefSchema = z.object({
  type: z.string().max(64).optional(),
  id: z.string().max(128).optional(),
  name: z.string().max(128).optional()
});

const agentMessageTargetTypeSchema = z.enum(["principal", "agent", "project", "channel"]);
const agentMessageStatusSchema = z.enum(["unread", "read", "acked", "archived", "active"]);

const contextEnrichInputShape = {
  tenant_id: z.string().optional(),
  project_id: z.string().nullable().optional(),
  user_id: z.string().max(128).optional(),
  agent_id: z.string().max(128).optional(),
  agent_key: z.string().max(128).optional(),
  task_type: z.enum(["implementation", "review", "debug", "proposal", "support"]).optional(),
  task: z.object({
    title: z.string().max(240).optional(),
    description: z.string().max(2000).optional(),
    target_files: z.array(z.string().max(256)).max(32).optional(),
    related_issue_ids: z.array(z.string().max(128)).max(32).optional()
  }),
  max_tokens: z.number().int().min(500).max(32000).optional(),
  include_sources: z.boolean().optional(),
  include_conflicts: z.boolean().optional(),
  debug_scores: z.boolean().optional(),
  include_domain_recall: z.boolean().optional(),
  domain_recall_max_tokens: z.number().int().min(256).max(8_000).optional(),
  object_type_key: z.string().max(128).nullable().optional(),
  object_id: z.string().max(128).nullable().optional(),
  scope: z.record(z.string(), z.string().max(256)).optional()
};
const contextEnrichInputSchema = z.object(contextEnrichInputShape);
type ContextEnrichInput = z.infer<typeof contextEnrichInputSchema>;

function toContent(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

type ToolHandler<Shape extends z.ZodRawShape> = (
  args: z.output<z.ZodObject<Shape>>
) => CallToolResult | Promise<CallToolResult>;

const MCP_TOOL_DESCRIPTIONS: Record<string, string> = {
  orgbrain_prompt_recall: "Use before answering an organization-specific question. Return the relevant Decision, rationale, rejected alternatives, constraints, success conditions, metrics, evidence metadata, follow-up, and trace URL. If the answer uses the memory, cite the trace and invite the user to say 範囲が違う, 古い, or 関係ない.",
  orgbrain_domain_recall_feedback: "Record the user's correction without mutating the underlying Decision. Map 範囲が違う to wrong_scope, 古い to outdated, 関係ない to not_relevant, 関係が違う to incorrect_relation, and この会話では使わない to dismiss_for_session. Call this when the user corrects a recalled memory."
};

function registerTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  inputShape: Shape,
  handler: ToolHandler<Shape>
) {
  return server.registerTool(
    name,
    { ...(MCP_TOOL_DESCRIPTIONS[name] ? { description: MCP_TOOL_DESCRIPTIONS[name] } : {}), inputSchema: z.object(inputShape) },
    handler
  );
}

function normalizeTenant(tenantInput: string | undefined, props: AgentProps | undefined): string {
  if (!props) {
    throw new HttpError(500, "misconfigured", "missing MCP auth context");
  }
  const requested = tenantInput?.trim();
  if (!requested) return props.tenantId;
  if (!props.allowedTenants.includes(requested)) {
    throw new HttpError(403, "forbidden", `tenant not allowed: ${requested}`);
  }
  return requested;
}

async function requireMcpPermission(
  env: Env,
  props: AgentProps,
  tenantId: string,
  permission: OrgPermission,
  projectId?: string | null
) {
  const principal = props.principal;
  if (!principal) throw new HttpError(500, "misconfigured", "missing MCP principal");
  try {
    return await assertPermission(env, {
      tenantId,
      projectId,
      principal,
      permission,
      fallbackRole: props.defaultRole
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error(JSON.stringify({
      event: "mcp_permission_failed",
      auth_source: props.authSource ?? "unknown",
      permission,
      has_project_scope: Boolean(projectId),
      error_code: error instanceof HttpError ? error.code : null,
      error_status: error instanceof HttpError ? error.status : null,
      error_message: failure.message
        .replace(/[A-Za-z0-9_-]{24,}/gu, "[REDACTED]")
        .slice(0, 300)
    }));
    throw error;
  }
}

class OrgBrainMcpTools {
  server = new McpServer(
    {
      name: "OrgBrain MCP",
      version: "2.0.0"
    },
    {
      instructions:
        "Search OrgBrain before repeating source discovery. Use propose then confirm for interactive memory writes.",
      cacheHints: {
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
        "tools/list": { ttlMs: 300_000, cacheScope: "private" }
      }
    }
  );

  constructor(
    readonly env: Env,
    readonly props: AgentProps
  ) {}

  async requirePermission(
    tenantId: string,
    permission: OrgPermission,
    projectId?: string | null
  ) {
    return requireMcpPermission(this.env, this.props, tenantId, permission, projectId);
  }

  async auditedMutation<T>(
    tenantId: string,
    action: string,
    resourceType: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const principal = this.props?.principal ?? "mcp";
    try {
      const result = await operation();
      await appendAuditEvent(this.env, {
        tenantId,
        projectId: null,
        principal,
        action,
        resourceType,
        resourceId: null,
        requestId: null,
        outcome: "succeeded",
        metadata: {
          transport: "mcp",
          auth_source: this.props.authSource ?? "unknown",
          runtime_actor: this.props.runtimeActor ?? principal,
          client_installation_id: this.props.clientInstallationId ?? null,
          client_type: this.props.clientType ?? null
        }
      });
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      console.error(JSON.stringify({
        event: "mcp_audited_mutation_failed",
        action,
        error_name: failure.name,
        error_code: error instanceof HttpError ? error.code : null,
        error_status: error instanceof HttpError ? error.status : null,
        error_message: failure.message
          .replace(/[A-Za-z0-9_-]{24,}/gu, "[REDACTED]")
          .slice(0, 300)
      }));
      await appendAuditEvent(this.env, {
        tenantId,
        projectId: null,
        principal,
        action,
        resourceType,
        resourceId: null,
        requestId: null,
        outcome: "failed",
        metadata: {
          transport: "mcp",
          auth_source: this.props.authSource ?? "unknown",
          runtime_actor: this.props.runtimeActor ?? principal,
          client_installation_id: this.props.clientInstallationId ?? null,
          client_type: this.props.clientType ?? null
        }
      }).catch(() => undefined);
      throw error;
    }
  }

  async init() {
    const workTypeSchema = z.enum([
      "implementation", "review", "debug", "proposal",
      "support", "research", "operations", "other"
    ]);
    const captureEvidenceSchema = z.object({
      evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"]).optional(),
      evidence_ref: z.string().min(1).max(512),
      relation: z.enum(["supports", "contradicts", "context_for"]).optional(),
      note: z.string().max(500).nullable().optional(),
      weight_score: z.number().min(0).max(1).optional(),
      content_hash: z.string().max(128).nullable().optional(),
      diff_hash: z.string().max(128).nullable().optional(),
      observed_at: z.number().int().nullable().optional(),
      attestation_ref: z.string().max(512).nullable().optional()
    });
    const captureRationaleItemSchema = z.object({
      external_key: z.string().min(1).max(256),
      content: z.string().min(1).max(20000),
      summary: z.string().max(1000).optional(),
      tags: z.array(z.string().min(1).max(64)).max(16).optional(),
      created_at: z.number().int().optional(),
      project_id: z.string().max(128).nullable().optional(),
      business_category_id: z.string().max(128).nullable().optional(),
      work_type: workTypeSchema.nullable().optional(),
      canonical_key: z.string().min(1).max(256).nullable().optional(),
      kind: z.enum(["decision", "constraint", "pitfall", "preference", "fact"]).optional(),
      rationale: z.string().max(4000).nullable().optional(),
      reuse_rule: z.string().max(1000).nullable().optional(),
      evidence: z.array(captureEvidenceSchema).max(8).optional(),
      source_references: z.array(z.object({
        type: z.string().min(1).max(80),
        ref: z.string().min(1).max(512),
        title: z.string().max(240).optional(),
        captured_at: z.number().int().optional()
      })).max(32).optional(),
      source_refs: z.array(z.object({
        type: z.string().min(1).max(80),
        ref: z.string().min(1).max(512),
        title: z.string().max(240).optional(),
        captured_at: z.number().int().optional()
      })).max(32).optional(),
      valid_until: z.number().int().nullable().optional(),
      confidence_score: z.number().min(0).max(1).nullable().optional(),
      utility_score: z.number().min(0).max(1).nullable().optional(),
      visibility: z.enum(["tenant", "project", "restricted"]).optional(),
      allowed_principals: z.array(z.string().min(1).max(128)).max(64).optional()
      , capture_origin: z.enum(["observed", "synthetic", "repair", "legacy"]).optional()
      , capture_route: z.enum(["realtime_hook", "initial_import", "manual", "repair", "legacy"]).optional()
      , capture_batch_id: z.string().max(128).nullable().optional()
      , verification: z.object({
        state: z.enum(["verified", "partial", "unverified", "rejected"]).optional(),
        verified_at: z.number().int().nullable().optional(),
        attestation_ref: z.string().max(512).nullable().optional()
      }).optional()
      , learning: z.record(z.string(), z.unknown()).nullable().optional()
      , quality_dimensions: z.record(z.string(), z.number().min(0).max(100)).nullable().optional()
    });
    const learningEventShape = {
      schema_version: z.union([z.literal(1), z.literal(2)]),
      lesson_type: z.enum(["success", "decision", "failure"]),
      kind: z.enum(["decision", "constraint", "pitfall", "preference", "fact"]).optional(),
      trigger: z.string().max(1000).nullable().optional(),
      conclusion: z.string().max(1000).nullable().optional(),
      rationale: z.string().max(2000).nullable().optional(),
      reuse_rule: z.string().max(1000).nullable().optional(),
      outcome: z.string().max(1000).nullable().optional(),
      applicability: z.object({
        target_files: z.array(z.string().min(1).max(512)).max(16),
        components: z.array(z.string().min(1).max(128)).max(16)
      }).optional(),
      evidence_selectors: z.array(z.object({
        type: z.enum(["command", "file", "doc", "user_statement", "tool_result"]),
        ref: z.string().max(1000).optional(),
        digest: z.string().max(128).optional(),
        supports: z.array(z.string().max(128)).max(12).optional()
      })).max(16).optional(),
      gaps: z.array(z.string().min(1).max(500)).max(16).optional(),
      record_type: z.literal("learning_observation").optional(),
      capture_intent: z.enum(["verify", "review"]).optional(),
      procedure: z.string().max(2000).nullable().optional(),
      why_it_worked: z.string().max(2000).nullable().optional(),
      observed_outcome: z.string().max(1000).nullable().optional(),
      reuse_when: z.string().max(1000).nullable().optional(),
      decision_type: z.enum(["user_choice", "preference", "implementation", "governance"]).optional(),
      decision_key: z.string().max(160).nullable().optional(),
      question: z.string().max(1000).nullable().optional(),
      selected_value: z.string().max(1000).nullable().optional(),
      decision: z.string().max(1000).nullable().optional(),
      constraints: z.array(z.string().max(500)).max(16).optional(),
      alternatives: z.array(z.union([
        z.string().min(1).max(1000),
        z.object({
          alternative: z.string().max(1000),
          reason_rejected: z.string().max(1000).nullable().optional()
        })
      ])).max(16).optional(),
      symptom: z.string().max(1000).nullable().optional(),
      failed_approach: z.string().max(1500).nullable().optional(),
      root_cause: z.string().max(2000).nullable().optional(),
      correction: z.string().max(2000).nullable().optional(),
      verified_outcome: z.string().max(1000).nullable().optional(),
      avoidance_rule: z.string().max(1000).nullable().optional()
    };
    registerTool(this.server,
      "orgbrain_memory_observe",
      learningEventShape,
      async (event) => {
        if (event.schema_version === 2 && !validateMemoryContractV2Event(event)) {
          throw new HttpError(400, "memory_contract_schema_invalid", "memory contract v2 observation does not match the shared schema");
        }
        return toContent(await (event.schema_version === 2
          ? observeMemoryContractV2Event(event, { sensitivePolicy: { mode: "deny", allowed_principals: [] } })
          : observeMemoryLearningEvent(event, { sensitivePolicy: { mode: "deny", allowed_principals: [] } })));
      }
    );

    registerTool(this.server,
      "orgbrain_task_context_get",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional(),
        task_key: z.string().min(1).max(256),
        query: z.string().max(1000).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        return toContent(await getTaskCommitmentContext(this.env, { tenant_id: tenantId, ...payload }));
      }
    );

    const taskCommitmentInput = z.object({
      record_type: z.literal("task_commitment").optional(),
      schema_version: z.literal(1).optional(),
      project_id: z.string().max(128).nullable().optional(),
      task_key: z.string().min(1).max(256),
      decision_key: z.string().min(1).max(160),
      question_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/iu),
      question: z.string().min(1).max(1000),
      answer: z.object({
        option_id: z.string().max(160).nullable().optional(),
        label: z.string().min(1).max(500),
        raw: z.string().max(500).nullable().optional()
      }),
      authority: z.literal("explicit_user").optional(),
      confirmation_state: z.enum(["user_confirmed", "user_corrected"]).optional(),
      ask_policy: z.literal("reuse_until_superseded").optional(),
      evidence: z.object({
        type: z.literal("request_user_input_result"),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/iu)
      }),
      created_at: z.number().int().optional(),
      expires_at: z.number().int().nullable().optional()
    });
    registerTool(this.server,
      "orgbrain_learning_batch_ingest",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional(),
        task_key: z.string().max(256).nullable().optional(),
        source: z.string().max(64).optional(),
        prompt_contract_id: z.string().max(128).optional(),
        prompt_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/iu).optional(),
        contract_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/iu).optional(),
        verifier_version: z.string().max(128).optional(),
        commitments: z.array(taskCommitmentInput).max(16).optional(),
        verified_items: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
        deterministically_verified_items: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
        review_candidates: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
        quarantine_candidates: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
        semantic_aliases: z.array(z.object({
          project_id: z.string().max(128).nullable().optional(),
          task_key: z.string().min(1).max(256),
          decision_key: z.string().min(1).max(160),
          question: z.string().min(1).max(1000),
          ai_certification: z.literal("ai_consensus_certified"),
          judge_consensus: z.record(z.string(), z.unknown())
        })).max(16).optional()
      },
      async ({ tenant_id, commitments, verified_items, deterministically_verified_items, review_candidates, quarantine_candidates, semantic_aliases, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        if ((verified_items ?? []).length > 0) await this.requirePermission(tenantId, "memory:attest", payload.project_id);
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_learning_batch_ingest",
          "memory_learning_contract",
          () => ingestLearningContractBatch(this.env, {
            tenant_id: tenantId,
            commitments,
            verified_items,
            deterministically_verified_items,
            review_candidates,
            quarantine_candidates,
            semantic_aliases,
            ...payload
          }, { tenantId, principal: this.props.principal })
        ));
      }
    );
    registerTool(this.server, 
      "orgbrain_business_categories_list",
      {
        tenant_id: z.string().optional(),
        include_inactive: z.boolean().optional()
      },
      async ({ tenant_id, include_inactive }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        return toContent(await listBusinessCategories(this.env, tenantId, include_inactive));
      }
    );

    registerTool(this.server, 
      "orgbrain_business_categories_create",
      {
        tenant_id: z.string().optional(),
        slug: z.string().min(1).max(64),
        label: z.string().min(1).max(160),
        description: z.string().max(1000).nullable().optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_business_categories_create",
          "business_category",
          () => createBusinessCategory(this.env, tenantId, payload)
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_business_categories_update",
      {
        tenant_id: z.string().optional(),
        category_id: z.string().min(1).max(128),
        slug: z.string().min(1).max(64).optional(),
        label: z.string().min(1).max(160).optional(),
        description: z.string().max(1000).nullable().optional(),
        is_active: z.boolean().optional()
      },
      async ({ tenant_id, category_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_business_categories_update",
          "business_category",
          () => updateBusinessCategory(this.env, tenantId, category_id, payload)
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_list",
      {
        tenant_id: z.string().optional(),
        source: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().max(512).optional(),
        view: z.enum(["full", "compact"]).optional()
      },
      async ({ tenant_id, source, limit, cursor, view }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        const memories = await listMemoriesCursorPage(this.env, tenantId, {
          limit: limit ?? (view === "compact" ? 500 : 100),
          source,
          cursor,
          view
        });
        return toContent(memories);
      }
    );

    registerTool(this.server,
      "orgbrain_memory_commit_verified",
      {
        tenant_id: z.string().optional(),
        bundle: z.record(z.string(), z.unknown())
      },
      async ({ tenant_id, bundle }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        const projectId = typeof bundle.project_id === "string" ? bundle.project_id : null;
        await this.requirePermission(tenantId, "write", projectId);
        await this.requirePermission(tenantId, "memory:attest", projectId);
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_commit_verified",
          "verified_ingestion_manifest",
          () => ingestVerifiedKnowledgeBundle(this.env, tenantId, bundle, this.props.principal, {
            publishAuthorized: true,
            allowShadow: false
          })
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_extract",
      {
        tenant_id: z.string().optional(),
        event_id: z.string().min(1).max(128),
        project_id: z.string().max(128).nullable().optional(),
        source: z.string().min(1).max(64),
        occurred_at: z.number().int(),
        text: z.string().min(1).max(100_000),
        source_references: z.array(z.object({
          type: z.string().min(1).max(64),
          ref: z.string().min(1).max(512),
          title: z.string().max(240).optional(),
          captured_at: z.number().int().optional()
        })).max(32).optional()
      },
      async ({ tenant_id, ...event }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", event.project_id);
        return toContent(await extractMemoryCandidates(this.env, {
          ...event,
          tenant_id: tenantId,
          actor_type: "principal",
          actor_id: this.props?.principal ?? "mcp"
        }));
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_propose",
      {
        tenant_id: z.string().optional(),
        source: z.string().optional(),
        actor_type: z.string().optional(),
        actor_id: z.string().optional(),
        item: z.object({
          external_key: z.string().max(256).optional(),
          content: z.string().min(1).max(20000),
          summary: z.string().max(1000).optional(),
          tags: z.array(z.string().min(1).max(64)).max(16).optional(),
          created_at: z.number().int().optional(),
          project_id: z.string().max(128).nullable().optional(),
          business_category_id: z.string().max(128).nullable().optional(),
          work_type: workTypeSchema.nullable().optional()
        }),
        entities: z.array(z.object({
          name: z.string().min(1).max(128),
          entity_type: z.enum(["person", "service", "project", "team", "org", "document", "unknown"]).optional(),
          role: z.enum(["subject", "author", "decision_maker", "reviewer", "mentioned"]).optional(),
          confidence_score: z.number().optional(),
          external_ref: z.string().max(256).nullable().optional()
        })).max(8).optional(),
        evidence: z.array(z.object({
          evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"]).optional(),
          evidence_ref: z.string().min(1).max(512),
          relation: z.enum(["supports", "contradicts", "context_for"]).optional(),
          note: z.string().max(500).nullable().optional(),
          weight_score: z.number().optional()
        })).max(8).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.item.project_id);
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_propose",
          "memory",
          () => proposeMemoryWithRationale(this.env, { tenant_id: tenantId, ...payload })
        );
        return toContent(result);
      }
    );

    registerTool(this.server,
      "orgbrain_memories_capture_rationale",
      {
        tenant_id: z.string().optional(),
        source: z.string().min(1).max(64).optional(),
        item: captureRationaleItemSchema.optional(),
        items: z.array(captureRationaleItemSchema).min(1).max(3).optional()
      },
      async ({ tenant_id, source, item, items }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        if (Boolean(item) === Boolean(items)) {
          throw new HttpError(400, "invalid_payload", "exactly one of item or items is required");
        }
        const captureItems = items ?? (item ? [item] : []);
        for (const projectId of new Set(captureItems.map((entry) => entry.project_id ?? null))) {
          await this.requirePermission(tenantId, "write", projectId);
          if (captureItems.some((entry) => entry.project_id === projectId && entry.verification?.state === "verified")) {
            await this.requirePermission(tenantId, "memory:attest", projectId);
          }
        }
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_capture_rationale",
          "memory",
          () => captureMemoryWithInferredRationale(this.env, {
            tenant_id: tenantId,
            source: source?.trim() || "hook",
            actor_type: "principal",
            actor_id: this.props.principal,
            ...(item ? { item } : { items })
          }, { canAttest: captureItems.some((entry) => entry.verification?.state === "verified") })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_confirm",
      {
        tenant_id: z.string().optional(),
        confirmation_token: z.string().min(1).max(64),
        approved: z.boolean(),
        conclusion: z.string().max(240).optional(),
        reason_summary: z.string().max(500).optional(),
        decision_type: z.enum(["adopt", "reject", "prioritize", "diagnose", "workaround", "policy"]).optional(),
        status: z.string().max(64).optional(),
        entities: z.array(z.object({
          name: z.string().min(1).max(128),
          entity_type: z.enum(["person", "service", "project", "team", "org", "document", "unknown"]).optional(),
          role: z.enum(["subject", "author", "decision_maker", "reviewer", "mentioned"]).optional(),
          confidence_score: z.number().optional(),
          external_ref: z.string().max(256).nullable().optional()
        })).max(8).optional(),
        evidence: z.array(z.object({
          evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"]).optional(),
          evidence_ref: z.string().min(1).max(512),
          relation: z.enum(["supports", "contradicts", "context_for"]).optional(),
          note: z.string().max(500).nullable().optional(),
          weight_score: z.number().optional()
        })).max(8).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_confirm",
          "memory",
          () => confirmProposedMemory(this.env, { tenant_id: tenantId, ...payload })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_upsert",
      {
        tenant_id: z.string().optional(),
        source: z.string().optional(),
        items: z
          .array(
            z.object({
              external_key: z.string().min(1).max(256),
              content: z.string().min(1).max(20000),
              summary: z.string().max(1000).optional(),
              tags: z.array(z.string().min(1).max(64)).max(16).optional(),
              created_at: z.number().int().optional(),
              project_id: z.string().max(128).nullable().optional(),
              business_category_id: z.string().max(128).nullable().optional(),
              work_type: workTypeSchema.nullable().optional()
            })
          )
          .min(1)
          .max(200)
      },
      async ({ tenant_id, source, items }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", items[0]?.project_id);
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_upsert",
          "memory",
          () => upsertMemories(this.env, {
            tenant_id: tenantId,
            source: source?.trim() || "openclaw",
            items
          }, { actorPrincipal: this.props?.principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional(),
        q: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(50).optional(),
        rewrite_query: z.boolean().optional(),
        search_mode: z.enum(["memories", "hybrid", "hybrid_v2", "hybrid_v3", "hybrid_v4"]).optional(),
        retrieval_profile: z.enum(["default", "lexical", "hybrid", "structured"]).optional(),
        search_scope: z.enum(["evidence", "governance", "both"]).optional(),
        include_history: z.boolean().optional(),
        entity_id: z.string().optional(),
        entity_role: z.string().optional(),
        decision_type: z.string().optional(),
        decision_status: z.string().optional(),
        confirmation_state: z.string().optional(),
        reason_text: z.string().max(240).optional(),
        generation_id: z.string().max(128).nullable().optional(),
        ranking_profile_id: z.string().max(128).nullable().optional(),
        task_id: z.string().max(128).nullable().optional(),
        trace_id: z.string().max(128).nullable().optional(),
        external_run_id: z.string().max(256).nullable().optional()
      },
      async ({ tenant_id, project_id, q, limit, rewrite_query, search_mode, retrieval_profile, search_scope, business_category_id, work_type, include_history, entity_id, entity_role, decision_type, decision_status, confirmation_state, reason_text, generation_id, ranking_profile_id, task_id, trace_id, external_run_id }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, generation_id || ranking_profile_id ? "admin" : "read", project_id);
        const request = {
          tenant_id: tenantId,
          project_id,
          business_category_id,
          work_type,
          q,
          limit,
          rewrite_query,
          search_mode,
          retrieval_profile,
          include_history,
          entity_id,
          entity_role,
          decision_type,
          decision_status,
          confirmation_state,
          reason_text,
          generation_id,
          ranking_profile_id,
          task_id,
          trace_id,
          external_run_id
        };
        if (search_scope === "governance") {
          return toContent(await searchDecisionMemories(this.env, request, { principal: this.props?.principal }));
        }
        const evidence = await searchMemories(this.env, request, {
          actorPrincipal: this.props?.principal,
          recordUsage: search_scope !== "both"
        });
        if (search_scope !== "both") return toContent(evidence);
        const governance = await searchDecisionMemories(this.env, request, {
          principal: this.props?.principal,
          recordUsage: false
        });
        const queryHash = await sha256(q);
        const governanceResults = governance.results as Array<Record<string, unknown>>;
        const usage = await recordMemoryUsage(this.env, {
          tenant_id: tenantId,
          project_id: project_id ?? undefined,
          task_id: task_id ?? undefined,
          trace_id: trace_id ?? undefined,
          external_run_id: external_run_id ?? undefined,
          capability: "memory_search_both",
          access_path: "search",
          request_source: "mcp",
          query_hash: queryHash,
          requested_business_category_id: business_category_id ?? null,
          requested_work_type: work_type ?? null,
          retrieval_generation_id: evidence.meta.retrieval?.generation_id === governance.meta.retrieval.generation_id
            ? evidence.meta.retrieval?.generation_id
            : null,
          ranking_profile_id: evidence.meta.retrieval?.ranking_profile_id === governance.meta.retrieval.ranking_profile_id
            ? evidence.meta.retrieval?.ranking_profile_id
            : null,
          actor_principal: this.props?.principal ?? null,
          items: [
            ...evidence.results.filter((item) => item.kind === "memory").map((item, index) => ({
              source_type: "memory" as const,
              source_id: item.id,
              source_version: item.current_version ?? null,
              rank: index + 1,
              score: item.score,
              reference_type: "returned" as const,
              used_state: "unknown" as const
            })),
            ...governanceResults.flatMap((item, index) => typeof item.id === "string" ? [{
              source_type: "decision_memory" as const,
              source_id: item.id,
              rank: index + 1,
              score: typeof (item.score as Record<string, unknown> | undefined)?.finalScore === "number"
                ? Number((item.score as Record<string, unknown>).finalScore)
                : null,
              reference_type: "returned" as const,
              used_state: "unknown" as const
            }] : [])
          ]
        });
        return toContent({
          search_scope: "both",
          governance,
          evidence,
          meta: {
            usage_id: usage.usage_id,
            verification_sampled: usage.verification_sampled,
            channel_usage_ids: {
              evidence: usage.usage_id,
              governance: usage.usage_id
            }
          }
        });
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_retrieve_context",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional(),
        q: z.string().min(1).max(500),
        top_k: z.number().int().min(1).max(50).optional(),
        token_budget: z.number().int().min(512).max(16000).optional(),
        search_mode: z.enum(["hybrid_v3", "hybrid_v4"]).optional()
      },
      async ({ tenant_id, project_id, business_category_id, work_type, q, top_k, token_budget, search_mode }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        return toContent(await retrieveMemoryContext(this.env, {
          tenant_id: tenantId,
          project_id,
          business_category_id,
          work_type,
          q,
          top_k,
          token_budget,
          search_mode
        }, { actorPrincipal: this.props?.principal }));
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_profile",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional(),
        q: z.string().min(1).max(500).optional(),
        limit_durable: z.number().int().min(1).max(16).optional(),
        limit_recent: z.number().int().min(1).max(16).optional(),
        rewrite_query: z.boolean().optional(),
        search_mode: z.enum(["memories", "hybrid", "hybrid_v2", "hybrid_v3", "hybrid_v4"]).optional()
      },
      async ({ tenant_id, project_id, business_category_id, work_type, q, limit_durable, limit_recent, rewrite_query, search_mode }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        const result = await getMemoryProfile(this.env, {
          tenant_id: tenantId,
          project_id,
          business_category_id,
          work_type,
          q,
          limit_durable,
          limit_recent,
          rewrite_query,
          search_mode
        }, { actorPrincipal: this.props?.principal });
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_context_enrich",
      contextEnrichInputShape,
      async ({ tenant_id, user_id, agent_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        const result = await enrichContext(this.env, {
          tenant_id: tenantId,
          user_id: user_id ?? principal,
          agent_id: agent_id ?? principal,
          ...payload
        }, { principal });
        if (payload.include_domain_recall !== true) return toContent(result);
        const recall = await getDomainRecall(this.env, {
          tenant_id: tenantId,
          project_id: payload.project_id,
          query: [payload.task?.title, payload.task?.description].filter(Boolean).join(" "),
          object_type_key: payload.object_type_key,
          object_id: payload.object_id,
          scope: payload.scope
        }, {
          ownerPrincipal: this.props.ownerPrincipal ?? principal,
          runtimeActor: this.props.runtimeActor,
          clientInstallationId: this.props.clientInstallationId,
          clientName: this.props.clientType ?? "mcp"
        });
        return toContent({ ...result, domainRecall: recall.inject ? recall.bundle : null, domainRecallMeta: { mode: recall.mode, injected: recall.inject } });
      }
    );

    registerTool(this.server, 
      "orgbrain_context_pre_action_gate",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        task_type: z.enum(["implementation", "review", "debug", "proposal", "support"]).optional(),
        task: z.object({
          title: z.string().max(240).optional(),
          description: z.string().max(2000).optional(),
          target_files: z.array(z.string().max(256)).max(32).optional()
        }),
        minimum_confidence: z.number().min(0).max(1).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        return toContent(await preActionDecisionGate(
          this.env,
          { tenant_id: tenantId, ...payload },
          { principal: this.props?.principal ?? "mcp" }
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_decision_review_queue",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        within_days: z.number().int().min(1).max(365).optional(),
        limit: z.number().int().min(1).max(100).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        return toContent(await getDecisionReviewQueue(
          this.env,
          { tenant_id: tenantId, ...payload },
          { principal: this.props?.principal ?? "mcp" }
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_decision_memories_create",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        domain: z.enum(["engineering", "sales", "cs", "ops", "finance", "general"]).optional(),
        title: z.string().min(1).max(240),
        decision: z.string().min(1).max(1000),
        rationale: z.string().min(1).max(2000),
        rejected_alternatives: z.array(z.object({
          alternative: z.string().min(1).max(500),
          reasonRejected: z.string().min(1).max(500)
        })).max(16).optional(),
        constraints: z.array(z.string().min(1).max(500)).max(32).optional(),
        known_pitfalls: z.array(z.string().min(1).max(500)).max(32).optional(),
        source_refs: z.array(sourceRefSchema).max(16).optional(),
        owner_refs: z.array(ownerRefSchema).max(16).optional(),
        valid_from: z.union([z.string(), z.number()]).nullable().optional(),
        valid_until: z.union([z.string(), z.number()]).nullable().optional(),
        status: z.enum(["active", "deprecated", "superseded", "uncertain"]).optional(),
        superseded_by: z.string().max(128).nullable().optional(),
        confidence: z.number().min(0).max(1).optional(),
        visibility: z.enum(["tenant", "project", "restricted"]).optional(),
        allowed_principals: z.array(z.string().min(1).max(128)).max(64).optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_decision_memories_create",
          "decision_memory",
          () => createDecisionMemory(this.env, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_decision_memories_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        q: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        user_id: z.string().max(128).optional(),
        agent_id: z.string().max(128).optional(),
        business_category_id: z.string().max(128).nullable().optional(),
        work_type: workTypeSchema.nullable().optional(),
        generation_id: z.string().max(128).nullable().optional(),
        ranking_profile_id: z.string().max(128).nullable().optional()
      },
      async ({ tenant_id, user_id, agent_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(
          tenantId,
          payload.generation_id || payload.ranking_profile_id ? "admin" : "read",
          payload.project_id
        );
        const principal = this.props?.principal ?? "mcp";
        const result = await searchDecisionMemories(this.env, {
          tenant_id: tenantId,
          user_id: user_id ?? principal,
          agent_id: agent_id ?? principal,
          ...payload
        }, { principal });
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memory_failure_patterns_list",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional()
      },
      async ({ tenant_id, project_id }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        return toContent(await listMemoryFailurePatterns(this.env, tenantId, project_id));
      }
    );

    const failurePatternSchema = {
      tenant_id: z.string().optional(),
      project_id: z.string().max(128).nullable().optional(),
      business_category_id: z.string().max(128).nullable().optional(),
      work_type: z.enum(["implementation", "review", "debug", "proposal", "support", "research", "operations", "other"]).nullable().optional(),
      pattern_key: z.string().min(1).max(128).optional(),
      label: z.string().min(1).max(240).optional(),
      action_fingerprint: z.string().max(128).nullable().optional(),
      failure_fingerprint: z.string().max(128).nullable().optional(),
      is_active: z.boolean().optional()
    };
    registerTool(this.server, 
      "orgbrain_memory_failure_pattern_create",
      { ...failurePatternSchema, pattern_key: z.string().min(1).max(128), label: z.string().min(1).max(240) },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_failure_pattern_create",
          "memory_failure_pattern",
          () => createMemoryFailurePattern(this.env, tenantId, payload)
        ));
      }
    );
    registerTool(this.server, 
      "orgbrain_memory_failure_pattern_update",
      { pattern_id: z.string().min(1).max(128), ...failurePatternSchema },
      async ({ tenant_id, pattern_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_failure_pattern_update",
          "memory_failure_pattern",
          () => updateMemoryFailurePattern(this.env, tenantId, pattern_id, payload)
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_memory_usage_state_update",
      {
        tenant_id: z.string().optional(),
        usage_event_id: z.string().min(1).max(128),
        items: z.array(z.object({
          usage_item_id: z.string().min(1).max(128),
          used_state: z.enum(["used", "not_used", "unknown"])
        })).min(1).max(128)
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_usage_state_update",
          "memory_usage",
          () => updateMemoryUsageStates(this.env, tenantId, payload)
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_memory_effect_record",
      {
        tenant_id: z.string().optional(),
        usage_event_id: z.string().min(1).max(128),
        idempotency_key: z.string().min(1).max(256),
        evidence_level: z.enum(["reported", "estimated", "verified", "unverifiable"]).optional(),
        supersedes_effect_id: z.string().max(128).nullable().optional(),
        effect_outcome: z.enum(["positive", "neutral", "negative", "unknown"]),
        avoided_lookup_categories: z.array(
          z.enum(["source_search", "web_search", "past_context", "none"])
        ).max(4).optional(),
        gross_saved_tokens_estimate: z.number().int().optional(),
        token_estimation_candidates: z.object({
          paired_control_tokens: z.number().optional(),
          safe_replay_tokens: z.number().optional(),
          avoided_source_tokens: z.number().optional(),
          failure_pattern_median_tokens: z.number().optional(),
          category_median_tokens: z.number().optional(),
          text_size_heuristic_tokens: z.number().optional()
        }).optional(),
        injected_tokens: z.number().int().min(0).optional(),
        net_saved_tokens_estimate: z.number().int().optional(),
        estimate_lower_bound: z.number().int().nullable().optional(),
        estimate_upper_bound: z.number().int().nullable().optional(),
        estimation_method: z.string().max(128).nullable().optional(),
        estimator_version: z.string().max(64).nullable().optional(),
        estimate_confidence: z.number().min(0).max(1).nullable().optional(),
        failure_pattern_id: z.string().max(128).nullable().optional(),
        failure_opportunity_state: z.enum(["applicable", "not_applicable", "unknown"]).optional(),
        action_changed: z.boolean().optional(),
        alternative_executed: z.boolean().optional(),
        failure_avoided: z.boolean().optional(),
        failure_saved_tokens_estimate: z.number().int().optional(),
        verification_ref_type: z.string().max(64).nullable().optional(),
        verification_ref_id: z.string().max(256).nullable().optional(),
        estimated_tool_calls_saved: z.number().nullable().optional(),
        estimated_seconds_saved: z.number().nullable().optional(),
        attributions: z.array(z.object({
          usage_item_id: z.string().min(1).max(128),
          attribution_weight: z.number().positive().max(1)
        })).max(64).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        return toContent(await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_effect_record",
          "memory_effect",
          () => recordMemoryEffect(this.env, tenantId, { tenant_id: tenantId, ...payload })
        ));
      }
    );

    registerTool(this.server, 
      "orgbrain_memory_impact_metrics",
      {
        tenant_id: z.string().optional(),
        group_by: z.enum(["memory", "business_category", "work_type", "project", "day"]).optional()
      },
      async ({ tenant_id, group_by }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        return toContent(await memoryImpactReport(this.env, tenantId, { group_by }));
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_refresh",
      {
        tenant_id: z.string().optional(),
        memory_id: z.string().min(1),
        confidence_delta: z.number().optional()
      },
      async ({ tenant_id, memory_id, confidence_delta }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_refresh",
          "memory",
          () => refreshMemoryByRequest(this.env, {
            tenant_id: tenantId,
            memory_id,
            confidence_delta,
            actor_type: "principal",
            actor_id: this.props?.principal ?? null
          }, { actorPrincipal: this.props?.principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memories_suppress",
      {
        tenant_id: z.string().optional(),
        memory_id: z.string().min(1),
        reason: z.string().min(1).max(500)
      },
      async ({ tenant_id, memory_id, reason }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_suppress",
          "memory",
          () => suppressMemoryByRequest(this.env, {
            tenant_id: tenantId,
            memory_id,
            reason,
            actor_type: "principal",
            actor_id: this.props?.principal ?? null
          }, { actorPrincipal: this.props?.principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_messages_send",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        target_type: agentMessageTargetTypeSchema,
        target_key: z.string().min(1).max(256),
        subject: z.string().max(500).nullable().optional(),
        body: z.string().min(1).max(20_000),
        metadata: z.record(z.string(), z.unknown()).optional(),
        thread_id: z.string().min(1).max(128).optional(),
        reply_to_message_id: z.string().min(1).max(128).optional(),
        idempotency_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_messages_send",
          "agent_message",
          () => sendAgentMessage(this.env, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_handoff_send",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        target_type: agentMessageTargetTypeSchema,
        target_key: z.string().min(1).max(256),
        summary: z.string().min(1).max(4_000),
        decisions: z.array(z.object({
          id: z.string().max(128).optional(),
          decision: z.string().min(1).max(2_000),
          rationale: z.string().max(4_000).optional(),
          source_references: z.array(sourceRefSchema).max(32).optional()
        })).max(32).optional(),
        unresolved: z.array(z.string().min(1).max(1_000)).max(32).optional(),
        next_actions: z.array(z.string().min(1).max(1_000)).max(32).optional(),
        idempotency_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, project_id, target_type, target_key, summary, decisions = [], unresolved = [], next_actions = [], idempotency_key }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write", project_id);
        const principal = this.props?.principal ?? "mcp";
        const body = [
          "# Agent handoff",
          "",
          summary,
          "",
          "## Decisions",
          ...(decisions.length > 0
            ? decisions.map((item) => `- ${item.decision}${item.rationale ? ` — ${item.rationale}` : ""}`)
            : ["- None recorded"]),
          "",
          "## Unresolved",
          ...(unresolved.length > 0 ? unresolved.map((item) => `- ${item}`) : ["- None"]),
          "",
          "## Next actions",
          ...(next_actions.length > 0 ? next_actions.map((item) => `- ${item}`) : ["- None"])
        ].join("\n");
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_handoff_send",
          "agent_handoff",
          () => sendAgentMessage(this.env, {
            tenant_id: tenantId,
            project_id,
            target_type,
            target_key,
            subject: "Agent handoff package",
            body,
            metadata: {
              schema: "orgbrain-handoff-v1",
              decisions,
              unresolved,
              next_actions
            },
            idempotency_key
          }, { principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_messages_inbox",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().nullable().optional(),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional(),
        status: agentMessageStatusSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.number().int().positive().optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        const result = await listAgentMessages(this.env, {
          tenant_id: tenantId,
          ...payload
        }, { principal });
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_messages_get",
      {
        tenant_id: z.string().optional(),
        message_id: z.string().min(1),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, message_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        const principal = this.props?.principal ?? "mcp";
        const result = await getAgentMessage(this.env, tenantId, message_id, {
          tenant_id: tenantId,
          ...payload
        }, { principal });
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_messages_read",
      {
        tenant_id: z.string().optional(),
        message_id: z.string().min(1),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, message_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_messages_read",
          "agent_message",
          () => markAgentMessageRead(this.env, tenantId, message_id, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_messages_ack",
      {
        tenant_id: z.string().optional(),
        message_id: z.string().min(1),
        target_type: agentMessageTargetTypeSchema.optional(),
        target_key: z.string().min(1).max(256).optional()
      },
      async ({ tenant_id, message_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_messages_ack",
          "agent_message",
          () => ackAgentMessage(this.env, tenantId, message_id, {
            tenant_id: tenantId,
            ...payload
          }, { principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memory_impact_start",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().optional(),
        task_id: z.string().optional(),
        trace_id: z.string().optional(),
        external_run_id: z.string().min(1).max(256),
        idempotency_key: z.string().min(1).max(256),
        agent_name: z.string().min(1).max(256).optional(),
        model: z.string().min(1).max(256).optional(),
        occurred_at: z.number().int().nonnegative().optional()
      },
      async (payload) => {
        const tenantId = normalizeTenant(payload.tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_impact_start",
          "memory_impact_execution",
          () => startMemoryImpact(this.env, tenantId, { ...payload, tenant_id: tenantId }, principal)
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_memory_impact_report",
      {
        tenant_id: z.string().optional(),
        external_run_id: z.string().min(1).max(256),
        idempotency_key: z.string().min(1).max(256),
        outcome: z.enum(["assessed", "failed"]).optional(),
        memory_used: z.boolean().optional(),
        avoided_lookup: z.enum(["source_search", "web_search", "past_context", "none"]).optional(),
        memory_basis_ids: z.array(z.string().min(1).max(256)).max(20).optional(),
        confidence: z.enum(["low", "medium", "high"]).nullable().optional(),
        failure_category: z.enum(["agent_error", "tool_error", "cancelled", "unknown"]).optional(),
        occurred_at: z.number().int().nonnegative().optional()
      },
      async ({ tenant_id, external_run_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "write");
        const principal = this.props?.principal ?? "mcp";
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_impact_report",
          "memory_impact_execution",
          () => reportMemoryImpact(this.env, tenantId, external_run_id, { ...payload, tenant_id: tenantId }, principal)
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_task_create",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().optional(),
        capability: z.enum(["memory_measurement", "skill_generation"]),
        input_ref: z.string().min(1),
        priority: z.number().int().min(0).max(10).optional(),
        trace_id: z.string().optional(),
        wait_event_type: z.string().optional(),
        idempotency_key: z.string().optional()
      },
      async (payload) => {
        const tenantId = normalizeTenant(payload.tenant_id, this.props);
        await this.requirePermission(tenantId, "write", payload.project_id);
        const result = await this.auditedMutation(
          tenantId,
          "mcp.orgbrain_task_create",
          "task",
          () => createTask(this.env, {
            ...payload,
            tenant_id: tenantId
          }, { actorPrincipal: this.props?.principal })
        );
        return toContent(result);
      }
    );

    registerTool(this.server, 
      "orgbrain_task_get",
      {
        tenant_id: z.string().optional(),
        task_id: z.string().min(1)
      },
      async ({ tenant_id, task_id }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        const task = await getTask(this.env, tenantId, task_id);
        return toContent(task);
      }
    );

    registerTool(this.server, 
      "orgbrain_task_events",
      {
        tenant_id: z.string().optional(),
        task_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.number().int().optional()
      },
      async ({ tenant_id, task_id, limit, cursor }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        const events = await getTaskEvents(this.env, tenantId, task_id, limit ?? 50, cursor);
        return toContent(events);
      }
    );

    registerTool(this.server, 
      "orgbrain_resource_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(256).nullable().optional(),
        q: z.string().min(1).max(512),
        limit: z.number().int().min(1).max(100).optional()
      },
      async ({ tenant_id, ...payload }) => {
        if (this.env.KNOWLEDGE_RESOURCE_INGESTION_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Feature is not enabled");
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        const principal = this.props?.principal ?? "mcp";
        return toContent(await searchKnowledgeResources(this.env, {
          tenant_id: tenantId,
          ...payload
        }, { principal, projectId: payload.project_id ?? null }));
      }
    );

    registerTool(this.server, 
      "orgbrain_resource_decisions",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(256).nullable().optional(),
        resource_id: z.string().min(1).max(256)
      },
      async ({ tenant_id, project_id, resource_id }) => {
        if (this.env.DECISION_RESOURCE_LINKS_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Feature is not enabled");
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        const principal = this.props?.principal ?? "mcp";
        return toContent(await getResourceDecisions(this.env, tenantId, resource_id, {
          principal,
          projectId: project_id ?? null
        }));
      }
    );

    registerTool(this.server, 
      "orgbrain_decision_resources",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(256).nullable().optional(),
        source_type: z.enum(["decision_memory", "decision_rationale"]),
        source_id: z.string().min(1).max(256)
      },
      async ({ tenant_id, project_id, source_type, source_id }) => {
        if (this.env.DECISION_RESOURCE_LINKS_ENABLED !== "true") throw new HttpError(404, "feature_disabled", "Feature is not enabled");
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        const principal = this.props?.principal ?? "mcp";
        return toContent(await getDecisionResources(this.env, tenantId, {
          source_type,
          source_id
        }, { principal, projectId: project_id ?? null }));
      }
    );

    registerTool(this.server,
      "orgbrain_domain_context",
      {
        tenant_id: z.string().optional(),
        object_id: z.string().min(1).max(128).optional(),
        metric_key: z.string().min(1).max(128).optional(),
        decision_id: z.string().min(1).max(128).optional()
      },
      async ({ tenant_id, object_id, metric_key, decision_id }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        return toContent(await getDomainContext(this.env, tenantId, {
          objectId: object_id,
          metricKey: metric_key,
          decisionId: decision_id
        }));
      }
    );

    registerTool(this.server,
      "orgbrain_managed_object_search",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional(),
        q: z.string().max(256).optional(),
        type_key: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(200).optional()
      },
      async ({ tenant_id, project_id, q, type_key, limit }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", project_id);
        return toContent(await searchManagedObjects(this.env, tenantId, {
          projectId: project_id,
          q,
          typeKey: type_key,
          limit
        }));
      }
    );

    registerTool(this.server,
      "orgbrain_metric_query",
      {
        tenant_id: z.string().optional(),
        metric_keys: z.array(z.string().min(1).max(128)).max(100).optional(),
        scope_id: z.string().max(128).nullable().optional(),
        limit: z.number().int().min(1).max(500).optional()
      },
      async ({ tenant_id, metric_keys, scope_id, limit }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        return toContent(await queryMetrics(this.env, tenantId, {
          metricKeys: metric_keys,
          scopeId: scope_id,
          limit
        }));
      }
    );

    registerTool(this.server,
      "orgbrain_prompt_recall",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional(),
        query: z.string().min(1).max(4_000),
        object_type_key: z.string().max(128).nullable().optional(),
        object_id: z.string().max(128).nullable().optional(),
        scope: z.record(z.string(), z.string().max(256)).optional(),
        session_id: z.string().max(256).nullable().optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read", payload.project_id);
        if (this.props.clientPurpose === "recall" && (this.env.DOMAIN_RECALL_HOOK_MODE ?? "off") === "off") {
          throw new HttpError(404, "domain_recall_hook_disabled", "Domain Recall hook access is disabled");
        }
        return toContent(await getDomainRecall(this.env, { tenant_id: tenantId, ...payload }, {
          ownerPrincipal: this.props.ownerPrincipal ?? this.props.principal,
          runtimeActor: this.props.runtimeActor,
          clientInstallationId: this.props.clientInstallationId,
          clientName: this.props.clientType ?? "mcp"
        }));
      }
    );

    registerTool(this.server,
      "orgbrain_domain_recall_feedback",
      {
        tenant_id: z.string().optional(),
        recall_id: z.string().min(1).max(256),
        candidate_id: z.string().max(256).nullable().optional(),
        feedback: z.enum(["useful", "not_relevant", "wrong_scope", "outdated", "incorrect_relation", "dismiss_for_session"]),
        session_id: z.string().max(256).nullable().optional(),
        note: z.string().max(2_000).nullable().optional()
      },
      async ({ tenant_id, recall_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, this.props);
        await this.requirePermission(tenantId, "read");
        return toContent(await recordDomainRecallFeedback(this.env, tenantId, recall_id, payload, {
          ownerPrincipal: this.props.ownerPrincipal ?? this.props.principal,
          runtimeActor: this.props.runtimeActor,
          clientInstallationId: this.props.clientInstallationId,
          clientName: this.props.clientType ?? "mcp"
        }));
      }
    );

  }
}

export async function createOrgBrainMcpServer(env: Env, props: AgentProps) {
  const tools = new OrgBrainMcpTools(env, props);
  await tools.init();
  return tools.server;
}

type ContextEnrichJsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: {
    name?: unknown;
    arguments?: unknown;
  };
};

function isContextEnrichJsonRpcRequest(value: unknown): value is ContextEnrichJsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as ContextEnrichJsonRpcRequest;
  return body.jsonrpc === "2.0" &&
    Object.prototype.hasOwnProperty.call(body, "id") &&
    body.method === "tools/call" &&
    body.params?.name === "orgbrain_context_enrich";
}

async function tryHandleModernCatalogFastPath(
  request: Request,
  env: Env,
  props: AgentProps
): Promise<Response | null> {
  if (request.method !== "POST" || request.headers.get("mcp-protocol-version") !== "2026-07-28") return null;
  const body = await request.clone().json<ContextEnrichJsonRpcRequest>().catch(() => null);
  if (!body || body.jsonrpc !== "2.0" || !Object.prototype.hasOwnProperty.call(body, "id")) return null;
  if (body.method === "server/discover") {
    return jsonRpcResult(body.id, {
      supportedVersions: ["2026-07-28"],
      ttlMs: 300_000,
      cacheScope: "private"
    });
  }
  if (body.method !== "tools/list") return null;

  const server = await createOrgBrainMcpServer(env, props);
  const registry = server as unknown as {
    _registeredTools: Record<string, {
      title?: string;
      description?: string;
      outputSchemaJson?: unknown;
      annotations?: unknown;
      icons?: unknown;
      _meta?: unknown;
      enabled?: boolean;
    }>;
    _toolInputSchemaJson: Record<string, unknown>;
  };
  const tools = Object.entries(registry._registeredTools)
    .filter(([name, tool]) => tool.enabled !== false && (!props.allowedTools || props.allowedTools.includes(name)))
    .map(([name, tool]) => ({
      name,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: registry._toolInputSchemaJson[name] ?? { type: "object", properties: {} },
      ...(tool.outputSchemaJson ? { outputSchema: tool.outputSchemaJson } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      ...(tool.icons ? { icons: tool.icons } : {}),
      ...(tool._meta ? { _meta: tool._meta } : {})
    }));
  return jsonRpcResult(body.id, { tools, ttlMs: 300_000, cacheScope: "private" });
}

function jsonRpcResult(id: unknown, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function degradedContextResponse(input: ContextEnrichInput, tenantId: string) {
  return {
    summary: "OrgBrain context is temporarily unavailable; continue without decision memory context.",
    decisionContext: [],
    constraints: [],
    knownPitfalls: [],
    conflicts: [],
    recommendedNextActions: ["関連する既存方針を手動で確認する"],
    confidence: 0,
    requiresHumanReview: true,
    meta: {
      tenant_id: tenantId,
      project_id: input.project_id ?? null,
      task_type: input.task_type ?? "implementation",
      selectedMemoryCount: 0,
      conflictCount: 0,
      featureFlags: {
        includeProvenance: false,
        authorityScoring: false,
        verificationView: false
      },
      estimatedTokens: 0,
      degraded: true,
      degraded_reason: "context_unavailable"
    }
  };
}

function mcpTransportValidationResponse(request: Request): Response | undefined {
  const requestUrl = new URL(request.url);
  const localEndpoint = localhostAllowedHostnames().includes(requestUrl.hostname);
  const workersDevEndpoint = requestUrl.hostname.endsWith(".workers.dev");
  const acceptedHostnames = localEndpoint
    ? localhostAllowedHostnames()
    : workersDevEndpoint
      ? [requestUrl.hostname]
      : undefined;
  const hostRejection = acceptedHostnames
    ? hostHeaderValidationResponse(request, acceptedHostnames)
    : undefined;
  if (hostRejection) return hostRejection;

  const acceptedOriginHostnames = new Set(localhostAllowedOrigins());
  if (workersDevEndpoint) acceptedOriginHostnames.add(requestUrl.hostname);

  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "") {
    try {
      const originUrl = new URL(origin);
      if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
        return originValidationResponse(request, []);
      }
    } catch {
      // Delegate malformed Origin handling, including the SDK-compatible body,
      // to the public helper below.
    }
  }
  return originValidationResponse(request, [...acceptedOriginHostnames]);
}

async function tryHandleContextEnrichFastPath(
  request: Request,
  env: Env,
  props: AgentProps
): Promise<Response | null> {
  if (request.method !== "POST") return null;

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  if (!isContextEnrichJsonRpcRequest(body)) return null;
  if (request.headers.get("mcp-name") !== "orgbrain_context_enrich") return null;

  const parsed = contextEnrichInputSchema.safeParse(body.params?.arguments);
  if (!parsed.success) return null;

  const input = parsed.data;
  const tenantId = normalizeTenant(input.tenant_id, props);
  await requireMcpPermission(env, props, tenantId, "read", input.project_id);
  const principal = props.principal || "mcp";
  const { tenant_id: _tenantId, user_id, agent_id, ...payload } = input;

  try {
    const result = await enrichContext(env, {
      tenant_id: tenantId,
      user_id: user_id ?? principal,
      agent_id: agent_id ?? principal,
      ...payload
    }, { principal, bestEffortUsage: true });
    if (payload.include_domain_recall !== true) return jsonRpcResult(body.id, toContent(result));
    const recall = await getDomainRecall(env, {
      tenant_id: tenantId,
      project_id: payload.project_id,
      query: [payload.task?.title, payload.task?.description].filter(Boolean).join(" "),
      object_type_key: payload.object_type_key,
      object_id: payload.object_id,
      scope: payload.scope
    }, {
      ownerPrincipal: props.ownerPrincipal ?? principal,
      runtimeActor: props.runtimeActor,
      clientInstallationId: props.clientInstallationId,
      clientName: props.clientType ?? "mcp-fast-path"
    });
    return jsonRpcResult(body.id, toContent({ ...result, domainRecall: recall.inject ? recall.bundle : null, domainRecallMeta: { mode: recall.mode, injected: recall.inject } }));
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) throw error;
    console.warn({
      event: "orgbrain.mcp.context_enrich.degraded",
      tenant_id: tenantId,
      project_id: input.project_id ?? null,
      error_code: error instanceof HttpError ? error.code : "unknown"
    });
    return jsonRpcResult(body.id, toContent(degradedContextResponse(input, tenantId)));
  }
}

async function tryHandleHookCaptureFastPath(
  request: Request,
  env: Env,
  props: AgentProps
): Promise<Response | null> {
  if (props.authSource !== "access-service" || request.method !== "POST") return null;

  let body: ContextEnrichJsonRpcRequest;
  try {
    body = await request.clone().json<ContextEnrichJsonRpcRequest>();
  } catch {
    return null;
  }
  if (
    body.jsonrpc !== "2.0" ||
    !Object.prototype.hasOwnProperty.call(body, "id") ||
    body.method !== "tools/call" ||
    body.params?.name !== "orgbrain_memories_capture_rationale" ||
    request.headers.get("mcp-name") !== "orgbrain_memories_capture_rationale"
  ) return null;

  const args = body.params.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new HttpError(400, "invalid_payload", "capture arguments must be an object");
  }
  const payload = args as Record<string, unknown>;
  const tenantId = normalizeTenant(
    typeof payload.tenant_id === "string" ? payload.tenant_id : undefined,
    props
  );
  const item = payload.item && typeof payload.item === "object" && !Array.isArray(payload.item)
    ? payload.item as Record<string, unknown>
    : null;
  const items = Array.isArray(payload.items)
    ? payload.items.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
  if (Boolean(item) === Boolean(items.length)) {
    throw new HttpError(400, "invalid_payload", "exactly one of item or items is required");
  }
  const captureItems = item ? [item] : items;
  for (const projectId of new Set(captureItems.map((entry) =>
    typeof entry.project_id === "string" ? entry.project_id : null
  ))) {
    await requireMcpPermission(env, props, tenantId, "write", projectId);
    if (captureItems.some((entry) =>
      (typeof entry.project_id === "string" ? entry.project_id : null) === projectId &&
      entry.verification && typeof entry.verification === "object" &&
      !Array.isArray(entry.verification) &&
      (entry.verification as Record<string, unknown>).state === "verified"
    )) {
      await requireMcpPermission(env, props, tenantId, "memory:attest", projectId);
    }
  }

  const principal = props.principal || props.runtimeActor || "mcp-hook";
  try {
    const result = await captureMemoryWithInferredRationale(env, {
      ...payload,
      tenant_id: tenantId,
      source: typeof payload.source === "string" && payload.source.trim() ? payload.source.trim() : "hook",
      actor_type: "principal",
      actor_id: principal
    }, {
      canAttest: captureItems.some((entry) =>
        entry.verification && typeof entry.verification === "object" &&
        !Array.isArray(entry.verification) &&
        (entry.verification as Record<string, unknown>).state === "verified"
      )
    });
    await appendAuditEvent(env, {
      tenantId,
      projectId: null,
      principal,
      action: "mcp.orgbrain_memories_capture_rationale",
      resourceType: "memory",
      resourceId: null,
      requestId: null,
      outcome: "succeeded",
      metadata: {
        transport: "mcp-fast-path",
        auth_source: props.authSource,
        runtime_actor: props.runtimeActor ?? principal,
        client_installation_id: props.clientInstallationId ?? null,
        client_type: props.clientType ?? null
      }
    }).catch(() => undefined);
    return jsonRpcResult(body.id, toContent(result));
  } catch (error) {
    await appendAuditEvent(env, {
      tenantId,
      projectId: null,
      principal,
      action: "mcp.orgbrain_memories_capture_rationale",
      resourceType: "memory",
      resourceId: null,
      requestId: null,
      outcome: "failed",
      metadata: {
        transport: "mcp-fast-path",
        auth_source: props.authSource,
        runtime_actor: props.runtimeActor ?? principal,
        client_installation_id: props.clientInstallationId ?? null,
        client_type: props.clientType ?? null,
        error_code: error instanceof HttpError ? error.code : "capture_failed"
      }
    }).catch(() => undefined);
    throw error;
  }
}

export async function assertMcpToolAllowed(request: Request, props: AgentProps): Promise<void> {
  if (!props.allowedTools) return;
  if (request.method !== "POST") {
    throw new HttpError(403, "forbidden", "This MCP client installation can only call its allowed hook tool");
  }
  const body = await request.clone().json<{
    method?: unknown;
    params?: { name?: unknown };
  }>().catch(() => null);
  if (
    body?.method !== "tools/call" ||
    typeof body.params?.name !== "string" ||
    !props.allowedTools.includes(body.params.name)
  ) {
    throw new HttpError(403, "forbidden", "This MCP client installation cannot call that MCP method or tool");
  }
}

export function mountMcp(app: Hono<any>) {
  app.post("/mcp/client-installations/activate", async (c) => {
    try {
      const claims = await verifyMcpAccessAssertion(c.req.raw, c.env);
      const accessSubject = accessServiceSubject(claims);
      if (!accessSubject) throw new HttpError(401, "unauthorized", "A Cloudflare Access service token is required");
      const body = await c.req.json<{ enrollment_code?: unknown; client_type?: unknown }>();
      if (
        typeof body.enrollment_code !== "string" ||
        (body.client_type !== "codex" && body.client_type !== "claude" && body.client_type !== "cursor")
      ) {
        throw new HttpError(400, "invalid_payload", "enrollment_code and a valid client_type are required");
      }
      const installation = await activateMcpClientInstallation(
        c.env,
        body.enrollment_code,
        accessSubject,
        body.client_type
      );
      await appendAuditEvent(c.env, {
        tenantId: installation.tenant_id,
        principal: installation.owner_principal,
        action: "mcp.client_installation.activate",
        resourceType: "mcp_client_installation",
        resourceId: installation.id,
        outcome: "succeeded",
        metadata: {
          auth_source: "access-service",
          runtime_actor: `client:${installation.id}`,
          client_installation_id: installation.id,
          client_type: installation.client_type
        }
      }).catch((error) => {
        console.warn({
          event: "orgbrain.mcp.client_installation.audit_failed",
          client_installation_id: installation.id,
          error_code: error instanceof HttpError ? error.code : "audit_write_failed"
        });
      });
      return c.json({ ok: true, data: installation }, 200);
    } catch (error) {
      if (error instanceof HttpError) return c.text(error.message, error.status as 400);
      return c.text(error instanceof Error ? error.message : String(error), 500);
    }
  });

  app.get("/mcp/client-installations/status", async (c) => {
    try {
      const auth = await authorizeMcpRequest(c.req.raw, c.env);
      if (auth.source !== "access-service" || !auth.clientInstallationId || !auth.clientType) {
        throw new HttpError(401, "unauthorized", "A registered Cloudflare Access service token is required");
      }
      return c.json({
        ok: true,
        data: {
          id: auth.clientInstallationId,
          tenant_id: auth.tenantId,
          client_type: auth.clientType,
          purpose: auth.clientPurpose,
          runtime_actor: auth.runtimeActor
        }
      });
    } catch (error) {
      if (error instanceof HttpError) return c.text(error.message, error.status as 400);
      return c.text(error instanceof Error ? error.message : String(error), 500);
    }
  });

  app.mount("/mcp", async (request, env, ctx) => {
    try {
      const auth = await authorizeMcpRequest(request, env);
      await assertRequestRateLimit(env, {
        tenantId: auth.tenantId,
        principal: auth.principal,
        path: "/mcp"
      });
      const props: AgentProps = {
        tenantId: auth.tenantId,
        principal: auth.principal,
        allowedTenants: auth.allowedTenants,
        defaultRole: auth.defaultRole,
        authSource: auth.source,
        runtimeActor: auth.runtimeActor,
        clientInstallationId: auth.clientInstallationId,
        clientType: auth.clientType,
        clientPurpose: auth.clientPurpose,
        ownerPrincipal: auth.ownerPrincipal,
        allowedTools: auth.allowedTools
      };
      const transportValidationResponse = mcpTransportValidationResponse(request);
      if (transportValidationResponse) return transportValidationResponse;
      await assertMcpToolAllowed(request, props);
      const catalogResponse = await tryHandleModernCatalogFastPath(request, env, props);
      if (catalogResponse) return catalogResponse;
      const fastPathResponse = await tryHandleContextEnrichFastPath(request, env, props);
      if (fastPathResponse) return fastPathResponse;
      const hookCaptureResponse = await tryHandleHookCaptureFastPath(request, env, props);
      if (hookCaptureResponse) return hookCaptureResponse;
      const handler = createMcpHandler(
        () => createOrgBrainMcpServer(env, props),
        {
          route: "/",
          legacy: "stateless",
          corsOptions: false,
          authContext: { props }
        }
      );
      return handler(request, env, ctx);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      console.error(JSON.stringify({
        event: "mcp_request_failed",
        error_name: failure.name,
        error_code: error instanceof HttpError ? error.code : null,
        error_status: error instanceof HttpError ? error.status : null,
        error_message: failure.message
          .replace(/[A-Za-z0-9_-]{24,}/gu, "[REDACTED]")
          .slice(0, 300)
      }));
      if (error instanceof HttpError) {
        return new Response(error.message, { status: error.status });
      }
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  });
}
