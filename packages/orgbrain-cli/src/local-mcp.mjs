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
        business_category_id: { type: ["string", "null"] },
        work_type: {
          type: ["string", "null"],
          enum: ["implementation", "review", "debug", "proposal", "support", "research", "operations", "other", null]
        },
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
        business_category_id: { type: ["string", "null"] },
        work_type: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        minimum_total_score: { type: ["number", "null"], minimum: 0 },
        principal_id: { type: ["string", "null"] },
        search_mode: {
          type: "string",
          enum: ["memories", "default", "lexical", "hybrid", "structured", "hybrid_v3", "hybrid_v4"]
        }
      }
    }
  },
  {
    name: "orgbrain_memory_retrieve_context",
    description: "Retrieve a bounded evidence bundle from the local OrgBrain store.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        tenant_id: { type: "string" },
        project_id: { type: ["string", "null"] },
        business_category_id: { type: ["string", "null"] },
        work_type: { type: ["string", "null"] },
        top_k: { type: "integer", minimum: 1, maximum: 50 },
        token_budget: { type: "integer", minimum: 512, maximum: 16000 },
        principal_id: { type: ["string", "null"] },
        search_mode: { type: "string", enum: ["default", "hybrid", "structured", "hybrid_v3", "hybrid_v4"] }
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
  },
  {
    name: "orgbrain_business_categories_list",
    description: "List tenant-defined business categories from the local OrgBrain store.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string" },
        include_inactive: { type: "boolean" }
      }
    }
  },
  {
    name: "orgbrain_business_categories_create",
    description: "Create a tenant-defined business category.",
    inputSchema: {
      type: "object",
      required: ["slug", "label"],
      properties: {
        tenant_id: { type: "string" },
        slug: { type: "string" },
        label: { type: "string" },
        description: { type: ["string", "null"] }
      }
    }
  },
  {
    name: "orgbrain_business_categories_update",
    description: "Update or deactivate a tenant-defined business category.",
    inputSchema: {
      type: "object",
      required: ["category_id"],
      properties: {
        tenant_id: { type: "string" },
        category_id: { type: "string" },
        slug: { type: "string" },
        label: { type: "string" },
        description: { type: ["string", "null"] },
        is_active: { type: "boolean" }
      }
    }
  },
  {
    name: "orgbrain_memory_failure_patterns_list",
    description: "List tenant failure-pattern identifiers used for same-failure avoidance measurement.",
    inputSchema: {
      type: "object",
      properties: { tenant_id: { type: "string" }, project_id: { type: ["string", "null"] } }
    }
  },
  {
    name: "orgbrain_memory_failure_pattern_create",
    description: "Create a normalized failure pattern without storing prompts or commands.",
    inputSchema: {
      type: "object",
      required: ["pattern_key", "label"],
      properties: {
        tenant_id: { type: "string" }, project_id: { type: ["string", "null"] },
        business_category_id: { type: ["string", "null"] }, work_type: { type: ["string", "null"] },
        pattern_key: { type: "string" }, label: { type: "string" },
        action_fingerprint: { type: ["string", "null"] }, failure_fingerprint: { type: ["string", "null"] },
        is_active: { type: "boolean" }
      }
    }
  },
  {
    name: "orgbrain_memory_failure_pattern_update",
    description: "Update or deactivate a normalized failure pattern.",
    inputSchema: {
      type: "object",
      required: ["pattern_id"],
      properties: {
        tenant_id: { type: "string" }, pattern_id: { type: "string" }, project_id: { type: ["string", "null"] },
        business_category_id: { type: ["string", "null"] }, work_type: { type: ["string", "null"] },
        pattern_key: { type: "string" }, label: { type: "string" },
        action_fingerprint: { type: ["string", "null"] }, failure_fingerprint: { type: ["string", "null"] },
        is_active: { type: "boolean" }
      }
    }
  },
  {
    name: "orgbrain_memory_usage_state_update",
    description: "Record whether returned memory items were used, not used, or remain unknown.",
    inputSchema: {
      type: "object",
      required: ["usage_event_id", "items"],
      properties: {
        tenant_id: { type: "string" }, usage_event_id: { type: "string" },
        items: { type: "array", items: { type: "object", required: ["usage_item_id", "used_state"], properties: {
          usage_item_id: { type: "string" }, used_state: { type: "string", enum: ["used", "not_used", "unknown"] }
        } } }
      }
    }
  },
  {
    name: "orgbrain_memory_effect_record",
    description: "Record the measured or estimated outcome attributed to one memory usage event.",
    inputSchema: {
      type: "object",
      required: ["usage_event_id", "idempotency_key", "effect_outcome"],
      properties: {
        tenant_id: { type: "string" },
        usage_event_id: { type: "string" },
        idempotency_key: { type: "string" },
        evidence_level: { type: "string", enum: ["reported", "estimated", "verified", "unverifiable"] },
        effect_outcome: { type: "string", enum: ["positive", "neutral", "negative", "unknown"] },
        avoided_lookup_categories: {
          type: "array",
          items: { type: "string", enum: ["source_search", "web_search", "past_context", "none"] }
        },
        gross_saved_tokens_estimate: { type: "number" },
        token_estimation_candidates: {
          type: "object",
          properties: {
            paired_control_tokens: { type: "number" }, safe_replay_tokens: { type: "number" },
            avoided_source_tokens: { type: "number" }, failure_pattern_median_tokens: { type: "number" },
            category_median_tokens: { type: "number" }, text_size_heuristic_tokens: { type: "number" }
          }
        },
        injected_tokens: { type: "number" },
        estimation_method: { type: "string" },
        failure_opportunity_state: { type: "string", enum: ["applicable", "not_applicable", "unknown"] },
        action_changed: { type: "boolean" },
        alternative_executed: { type: "boolean" },
        failure_avoided: { type: "boolean" },
        failure_saved_tokens_estimate: { type: "number" }
      }
    }
  },
  {
    name: "orgbrain_memory_impact_report",
    description: "Report durable memory reference and effect metrics without mixing evidence levels.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string" },
        source_type: { type: "string" },
        source_id: { type: "string" },
        business_category_id: { type: "string" },
        work_type: { type: "string" },
        day: { type: "string" },
        group_by: { type: "string", enum: ["memory", "business_category", "work_type", "project", "day"] }
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
    const results = await store.search({
      tenant_id: tenantId,
      project_id: input.project_id || null,
      business_category_id: input.business_category_id || null,
      work_type: input.work_type || null,
      query: input.query,
      limit: input.limit || 10,
      minimum_total_score: input.minimum_total_score ?? null,
      principal_id: input.principal_id || null,
      search_mode: normalizeSearchMode(input.search_mode || "default")
    });
    const usage = await store.recordUsage({
      tenant_id: tenantId,
      project_id: input.project_id || null,
      capability: "memory_search",
      access_path: "search",
      request_source: "mcp",
      requested_business_category_id: input.business_category_id || null,
      requested_work_type: input.work_type || null,
      items: results.map((result, index) => ({
        source_type: "memory",
        source_id: result.memory.id,
        source_version: result.memory.current_version,
        rank: index + 1,
        score: result.score?.total ?? null,
        reference_type: "returned",
        used_state: "unknown"
      }))
    });
    return { results, meta: { usage_id: usage.usage_id, verification_sampled: usage.verification_sampled } };
  }
  if (name === "orgbrain_memory_retrieve_context") {
    return store.retrieveContext({
      tenant_id: tenantId,
      project_id: input.project_id || null,
      business_category_id: input.business_category_id || null,
      work_type: input.work_type || null,
      query: input.query,
      top_k: input.top_k || 5,
      token_budget: input.token_budget || 8_000,
      principal_id: input.principal_id || null,
      search_mode: normalizeSearchMode(input.search_mode || "structured")
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
  if (name === "orgbrain_business_categories_list") {
    return store.listBusinessCategories(tenantId, { includeInactive: Boolean(input.include_inactive) });
  }
  if (name === "orgbrain_business_categories_create") {
    return store.createBusinessCategory(tenantId, input);
  }
  if (name === "orgbrain_business_categories_update") {
    const { category_id: categoryId, tenant_id: _tenant, ...update } = input;
    return store.updateBusinessCategory(tenantId, categoryId, update);
  }
  if (name === "orgbrain_memory_failure_patterns_list") {
    return store.listFailurePatterns(tenantId, { projectId: input.project_id ?? null });
  }
  if (name === "orgbrain_memory_failure_pattern_create") return store.createFailurePattern(tenantId, input);
  if (name === "orgbrain_memory_failure_pattern_update") {
    const { pattern_id: patternId, tenant_id: _tenant, ...update } = input;
    return store.updateFailurePattern(tenantId, patternId, update);
  }
  if (name === "orgbrain_memory_usage_state_update") return store.updateUsageStates(tenantId, input);
  if (name === "orgbrain_memory_effect_record") return store.recordEffect(input);
  if (name === "orgbrain_memory_impact_report") return store.memoryImpactReport(tenantId, input);
  throw new Error(`unknown tool: ${name}`);
}

function normalizeSearchMode(mode) {
  if (mode === "hybrid_v3" || mode === "lexical") return "hybrid_v3";
  if (mode === "hybrid_v4" || mode === "hybrid" || mode === "structured" || mode === "default") return "hybrid_v4";
  return mode;
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
