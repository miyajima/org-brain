import { AMP_TOOLS } from "../../../../packages/shared/src/agent-memory-protocol.mjs";
import { HttpError, type OrgPermission, type OrgBrainOAuthScope, type OrgRole } from "@org-brain/shared";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { captureMcpToolContract, requirementForMcpTool } from "@org-brain/mcp-core";
import { type McpAuthResult } from "../mcp-security";
export type AgentProps = {
  tenantId: string;
  principal: string;
  allowedTenants: string[];
  defaultRole: OrgRole;
  authSource?: McpAuthResult["source"];
  runtimeActor?: string;
  clientInstallationId?: string;
  clientType?: string;
  recordingClient?: string;
  clientPurpose?: string;
  ownerPrincipal?: string;
  allowedTools?: string[];
  scopes?: OrgBrainOAuthScope[];
};

export const sourceRefSchema = z.object({
  type: z.string().max(64).optional(),
  id: z.string().max(128).optional(),
  title: z.string().max(240).optional(),
  url: z.string().max(512).optional(),
  updatedAt: z.string().max(64).optional(),
  allowedPrincipals: z.array(z.string().min(1).max(128)).max(64).optional()
});

export const ownerRefSchema = z.object({
  type: z.string().max(64).optional(),
  id: z.string().max(128).optional(),
  name: z.string().max(128).optional()
});

export const agentMessageTargetTypeSchema = z.enum(["principal", "agent", "project", "channel"]);

export const agentMessageStatusSchema = z.enum(["unread", "read", "acked", "archived", "active"]);

