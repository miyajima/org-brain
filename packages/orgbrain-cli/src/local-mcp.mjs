import { createInterface } from "node:readline";
import { observeMemoryLearningEvent } from "../../shared/src/memory-learning-runtime.mjs";
import {
  MEMORY_CONTRACT_V2_PROMPT_ID,
  MEMORY_CONTRACT_V2_VERIFIER_VERSION,
  observeMemoryContractV2Event
} from "../../shared/src/memory-contract-v2-runtime.mjs";
import {
  MEMORY_CONTRACT_V2_CONTRACT_HASH,
  MEMORY_CONTRACT_V2_PROMPT_HASH
} from "../../shared/src/memory-contract-v2-contract.mjs";
import { isAiConsensusCertified } from "../../shared/src/memory-contract-judge.mjs";
import { TaskCommitmentStore } from "./lib/task-commitment-store.mjs";

const TOOL_DEFINITIONS = [
  {
    name: "orgbrain_memory_observe",
    description: "Validate one current-turn durable learning event without persisting it. Use at most three times per turn.",
    inputSchema: {
      type: "object",
      required: ["schema_version", "lesson_type"],
      properties: {
        schema_version: { type: "integer", enum: [1, 2] },
        lesson_type: { type: "string", enum: ["success", "decision", "failure"] },
        kind: { type: "string", enum: ["decision", "constraint", "pitfall", "preference", "fact"] },
        record_type: { type: "string", const: "learning_observation" },
        capture_intent: { type: "string", enum: ["verify", "review"] },
        trigger: { type: ["string", "null"] }, conclusion: { type: ["string", "null"] }, rationale: { type: ["string", "null"] },
        reuse_rule: { type: ["string", "null"] }, outcome: { type: ["string", "null"] },
        procedure: { type: ["string", "null"] }, why_it_worked: { type: ["string", "null"] },
        observed_outcome: { type: ["string", "null"] }, reuse_when: { type: ["string", "null"] },
        decision_type: { type: "string", enum: ["user_choice", "preference", "implementation", "governance"] },
        decision_key: { type: ["string", "null"] }, question: { type: ["string", "null"] },
        selected_value: { type: ["string", "null"] }, decision: { type: ["string", "null"] },
        constraints: { type: "array", items: { type: "string" } },
        alternatives: { type: "array", items: { type: "object" } },
        symptom: { type: ["string", "null"] }, failed_approach: { type: ["string", "null"] },
        root_cause: { type: ["string", "null"] }, correction: { type: ["string", "null"] },
        verified_outcome: { type: ["string", "null"] }, avoidance_rule: { type: ["string", "null"] },
        applicability: {
          type: "object", required: ["target_files", "components"],
          properties: {
            target_files: { type: "array", maxItems: 16, items: { type: "string" } },
            components: { type: "array", maxItems: 16, items: { type: "string" } }
          }
        },
        evidence_selectors: {
          type: "array", minItems: 1, maxItems: 16,
          items: {
            type: "object", required: ["type"],
            properties: {
              type: { type: "string", enum: ["command", "file", "doc", "user_statement", "tool_result"] },
              ref: { type: "string" }, digest: { type: "string" }, supports: { type: "array", items: { type: "string" } }
            }
          }
        },
        gaps: { type: "array", maxItems: 16, items: { type: "string" } }
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
  {
    name: "orgbrain_learning_batch_ingest",
    description: "Persist explicit task commitments, verified memories, and autonomous quarantine candidates as one idempotent local batch.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string" },
        project_id: { type: ["string", "null"] },
        task_key: { type: ["string", "null"] },
        source: { type: "string", maxLength: 64 },
        prompt_contract_id: { type: "string", maxLength: 128 },
        prompt_hash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        verifier_version: { type: "string", maxLength: 128 },
        contract_hash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        commitments: { type: "array", maxItems: 16, items: { type: "object" } },
        verified_items: { type: "array", maxItems: 3, items: { type: "object" } },
        deterministically_verified_items: { type: "array", maxItems: 3, items: { type: "object" } },
        review_candidates: { type: "array", maxItems: 3, items: { type: "object" } },
        quarantine_candidates: { type: "array", maxItems: 3, items: { type: "object" } },
        semantic_aliases: { type: "array", maxItems: 16, items: { type: "object" } }
      }
    }
  },
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
        task_id: { type: ["string", "null"] },
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
    name: "orgbrain_memory_impact_start",
    description: "Start run-level Memory Impact measurement for an eligible local execution.",
    inputSchema: {
      type: "object",
      required: ["external_run_id", "idempotency_key"],
      properties: {
        tenant_id: { type: "string" },
        project_id: { type: "string" },
        task_id: { type: "string" },
        trace_id: { type: "string" },
        external_run_id: { type: "string" },
        idempotency_key: { type: "string" },
        agent_name: { type: "string" },
        model: { type: "string" },
        occurred_at: { type: "number" }
      }
    }
  },
  {
    name: "orgbrain_memory_impact_report",
    description: "Report the assessed or failed result for one eligible local execution.",
    inputSchema: {
      type: "object",
      required: ["external_run_id", "idempotency_key"],
      properties: {
        tenant_id: { type: "string" },
        external_run_id: { type: "string" },
        idempotency_key: { type: "string" },
        outcome: { type: "string", enum: ["assessed", "failed"] },
        memory_used: { type: "boolean" },
        avoided_lookup: { type: "string", enum: ["source_search", "web_search", "past_context", "none"] },
        memory_basis_ids: { type: "array", items: { type: "string" }, maxItems: 20 },
        confidence: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
        failure_category: { type: "string", enum: ["agent_error", "tool_error", "cancelled", "unknown"] },
        occurred_at: { type: "number" }
      }
    }
  },
  {
    name: "orgbrain_memory_impact_metrics",
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
  if (name === "orgbrain_memory_observe") {
    const observe = input.schema_version === 2
      ? observeMemoryContractV2Event
      : observeMemoryLearningEvent;
    return observe(input, {
      workspaceRoot: process.cwd(),
      sensitivePolicy: { mode: "deny", allowed_principals: [] }
    });
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
  if (name === "orgbrain_learning_batch_ingest") {
    const expectedPromptHash = MEMORY_CONTRACT_V2_PROMPT_HASH;
    const expectedContractHash = MEMORY_CONTRACT_V2_CONTRACT_HASH;
    if (
      (input.prompt_contract_id && input.prompt_contract_id !== MEMORY_CONTRACT_V2_PROMPT_ID) ||
      (input.prompt_hash && input.prompt_hash !== expectedPromptHash) ||
      (input.contract_hash && input.contract_hash !== MEMORY_CONTRACT_V2_CONTRACT_HASH) ||
      (input.verifier_version && input.verifier_version !== MEMORY_CONTRACT_V2_VERIFIER_VERSION)
    ) throw new Error("memory contract prompt or verifier hash does not match the deployed contract");
    const commitmentStore = new TaskCommitmentStore(store.dbPath);
    const commitments = [];
    for (const commitment of (input.commitments ?? []).slice(0, 16)) {
      commitments.push(await commitmentStore.upsert({
        ...commitment,
        tenant_id: tenantId,
        project_id: input.project_id ?? commitment.project_id ?? null
      }));
    }
    const semanticAliases = [];
    for (const alias of (input.semantic_aliases ?? []).slice(0, 16)) {
      const saved = await commitmentStore.saveSemanticAlias({
        tenantId,
        projectId: input.project_id ?? alias.project_id ?? null,
        taskKey: alias.task_key,
        decisionKey: alias.decision_key,
        question: alias.question,
        judgeConsensus: alias.judge_consensus,
        certification: alias.ai_certification
      });
      if (!saved.saved) throw new Error(saved.reason ?? "semantic_alias_not_saved");
      semanticAliases.push(saved);
    }
    const candidateInputs = [...(input.review_candidates ?? []), ...(input.quarantine_candidates ?? [])]
      .filter((candidate, index, all) => {
        const key = String(candidate.external_key ?? `candidate-${index}`);
        return all.findIndex((other) => String(other.external_key ?? "") === key) === index;
      });
    const reviewCandidates = await commitmentStore.saveLearningCandidates({
      tenantId,
      projectId: input.project_id ?? null,
      taskKey: input.task_key ?? null,
      candidates: [
        ...candidateInputs,
        ...(input.deterministically_verified_items ?? []).slice(0, 3).map((item, index) => ({
          external_key: item.external_key ?? `learning-deterministic-review:${index}`,
          item,
          observation: item.learning ?? null,
          verification: item.verification ?? null,
          evidence: item.evidence ?? [],
          reason_codes: ["ai_consensus_pending"],
          capture_intent: "verify",
          created_at: item.created_at ?? Date.now(),
          expires_at: item.expires_at ?? item.valid_until ?? Date.now() + 180 * 24 * 60 * 60 * 1000
        }))
      ].slice(0, 3).map((candidate) => ({
        ...candidate,
        prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
        prompt_hash: expectedPromptHash,
        contract_hash: expectedContractHash,
        verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION
      }))
    });
    const verifiedResults = [];
    for (const originalItem of (input.verified_items ?? []).slice(0, 3)) {
      const item = originalItem?.learning && typeof originalItem.learning === "object"
        ? {
          ...originalItem,
          learning: {
            ...originalItem.learning,
            contract_metadata: {
              ...(originalItem.learning.contract_metadata && typeof originalItem.learning.contract_metadata === "object"
                ? originalItem.learning.contract_metadata
                : {}),
              prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
              prompt_hash: expectedPromptHash,
              contract_hash: expectedContractHash,
              verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
              producer_agent: input.source ?? "local",
              producer_model: null
            }
          }
        }
        : originalItem;
      if (!isAiConsensusCertified(item)) throw new Error("verified_items require unanimous ai_consensus_certified judges");
      if (item?.verification?.state !== "verified" || !Array.isArray(item?.evidence) || item.evidence.length === 0) {
        throw new Error("verified_items must contain deterministic verification state and evidence");
      }
      const backing = await commitmentStore.assertCandidateBacked({
        tenantId,
        projectId: input.project_id ?? item.project_id ?? null,
        item
      });
      if (!backing.ok) throw new Error(backing.reason);
      if (item?.learning?.schema_version !== 2) {
        throw new Error("verified_items must use LearningObservationV2; legacy observations remain review-only");
      }
      if (item.learning.capture_intent !== "verify") {
        throw new Error("verified_items must contain only verify observations");
      }
      if (item.learning.lesson_type === "decision" && ["user_choice", "preference"].includes(item.learning.decision_type)) {
        throw new Error("verified_items user choices and preferences must be stored as task commitments");
      }
      verifiedResults.push(await store.capture(captureDefaults({
        ...item,
        tenant_id: tenantId,
        project_id: input.project_id ?? item.project_id ?? null,
        source: item.source ?? input.source ?? "local-learning-contract",
        capture_origin: item.capture_origin ?? "observed",
        verification_state: item.verification_state ?? "verified",
        verified_at: item.verified_at ?? item.verification?.verified_at ?? Date.now()
      })));
    }
    return {
      ok: true,
      verified_inserted: verifiedResults.filter((result) => result?.created).length,
      review_inserted: reviewCandidates.length,
      quarantine_inserted: reviewCandidates.length,
      commitments: commitments.map((result) => result.commitment),
      semantic_aliases: semanticAliases,
      review_candidates: reviewCandidates,
      quarantine_candidates: reviewCandidates
    };
  }
  if (name === "orgbrain_memory_capture") return store.capture(captureDefaults(input));
  if (name === "orgbrain_memory_search") {
    const results = await store.search({
      tenant_id: tenantId,
      project_id: input.project_id || undefined,
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
      project_id: input.project_id || undefined,
      task_id: input.task_id || undefined,
      trace_id: input.trace_id || undefined,
      external_run_id: input.external_run_id || undefined,
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
  if (name === "orgbrain_memory_impact_start") {
    return store.startMemoryImpact(tenantId, input, process.env.USER || "local-user");
  }
  if (name === "orgbrain_memory_impact_report") {
    return store.reportMemoryImpactExecution(
      tenantId,
      input.external_run_id,
      input,
      process.env.USER || "local-user"
    );
  }
  if (name === "orgbrain_memory_impact_metrics") return store.memoryImpactReport(tenantId, input);
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
