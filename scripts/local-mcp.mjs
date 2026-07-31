import { createInterface } from "node:readline";

const TOOL_DEFINITIONS = [
  {
    name: "orgbrain_memory_capture",
    description: "Capture one durable memory in the local OrgBrain SQLite store.",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string" },
        summary: { type: ["string", "null"] },
        tenant_id: { type: "string" },
        project_id: { type: ["string", "null"] },
        kind: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } },
        source_references: { type: "array", items: { type: "object" } },
        valid_from: { type: ["number", "null"] },
        valid_until: { type: ["number", "null"] },
        confidence_score: { type: ["number", "null"] },
        utility_score: { type: ["number", "null"] }
      }
    }
  },
  {
    name: "orgbrain_memory_search",
    description: "Search the local OrgBrain memory store.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        tenant_id: { type: "string" },
        project_id: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        minimum_total_score: { type: ["number", "null"], minimum: 0 },
        principal_id: { type: ["string", "null"] },
        search_mode: {
          type: "string",
          enum: ["memories", "hybrid_v3"]
        }
      }
    }
  },
  {
    name: "orgbrain_memory_revise",
    description: "Revise a local memory while retaining immutable version history.",
    inputSchema: {
      type: "object",
      required: ["memory_id"],
      properties: {
        memory_id: { type: "string" },
        tenant_id: { type: "string" },
        content: { type: "string" },
        summary: { type: ["string", "null"] },
        tags: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "orgbrain_memory_suppress",
    description: "Suppress a local memory without destroying its version history.",
    inputSchema: {
      type: "object",
      required: ["memory_id", "reason"],
      properties: {
        memory_id: { type: "string" },
        reason: { type: "string" },
        tenant_id: { type: "string" }
      }
    }
  },
  {
    name: "orgbrain_memory_delete",
    description: "Permanently delete a local memory and all retrieval projections.",
    inputSchema: {
      type: "object",
      required: ["memory_id"],
      properties: {
        memory_id: { type: "string" },
        tenant_id: { type: "string" }
      }
    }
  }
];

function content(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function captureDefaults(input) {
  const tenantId = input.tenant_id || "default";
  const projectId = input.project_id || null;
  return {
    tenant_id: tenantId,
    project_id: projectId,
    kind: "episodic",
    lifecycle_state: "active",
    scope_type: projectId ? "project" : "tenant",
    scope_key: projectId || tenantId,
    content: "",
    summary: null,
    tags: [],
    entities: [],
    source: "local-mcp",
    source_references: [],
    external_key: null,
    actor_type: "principal",
    actor_id: process.env.USER || "local-user",
    valid_from: null,
    valid_until: null,
    confidence_score: null,
    utility_score: null,
    rationale: null,
    evidence: [],
    conflicts: [],
    permissions: [],
    ...input
  };
}

async function callTool(store, name, input) {
  const tenantId = input.tenant_id || "default";
  if (name === "orgbrain_memory_capture") return store.capture(captureDefaults(input));
  if (name === "orgbrain_memory_search") {
    return store.search({
      tenant_id: tenantId,
      project_id: input.project_id || null,
      query: input.query,
      limit: input.limit || 10,
      minimum_total_score: input.minimum_total_score ?? null,
      principal_id: input.principal_id || null,
      search_mode: input.search_mode || "memories"
    });
  }
  if (name === "orgbrain_memory_revise") {
    const { memory_id: memoryId, tenant_id: _tenant, ...revision } = input;
    return store.revise(tenantId, memoryId, revision);
  }
  if (name === "orgbrain_memory_suppress") {
    return store.suppress(tenantId, input.memory_id, input.reason, {
      actor_type: "principal",
      actor_id: process.env.USER || "local-user"
    });
  }
  if (name === "orgbrain_memory_delete") {
    return store.delete(tenantId, input.memory_id, {
      actor_type: "principal",
      actor_id: process.env.USER || "local-user"
    });
  }
  throw new Error(`unknown tool: ${name}`);
}

export async function handleLocalMcpRequest(store, request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: request.params?.protocolVersion || "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "OrgBrain Local", version: "0.1.0" }
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools: TOOL_DEFINITIONS };
  if (request.method === "tools/call") {
    const name = request.params?.name;
    const input = request.params?.arguments || {};
    try {
      return { content: content(await callTool(store, name, input)), isError: false };
    } catch (error) {
      return {
        content: content({ error: error instanceof Error ? error.message : String(error) }),
        isError: true
      };
    }
  }
  throw Object.assign(new Error(`method not found: ${request.method}`), { code: -32601 });
}

export async function startLocalMcp(store) {
  await store.init();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      })}\n`);
      continue;
    }
    if (request.id === undefined) continue;
    try {
      const result = await handleLocalMcpRequest(store, request);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: typeof error?.code === "number" ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error)
        }
      })}\n`);
    }
  }
}