export const contextEnrichInputShape = {
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
  task_id: z.string().max(128).optional(),
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

export function toContent(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

export type ToolHandler<Shape extends z.ZodRawShape> = (
  args: z.output<z.ZodObject<Shape>>
) => CallToolResult | Promise<CallToolResult>;

export const MCP_TOOL_DESCRIPTIONS: Record<string, string> = {
  orgbrain_memories_propose: "Propose a memory for human confirmation. Use visibility private to create a new memory visible only to its owner and tenant administrators.",
  orgbrain_memories_search: "Find readable memories by title or topic. Use orgbrain_memories_retrieve_context before applying a rule found only as a title or preview. When a memory informs your work, cite its title and the recording person's name and client from recorded_by. Show unknown for missing fields.",
  orgbrain_memories_retrieve_context: "Use this before doing project work that depends on existing conventions, rules, formats, or decisions. Pass the known project_id and relevant task terms as q. Returns applicable memory text and attribution. When an evidence item informs your work, cite its title and the recording person's name and client from recorded_by. Show unknown for missing fields.",
  ...Object.fromEntries(AMP_TOOLS.map(tool => [tool.name, `Cloud private AMP, isolated by tenant, authenticated owner and project. ${tool.description}`])),
  orgbrain_wiki_ingest: "Store explicitly supplied original text in private Cloud AMP. Immutable source versions are scoped to the authenticated owner and project. Does not read local files or sync the Mac Wiki.",
  orgbrain_wiki_source_read: "Read an exact private Cloud AMP source version and line range. Tenant, owner and project are rechecked; a matching hash does not attest historical execution.",
  orgbrain_shared_knowledge_get: "Read one team share from shared_knowledge search results. The server rechecks tenant, role and publication access before returning the readable revision.",
  orgbrain_memory_use_context_record: "Record use of an existing retrieval, not a new memory. payload requires id, usage_item_id, project_id, task_id, work_type, context {task,target,constraints,conditions}, evidence [{role,ref_type,ref_id,span_start,span_end,content_hash}]. Optional supersedes_id corrects a prior context. Verification is performed by the server.",
  orgbrain_memory_use_history: "Read private use history. payload accepts source_id, project_id, limit (1-100), before (next_cursor). Returns independent retrieval/adoption/execution/outcome states, evidence, evaluations, and live validity.",
  orgbrain_memory_use_evaluate: "Record an explicit use assessment. payload requires id, context_id and either proof_id or feedback {contribution: positive|negative|unknown,statement}. Supply supersedes_id for correction, optionally effect_event_id. Verified action and outcome evidence remain necessary for any ranking contribution. Never infer usefulness from task success or consent to save.",
  orgbrain_memory_use_revoke: "Revoke an existing use. payload requires id. Invalidates its context search and ranking contributions without editing the original memory.",
  orgbrain_memories_confirmation_status: "Read the result of the same confirmation after a timeout. Never infer saved from an answer or resend an in-progress confirmation.",
  orgbrain_conversation_memories_revise: "Preview or atomically supersede one pending candidate. Execute needs the current token/hash/revision and new preview hash. Never infer approval; superseded tokens cannot save.",
  orgbrain_memories_confirmation_cancel: "Cancel an owned current pending proposal with its displayed hash/revision and explicit reason. A processing confirmation cannot be cancelled. No active memory is created.",
  orgbrain_conversation_memories_stage: "Preview or stage explicit bounded conversation-memory/v1 summaries as pending human-review proposals. Execute requires the exact preview hash. Caller-supplied roles/hashes remain unverified; this tool never saves active memory or reads transcripts. Use the existing confirm tool only after the actual human answer.",
  orgbrain_memory_quality_audit: "Run the read-only memory-quality-audit/v1 evaluator. Returns aggregate coverage, reason-code samples, and no raw memory content.",
  orgbrain_memory_feedback_report: "Report stale or wrong information for an exact memory version with evidence. Reporting does not change retrieval.",
  orgbrain_memory_feedback_review: "Confirm or reject a version-scoped report. A confirmed wrong report suppresses only the matching current memory version.",
  orgbrain_memory_relation_propose: "Propose a version-scoped contradicts or fixes relationship with evidence. Proposal alone does not change retrieval.",
  orgbrain_memory_relation_review: "Confirm, reject, or resolve a proposed relationship. Review is permission checked.",
  orgbrain_memory_integrity_issues: "List pending feedback and confirmed unresolved contradictions in a project.",
  orgbrain_memory_aging_plan: "Read-only episodic aging candidates based on verified use history. No memory is changed.",
  orgbrain_memory_extraction_enqueue: "Enqueue one review-only, same-provider/model extraction from a redacted TurnEvidenceV1 packet. The hook never calls the provider directly.",
  orgbrain_prompt_recall: "Use before answering an organization-specific question. Return the relevant Decision, rationale, rejected alternatives, constraints, success conditions, metrics, evidence metadata, follow-up, and trace URL. If the answer uses the memory, cite the trace and invite the user to say 範囲が違う, 古い, or 関係ない.",
  orgbrain_domain_recall_feedback: "Record the user's correction without mutating the underlying Decision. Map 範囲が違う to wrong_scope, 古い to outdated, 関係ない to not_relevant, 関係が違う to incorrect_relation, and この会話では使わない to dismiss_for_session. Call this when the user corrects a recalled memory."
};

export const ORGBRAIN_TOOL_PRESENTATION = {
  title: "OrgBrain",
  _meta: {
    "openai/toolInvocation/invoking": "OrgBrainを使用しています…",
    "openai/toolInvocation/invoked": "OrgBrainを使用しました"
  }
} as const;

export function registerTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  inputShape: Shape,
  handler: ToolHandler<Shape>,
  permission: OrgPermission
) {
  if (permission !== "read" && permission !== "write") throw new Error(`unclassified_mcp_tool:${name}`);
  if (requirementForMcpTool(name).permission !== permission) throw new Error(`mcp_tool_permission_mismatch:${name}`);
  captureMcpToolContract({
    name,
    description: MCP_TOOL_DESCRIPTIONS[name] ?? null,
    input_schema: z.toJSONSchema(z.object(inputShape)) as Record<string, unknown>,
    output_schema: null
  });
  return server.registerTool(
    name,
    {
      ...ORGBRAIN_TOOL_PRESENTATION,
      ...(MCP_TOOL_DESCRIPTIONS[name] ? { description: MCP_TOOL_DESCRIPTIONS[name] } : {}),
      inputSchema: z.object(inputShape)
    },
    handler
  );
}

export function normalizeTenant(tenantInput: string | undefined, props: AgentProps | undefined): string {
  if (!props) {
    throw new HttpError(500, "misconfigured", "missing MCP auth context");
  }
  const requested = tenantInput?.trim() || props.tenantId;
  if (requested === "all" || !props.allowedTenants.includes(requested)) {
    throw new HttpError(403, "forbidden", `tenant not allowed: ${requested}`);
  }
  return requested;
}

export const workTypeSchema = z.enum([
      "implementation", "review", "debug", "proposal",
      "support", "research", "operations", "other"
    ]);
