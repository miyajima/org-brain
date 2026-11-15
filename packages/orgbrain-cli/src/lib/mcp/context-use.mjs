import { wikiStatusSync, wikiServiceForStore } from "../wiki-service.mjs";
import { TaskCommitmentStore } from "../task-commitment-store.mjs";
import { previewLocalDomainRecall, recallBundleMarkdown } from "../local-domain-recall.mjs";
import { canonicalLocalProjectId, boundedString } from "./common.mjs";
const DEFAULT_CONTEXT_MINIMUM_TOTAL_SCORE = 0.065;

export const contextUseDefinitions = [
  {
    name: "orgbrain_context_enrich",
    description: "Retrieve local memory context and optional Domain Recall. When personal Wiki is enabled, a matching project's procedure index is returned independently of query keywords; read it before work. Network-free by default; explicitly enabled Jev judgment sends bounded redacted evidence to OpenRouter.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        query: { type: "string" }, tenant_id: { type: "string" }, project_id: { type: ["string", "null"] },
        principal_id: { type: ["string", "null"] }, include_domain_recall: { type: "boolean" },
        include_wiki: { type: "boolean", description: "Include separately labeled Wiki evidence only when the optional local feature is enabled." },
        task_title: { type: ["string", "null"], maxLength: 500 }, task_description: { type: ["string", "null"], maxLength: 4000 },
        task_id: { type: "string", maxLength: 128 }, work_type: { type: "string", enum: ["implementation", "review", "debug", "proposal", "support", "research", "operations", "other"] },
        usage_purpose: { type: "string", enum: ["task", "audit", "diagnostic", "test", "unclassified"] },
        use_context: { type: "object", properties: { task: { type: "string", maxLength: 4000 }, target: { type: "string", maxLength: 1000 }, constraints: { type: "string", maxLength: 4000 }, conditions: { type: "string", maxLength: 4000 } } },
        minimum_total_score: { type: ["number", "null"], minimum: 0 }, top_k: { type: "integer", minimum: 1, maximum: 10 }, token_budget: { type: "integer", minimum: 512, maximum: 16000 },
        context_format: { type: "string", enum: ["compact", "full"], description: "Compact preserves complete lessons and reuse conditions within the complete response budget; full includes historical projections." },
        object_type_key: { type: ["string", "null"] }, object_id: { type: ["string", "null"] }, scope: { type: "object" },
        reuse: {type:"object",description:"Opt-in local reuse route; project host supplies channel and flags.",properties:{channel:{type:"string",enum:["object","operation","recent","changes","procedure","result"]},flags:{type:"object"},operation:{type:"string"},fingerprint:{type:"string"},visible_versions:{type:"array",items:{type:"object"}}}}
      }
    }
  },
  {
    name: "orgbrain_task_context_get",
    description: "Retrieve confirmed task commitments for continuity without exposing unverified learning candidates.",
    inputSchema: {
      type: "object",
      required: ["task_key"],
      properties: {
        tenant_id: { type: "string" },
        project_id: { type: ["string", "null"] },
        task_key: { type: "string", minLength: 1, maxLength: 256 },
        query: { type: "string", maxLength: 1000 }
      }
    }
  },
  {name:"orgbrain_memory_use_assess",description:"Assess an exact delivered usage item. A used judgment requires a live verified action_context_id; explicit non-use needs a reason. Unknown stays unknown with a reason. This does not rate usefulness.",inputSchema:{type:"object",required:["payload"],properties:{tenant_id:{type:"string"},payload:{type:"object",required:["usage_id","usage_item_id","source_version","project_id","task_id","state","reason_code"],properties:{id:{type:"string"},usage_id:{type:"string"},usage_item_id:{type:"string"},source_version:{type:["integer","null"]},project_id:{type:"string"},task_id:{type:"string"},state:{type:"string",enum:["used","not_used","unknown"]},reason_code:{type:"string"},action_context_id:{type:"string"},supersedes_id:{type:"string"}},additionalProperties:false}}}},
  { name: "orgbrain_memory_use_context_record", description: "Record existing use. payload: id, usage_item_id, project_id, task_id, work_type, context {task,target,constraints,conditions}, evidence [{role,ref_type,ref_id,span_start,span_end,content_hash}], optional supersedes_id. No new memory is saved.", inputSchema: {type:"object", properties:{tenant_id:{type:"string"},payload:{type:"object"}},required:["payload"]} },
  { name: "orgbrain_memory_use_history", description: "Read private use history and evidence. payload: source_id, project_id, limit (1-100), before (next_cursor); all optional.", inputSchema: {type:"object", properties:{tenant_id:{type:"string"},payload:{type:"object"}},required:["payload"]} },
  { name: "orgbrain_memory_use_evaluate", description: "Record a use assessment. payload: id, context_id, and proof_id or feedback {contribution: positive|negative|unknown,statement}; supersedes_id for correction. Ranking requires verified action and outcome evidence. Do not infer usefulness from task success.", inputSchema: {type:"object", properties:{tenant_id:{type:"string"},payload:{type:"object"}},required:["payload"]} },
  { name: "orgbrain_memory_use_revoke", description: "Revoke a use record and invalidate its search/ranking contribution. payload requires id.", inputSchema: {type:"object", properties:{tenant_id:{type:"string"},payload:{type:"object"}},required:["payload"]} },
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
        failure_saved_tokens_estimate: { type: "number" },
        verification_ref_type: { type: "string", maxLength: 128 },
        verification_ref_id: { type: "string", maxLength: 500 },
        supersedes_effect_id: { type: "string", maxLength: 128 },
        failure_pattern_id: { type: "string", maxLength: 128 },
        attributions: { type: "array", maxItems: 50, items: { type: "object" } },
        use_evaluation: { type: "object" },
        created_at: { type: "number" }
      }
    }
  }
];

