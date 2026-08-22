import type { McpAuthContext, OrgBrainOAuthScope, OrgPermission } from "@org-brain/contracts";
export type { McpAuthContext } from "@org-brain/contracts";

export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;

export interface McpAuthorizationAdapter {
  authenticate(request: Request): Promise<McpAuthContext>;
  authorize?(context: McpAuthContext, requirement: McpToolRequirement): Promise<void>;
}

export type McpToolRequirement = {
  permission: OrgPermission;
  scope: OrgBrainOAuthScope;
};

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  requirement: McpToolRequirement;
  execute(input: unknown, context: McpAuthContext): Promise<unknown>;
};

export type McpToolManifestEntry = {
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown> | null;
  permission: OrgPermission;
  scope: OrgBrainOAuthScope;
};

const capturedContracts = new Map<string, McpToolManifestEntry>();

const WRITE_TOOL_NAMES = new Set([
  "orgbrain_memory_observe",
  "orgbrain_learning_batch_ingest",
  "orgbrain_business_categories_create",
  "orgbrain_business_categories_update",
  "orgbrain_memory_commit_verified",
  "orgbrain_memories_extract",
  "orgbrain_memories_propose",
  "orgbrain_memories_capture_rationale",
  "orgbrain_memories_confirm",
  "orgbrain_memories_upsert",
  "orgbrain_decision_memories_create",
  "orgbrain_memory_failure_pattern_create",
  "orgbrain_memory_failure_pattern_update",
  "orgbrain_memory_usage_state_update",
  "orgbrain_memory_effect_record",
  "orgbrain_memories_refresh",
  "orgbrain_memories_suppress",
  "orgbrain_messages_send",
  "orgbrain_handoff_send",
  "orgbrain_messages_read",
  "orgbrain_messages_ack",
  "orgbrain_memory_impact_start",
  "orgbrain_memory_impact_report",
  "orgbrain_task_create",
  "orgbrain_domain_recall_feedback"
]);

export function requirementForMcpTool(name: string): McpToolRequirement {
  const permission: OrgPermission = WRITE_TOOL_NAMES.has(name) ? "write" : "read";
  return { permission, scope: permission === "write" ? "orgbrain:write" : "orgbrain:read" };
}

export function captureMcpToolContract(input: Omit<McpToolManifestEntry, "permission" | "scope">): void {
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(input.name)) throw new Error(`invalid_mcp_tool_name:${input.name}`);
  capturedContracts.set(input.name, { ...input, ...requirementForMcpTool(input.name) });
}

export function resetCapturedMcpToolContracts(): void {
  capturedContracts.clear();
}

export function capturedMcpToolContracts(): McpToolManifestEntry[] {
  return [...capturedContracts.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export class McpToolAuthorizationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "McpToolAuthorizationError";
  }
}

export class McpToolRegistry {
  readonly #tools = new Map<string, McpToolDefinition>();

  register(tool: McpToolDefinition): this {
    if (!/^[a-z][a-z0-9_]{0,127}$/u.test(tool.name)) throw new Error(`invalid_mcp_tool_name:${tool.name}`);
    if (this.#tools.has(tool.name)) throw new Error(`duplicate_mcp_tool:${tool.name}`);
    this.#tools.set(tool.name, tool);
    return this;
  }

  definitions(): readonly McpToolDefinition[] {
    return [...this.#tools.values()];
  }

  list(context: McpAuthContext) {
    return [...this.#tools.values()]
      .filter((tool) => this.#isVisible(tool, context))
      .map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema
      }));
  }

  async call(name: string, input: unknown, context: McpAuthContext, adapter?: McpAuthorizationAdapter) {
    const tool = this.#tools.get(name);
    if (!tool) throw new McpToolAuthorizationError(404, "tool_not_found", "MCP tool is not registered");
    if (context.allowed_tools !== null && !context.allowed_tools.includes(name)) {
      throw new McpToolAuthorizationError(403, "tool_not_allowed", "MCP installation does not allow this tool");
    }
    if (!context.scopes.includes(tool.requirement.scope)) {
      throw new McpToolAuthorizationError(403, "insufficient_scope", `MCP tool requires ${tool.requirement.scope}`);
    }
    if (!context.permissions.includes(tool.requirement.permission)) {
      throw new McpToolAuthorizationError(403, "permission_denied", `MCP tool requires ${tool.requirement.permission}`);
    }
    await adapter?.authorize?.(context, tool.requirement);
    return tool.execute(input, context);
  }

  #isVisible(tool: McpToolDefinition, context: McpAuthContext) {
    return (context.allowed_tools === null || context.allowed_tools.includes(tool.name)) &&
      context.scopes.includes(tool.requirement.scope) &&
      context.permissions.includes(tool.requirement.permission);
  }
}

export type McpTransportMetadata = {
  method: string;
  name: string | null;
  protocolVersion: typeof MCP_PROTOCOL_VERSION;
};

export class McpProtocolError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export function validateMcpTransport(request: Request): McpTransportMetadata {
  if (request.method !== "POST") throw new McpProtocolError(405, "method_not_allowed", "MCP uses POST requests");
  const protocolVersion = request.headers.get("mcp-protocol-version")?.trim();
  if (protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new McpProtocolError(400, "unsupported_protocol_version", `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}`);
  }
  const method = request.headers.get("mcp-method")?.trim();
  if (!method) throw new McpProtocolError(400, "mcp_method_required", "Mcp-Method header is required");
  const name = request.headers.get("mcp-name")?.trim() || null;
  if ((method === "tools/call" || method === "resources/read" || method === "prompts/get") && !name) {
    throw new McpProtocolError(400, "mcp_name_required", "Mcp-Name header is required for named MCP methods");
  }
  return { method, name, protocolVersion: MCP_PROTOCOL_VERSION };
}

export function validateMcpEnvelope(
  transport: McpTransportMetadata,
  payload: unknown
): asserts payload is { method: string; id?: unknown; params?: { name?: string }; [key: string]: unknown } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new McpProtocolError(400, "invalid_jsonrpc_envelope", "MCP request body must be a JSON object");
  }
  const body = payload as { method?: unknown; params?: unknown };
  if (typeof body.method !== "string" || body.method !== transport.method) {
    throw new McpProtocolError(400, "mcp_method_mismatch", "Mcp-Method must match the JSON-RPC method");
  }
  if (transport.name !== null) {
    const params = body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? body.params as { name?: unknown }
      : null;
    if (typeof params?.name !== "string" || params.name !== transport.name) {
      throw new McpProtocolError(400, "mcp_name_mismatch", "Mcp-Name must match the named JSON-RPC method target");
    }
  }
}

export function oauthBearerChallenge(resourceMetadataUrl: string, scopes: readonly OrgBrainOAuthScope[]): string {
  const url = new URL(resourceMetadataUrl);
  if (url.protocol !== "https:") throw new Error("resource_metadata_https_required");
  return `Bearer resource_metadata="${url.toString()}", scope="${scopes.join(" ")}"`;
}

export function protectedResourceMetadata(input: {
  resource: string;
  authorizationServers: string[];
  scopesSupported: readonly OrgBrainOAuthScope[];
}) {
  const resource = new URL(input.resource);
  if (resource.protocol !== "https:") throw new Error("resource_https_required");
  if (!input.authorizationServers.length) throw new Error("authorization_server_required");
  return {
    resource: resource.toString(),
    authorization_servers: input.authorizationServers.map((item) => new URL(item).toString()),
    bearer_methods_supported: ["header"],
    scopes_supported: [...input.scopesSupported]
  };
}
