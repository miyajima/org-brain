import { memorySearchDelivery } from "../working-llm-candidates.mjs";
import { issueLocalMemoryDetailReceipt } from "../local-memory-detail-receipt.mjs";
import { boundedString } from "./common.mjs";

export const memoryReadDefinitions = [
  {
    name: "orgbrain_memory_get",
    description: "Read full current details for every selected pending candidate before applying it. Requires the preview's exact expected_version and the same task scope/principal. Rechecks current access, lifecycle, expiry, scope and version; unavailable details must not be used. This read does not mark memory used.",
    inputSchema: {type:"object",required:["memory_id","expected_version"],properties:{tenant_id:{type:"string"},target_tenant_id:{const:"all"},
      memory_id:{type:"string",minLength:1},expected_version:{type:"integer",minimum:1},principal_id:{type:["string","null"]},
      project_id:{type:["string","null"]},business_category_id:{type:["string","null"]},work_type:{type:["string","null"]}}}
  },
  {
    name: "orgbrain_memory_version_get",
    description: "Read one exact local memory version by tenant, source, and external key. Omit version only when the current version is explicitly wanted.",
    inputSchema: {
      type: "object",
      required: ["source", "external_key"],
      properties: {
        tenant_id: { type: "string" },
        source: { type: "string", minLength: 1, maxLength: 64 },
        external_key: { type: "string", minLength: 1, maxLength: 256 },
        version: { type: "integer", minimum: 1 }
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
        task_id: { type: ["string", "null"] },
        usage_purpose: { type: "string", enum: ["task", "audit", "diagnostic", "test", "unclassified"] },
        use_snapshot_id: {type:"string",maxLength:128},
        use_context: {type:"object",properties:{task:{type:"string"},target:{type:"string"},constraints:{type:"string"},conditions:{type:"string"}}},
        trace_id: { type: ["string", "null"] },
        external_run_id: { type: ["string", "null"] },
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
        task_id:{type:"string",maxLength:128},
        usage_purpose: { type: "string", enum: ["task", "audit", "diagnostic", "test", "unclassified"] },
        use_snapshot_id:{type:"string",maxLength:128},
        use_context:{type:"object",properties:{task:{type:"string",maxLength:600},target:{type:"string",maxLength:600},constraints:{type:"string",maxLength:600},conditions:{type:"string",maxLength:600}}},
        top_k: { type: "integer", minimum: 1, maximum: 50 },
        token_budget: { type: "integer", minimum: 512, maximum: 16000 },
        principal_id: { type: ["string", "null"] },
        search_mode: { type: "string", enum: ["default", "hybrid", "structured", "hybrid_v3", "hybrid_v4"] }
      }
    }
  }
];

export async function callMemoryRead(store, name, input, toolProfile = "default") {
  const tenantId = input.tenant_id || "default";
  if (name === "orgbrain_memory_get") {
    const request = { ...input, tenant_id: tenantId };
    const result = await store.getMemoryDetail(request);
    const detailReceipt = await issueLocalMemoryDetailReceipt(store, { tenantId, input: request, result });
    return detailReceipt ? { ...result, detail_receipt: detailReceipt } : result;
  }
  if (name === "orgbrain_memory_version_get") {
    const source = boundedString(input.source, 64);
    const externalKey = boundedString(input.external_key, 256);
    if (!source || !externalKey) throw new Error("source_and_external_key_required");
    if (input.version != null && (!Number.isInteger(input.version) || input.version < 1)) throw new Error("invalid_memory_version");
    return store.getVersionByExternalKey({
      tenant_id: tenantId,
      source,
      external_key: externalKey,
      version: input.version ?? null
    });
  }
  if (name === "orgbrain_memory_search") {
    const retrieval = {};
    const outputLimit = Math.max(1, Math.min(100, Number(input.limit) || (store.relevanceSelector?.provider === "working-llm" ? 20 : 10)));
    let results = await store.search({
      retrieval_metadata: retrieval,
      tenant_id: tenantId,
      project_id: input.project_id || undefined,
      business_category_id: input.business_category_id || null,
      work_type: input.work_type || null,
      query: input.query,
      task_id: input.task_id, use_context: input.use_context,use_snapshot_id:input.use_snapshot_id,
      limit: store.relevanceSelector?.provider === "working-llm" ? outputLimit : Math.max(outputLimit, store.relevanceSelector?.candidateLimit ?? 0),
      minimum_total_score: input.minimum_total_score ?? null,
      principal_id: input.principal_id || null,
      search_mode: normalizeSearchMode(input.search_mode || "default")
    });
    const selection = await store.selectMemorySearchResults(results, { tenant_id: tenantId,
      project_id: input.project_id || null, principal_id: input.principal_id || null, query: input.query,
      business_category_id: input.business_category_id || null, work_type: input.work_type || null,
      use_context: input.use_context, usage_purpose: input.usage_purpose });
    const delivery = memorySearchDelivery(selection, outputLimit);
    results = delivery.results;
    const usage = await store.recordUsage({
      tenant_id: tenantId,
      project_id: input.project_id || undefined,
      task_id: input.task_id || undefined,
      usage_purpose: input.usage_purpose,
      trace_id: input.trace_id || undefined,
      external_run_id: input.external_run_id || undefined,
      capability: "memory_search",
      access_path: "search",
      request_source: "mcp",
      requested_business_category_id: input.business_category_id || null,
      requested_work_type: input.work_type || null,
      items: delivery.items
    });
    return { results, ...(delivery.candidates ? {candidates:delivery.candidates,selection_guidance:delivery.selection_guidance} : {}), meta: { retrieval, ...(delivery.local_relevance ? {local_relevance:delivery.local_relevance} : {}), usage_id: usage.usage_id, usage_item_ids:usage.usage_item_ids,usage_items:usage.usage_items, verification_sampled: usage.verification_sampled, use_history:results[0]?.use_history_meta,
      ...(selection.memory_judgment.mode !== "off" ? { memory_judgment: selection.memory_judgment } : {}) } };
  }
  if (name === "orgbrain_memory_retrieve_context") {
    return store.retrieveContext({
      tenant_id: tenantId,
      project_id: input.project_id || null,
      business_category_id: input.business_category_id || null,
      work_type: input.work_type || null,
      query: input.query,
      task_id:input.task_id,use_context:input.use_context,use_snapshot_id:input.use_snapshot_id,usage_purpose:input.usage_purpose,
      top_k: input.top_k,
      token_budget: input.token_budget || 8_000,
      principal_id: input.principal_id || null,
      search_mode: normalizeSearchMode(input.search_mode || "structured")
    });
  }
  throw new Error(`unknown tool: ${name}`);
}

function normalizeSearchMode(mode) {
  if (mode === "hybrid_v3" || mode === "lexical") return "hybrid_v3";
  if (mode === "hybrid_v4" || mode === "hybrid" || mode === "structured" || mode === "default") return "hybrid_v4";
  return mode;
}