export async function callContextUse(store, name, input, toolProfile = "default") {
  const tenantId = input.tenant_id || "default";
  if (name === "orgbrain_context_enrich") {
    const projectId = await canonicalLocalProjectId(input.project_id);
    if (input.reuse) {
      const {MemoryReuse}=await import('../memory-reuse.mjs');
      const reuse=new MemoryReuse(store,{tenant_id:tenantId,project_id:projectId,principal_id:input.principal_id||process.env.ORGBRAIN_USE_PRINCIPAL||'local',work_type:input.work_type});
      return reuse.recall({...input.reuse,object_type_key:input.object_type_key,object_id:input.object_id,task_id:input.task_id,token_budget:input.token_budget,usage_purpose:input.usage_purpose});
    }
    const contextFormat = input.context_format ?? (input.include_domain_recall || toolProfile === "answer-ux-readonly" ? "full" : "compact");
    if (!["compact", "full"].includes(contextFormat)) throw new Error("invalid_context_format");
    if (contextFormat === "compact" && toolProfile === "answer-ux-readonly") throw new Error("compact_context_requires_default_profile");
    if (contextFormat === "compact" && input.include_domain_recall) throw new Error("compact_context_requires_separate_domain_recall");
    const useContext = input.use_context ?? {
      task: input.task_description ?? input.task_title ?? input.query,
      target: input.task_title ?? input.project_id ?? "OrgBrain context enrichment",
      constraints: "Use only relevant durable memory and abstain when evidence is insufficient.",
      conditions: "Current workspace and task scope must match."
    };
    const recall = input.include_domain_recall ? await previewLocalDomainRecall(store, { ...input, prompt: input.query }) : null;
    let prior_attempts = projectId
      ? await store.searchAttempts(tenantId, { project_id: projectId, query: input.query, limit: 3 })
      : [];
    const hostSelection = toolProfile !== "answer-ux-readonly" && store.relevanceSelector?.provider === "working-llm";
    const contextBudget = input.token_budget ?? (contextFormat === "full" ? 6000 : 1500);
    let project_index;
    const { countContextTokens } = await import('../compact-memory-context.mjs');
    if (projectId && toolProfile !== 'answer-ux-readonly') {
      try {
        if (wikiStatusSync().enabled) {
          const { projectIndexContext } = await import('../agent-memory-protocol.mjs');
          project_index = await projectIndexContext(wikiServiceForStore(store), { project_id: projectId });
        }
      } catch { project_index = { status: 'unavailable', reason: 'wiki_unavailable' }; }
    }
    // The same 650-token reserve below protects the mandatory context envelope. A small
    // budget must disclose the unread index rather than fail ordinary memory retrieval.
    if (project_index?.next_read && countContextTokens({ project_index }) > contextBudget - 650)
      project_index = { status: 'omitted', reason: 'token_budget', requires_read: true };
    const projectEnvelope = project_index ? { project_index } : {};
    let attemptsOmitted = 0;
    let recallEnvelope = recall ? {domain_recall:recall.bundle,domain_recall_markdown:recall.inject ? recallBundleMarkdown(recall.bundle) : ""} : {};
    if (hostSelection || contextFormat === 'compact') {
      const kept = [];
      for (const attempt of prior_attempts) {
        if (countContextTokens({...recallEnvelope,prior_attempts:[...kept,attempt]}) > Math.max(0, contextBudget - 650)) {attemptsOmitted++;continue;}
        kept.push(attempt);
      }
      prior_attempts = kept;
      if (countContextTokens(recallEnvelope)>Math.max(0,contextBudget-650)) recallEnvelope={domain_recall_omitted:"context_budget_exhausted"};
    }
    if (projectId) await store.recordAttemptMetricEvent(tenantId, {
      project_id: projectId, kind: "context_query", source: "mcp", returned_count: prior_attempts.length
    });
    const attempt_usage = await Promise.all(prior_attempts.map((attempt) => store.recordAttemptUse(tenantId, {
      project_id: projectId, attempt_id: attempt.id, task_id: input.task_id ?? null, stage: "returned"
    })));
    const contextEnvelope = hostSelection || contextFormat === 'compact' ? {...projectEnvelope,prior_attempts,attempt_usage_ids:attempt_usage.map(item=>item.id),
      ...(attemptsOmitted ? {prior_attempts_omitted:attemptsOmitted} : {}),...recallEnvelope,
      ...(input.include_wiki ? {wiki:{status:"enabled",omitted:"context_budget_exhausted"}} : {})} : projectEnvelope;
    const memory = await store.retrieveContext({
      tenant_id: tenantId,
      project_id: projectId,
      work_type: input.work_type ?? "other",
      task_id: boundedString(input.task_id ?? input.task_title, 128) ?? "context-enrich",
      usage_purpose: input.usage_purpose,
      use_context: useContext,
      query: input.query,
      top_k: input.top_k,
      token_budget: contextBudget,
      context_format: contextFormat,
      context_envelope: contextEnvelope,
      answer_ux_projection: toolProfile === "answer-ux-readonly",
      minimum_total_score: input.minimum_total_score ?? DEFAULT_CONTEXT_MINIMUM_TOTAL_SCORE,
      principal_id: input.principal_id ?? null,
      search_mode: "hybrid_v4"
    });
    const response = { ...memory, ...projectEnvelope, prior_attempts, attempt_usage_ids: attempt_usage.map((item) => item.id), ...(hostSelection ? contextEnvelope : recallEnvelope) };
    if (input.include_wiki) {
      let status;
      try { status = wikiStatusSync(); }
      catch (error) { status = { enabled: false, error: error.message }; }
      response.wiki = { status: status.enabled ? "enabled" : "disabled" };
      if (status.error) response.wiki = { status: "unavailable", error: status.error };
      if (status.enabled) {
        const { countContextTokens } = await import("../compact-memory-context.mjs");
        const budget = (input.token_budget ?? 1500) - countContextTokens(response) - 160;
        if (budget >= 128) {
          try {
            response.wiki = {
              status: "enabled",
              evidence: await wikiServiceForStore(store).search({ query: input.query, token_budget: budget })
            };
          } catch (error) { response.wiki = { status: "unavailable", error: error.message }; }
        } else response.wiki = { status: "enabled", omitted: "context_budget_exhausted" };
      }
    }
    if (hostSelection && input.include_wiki) {
      const {countContextTokens}=await import("../compact-memory-context.mjs");
      if (countContextTokens(response)>contextBudget) response.wiki={status:"enabled",omitted:"context_budget_exhausted"};
    }
    if (contextFormat === "compact" || hostSelection) {
      const { measureCompactMemoryContext } = await import("../compact-memory-context.mjs");
      return measureCompactMemoryContext(response);
    }
    return response;
  }
  if (name === "orgbrain_task_context_get") {
    const commitmentStore = new TaskCommitmentStore(store.dbPath);
    const commitments = await commitmentStore.list({
      tenantId,
      projectId: input.project_id ?? null,
      taskKey: input.task_key
    });
    return {
      task_key: input.task_key,
      project_id: input.project_id ?? null,
      commitments,
      generated_at: Date.now()
    };
  }
  if(name==='orgbrain_memory_use_assess') {const {handleUseAssessment}=await import('../memory-pipeline-cli.mjs');return handleUseAssessment(store,'assess',{...input.payload,tenant_id:tenantId,principal_id:process.env.ORGBRAIN_USE_PRINCIPAL||'local'});}
  const useOperations = {orgbrain_memory_use_context_record:"record",orgbrain_memory_use_history:"history",orgbrain_memory_use_evaluate:"evaluate",orgbrain_memory_use_revoke:"revoke"};
  if (useOperations[name]) return store.useHistory(useOperations[name], {...input.payload,tenant_id:tenantId,principal_id:process.env.ORGBRAIN_USE_PRINCIPAL || "local"});
  if (name === "orgbrain_memory_usage_state_update") return store.updateUsageStates(tenantId, input);
  if (name === "orgbrain_memory_effect_record") return store.recordEffect(input);
  throw new Error(`unknown tool: ${name}`);
}
