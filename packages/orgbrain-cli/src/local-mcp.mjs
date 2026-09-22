import { observeMemoryUse } from "./lib/memory-use-collector.mjs";
import { answerGuidanceForDisposition } from "../../shared/src/evidence-disposition.mjs";
import {
  classifyMemoryReviewAnswer,
  memoryCategoryFromReviewAnswer,
  MEMORY_REVIEW_LABELS,
  withMemoryCategoryTags
} from "../../shared/src/memory-usefulness-runtime.mjs";
import { useHash } from "../../shared/src/memory-use-history-runtime.mjs";
import { randomUUID } from "node:crypto";
import {
  createMcpHandler,
  fromJsonSchema,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
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
import {
  previewLocalDomainRecall,
  queryLocalMetrics,
  recallBundleMarkdown,
  recordLocalDomainRecallFeedback,
  searchLocalManagedObjects
} from "./lib/local-domain-recall.mjs";

const LOCAL_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
// Calibrated for the high-precision bridge; explicit callers may lower it.
const DEFAULT_CONTEXT_MINIMUM_TOTAL_SCORE = 0.065;
export const LOCAL_MCP_PROTOCOL_VERSION = "2026-07-28";
export const LOCAL_MCP_COMPAT_PROTOCOL_VERSION = "2025-11-25";
const ORGBRAIN_TOOL_PRESENTATION = Object.freeze({
  title: "OrgBrain",
  _meta: Object.freeze({
    "openai/toolInvocation/invoking": "OrgBrainを使用しています…",
    "openai/toolInvocation/invoked": "OrgBrainを使用しました"
  })
});

const TOOL_DEFINITIONS = [
  {name:"orgbrain_memories_confirmation_status",description:"Read a local proposal or durable save receipt after an uncertain response. Does not save or ask again.",inputSchema:{type:"object",required:["confirmation_token"],properties:{tenant_id:{type:"string"},confirmation_token:{type:"string",minLength:1,maxLength:64}}}},
  {
    name: "orgbrain_memories_propose",
    description: "Propose one local memory and inferred rationale without persisting it. Show the conclusion and reason to the user before confirming.",
    inputSchema: {
      type: "object",
      required: ["item"],
      properties: {
        tenant_id: { type: "string" },
        source: { type: "string" },
        review_context: {type:"object",required:["candidate_id","candidate_hash","source_references"],properties:{
          candidate_id:{type:"string",maxLength:128},candidate_hash:{type:"string",pattern:"^[a-f0-9]{64}$"},
          source_references:{type:"array",maxItems:8,items:{type:"object"}},
          conclusion:{type:"string",maxLength:2000},reason_summary:{type:"string",maxLength:2000},reuse_rule:{type:"string",maxLength:2000}
        }},
        actor_type: { type: "string" },
        actor_id: { type: "string" },
        item: {
          type: "object",
          required: ["content"],
          properties: {
            external_key: { type: "string", maxLength: 256 },
            content: { type: "string", minLength: 1, maxLength: 20000 },
            summary: { type: "string", maxLength: 1000 },
            tags: { type: "array", maxItems: 16, items: { type: "string", maxLength: 64 } },
            created_at: { type: "integer" },
            project_id: { type: ["string", "null"], maxLength: 128 },
            business_category_id: { type: ["string", "null"], maxLength: 128 },
            work_type: { type: ["string", "null"] }
          }
        },
        entities: { type: "array", maxItems: 8, items: { type: "object" } },
        evidence: { type: "array", maxItems: 8, items: { type: "object" } }
      }
    }
  },
  {
    name: "orgbrain_memories_confirm",
    description: "Persist a previously proposed local memory only after explicit user confirmation.",
    inputSchema: {
      type: "object",
      required: ["confirmation_token", "approved"],
      properties: {
        tenant_id: { type: "string" },
        confirmation_token: { type: "string", minLength: 1, maxLength: 64 },
        approved: { type: "boolean" },
        review_label:{type:"string",enum:MEMORY_REVIEW_LABELS},
        review_answer:{type:"string",maxLength:2000},
        corrected_content: { type: "string", maxLength: 20000 },
        corrected_summary: { type: "string", maxLength: 1000 },
        conclusion: { type: "string", maxLength: 240 },
        reason_summary: { type: "string", maxLength: 500 },
        reuse_rule: { type: "string", maxLength: 2000 },
        decision_type: { type: "string", enum: ["adopt", "reject", "prioritize", "diagnose", "workaround", "policy"] },
        status: { type: "string", maxLength: 64 },
        entities: { type: "array", maxItems: 8, items: { type: "object" } },
        evidence: { type: "array", maxItems: 8, items: { type: "object" } }
      }
    }
  },
  {
    name: "orgbrain_context_enrich",
    description: "Retrieve local memory context and optional Domain Recall. Network-free by default; explicitly enabled Jev judgment sends bounded redacted evidence to OpenRouter.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        query: { type: "string" }, tenant_id: { type: "string" }, project_id: { type: ["string", "null"] },
        principal_id: { type: ["string", "null"] }, include_domain_recall: { type: "boolean" },
        task_title: { type: ["string", "null"], maxLength: 500 }, task_description: { type: ["string", "null"], maxLength: 4000 },
        task_id: { type: "string", maxLength: 128 }, work_type: { type: "string", enum: ["implementation", "review", "debug", "proposal", "support", "research", "operations", "other"] },
        use_context: { type: "object", properties: { task: { type: "string", maxLength: 4000 }, target: { type: "string", maxLength: 1000 }, constraints: { type: "string", maxLength: 4000 }, conditions: { type: "string", maxLength: 4000 } } },
        minimum_total_score: { type: ["number", "null"], minimum: 0 }, top_k: { type: "integer", minimum: 1, maximum: 10 }, token_budget: { type: "integer", minimum: 512, maximum: 16000 },
        context_format: { type: "string", enum: ["compact", "full"], description: "Compact preserves complete lessons and reuse conditions within the complete response budget; full includes historical projections." },
        object_type_key: { type: ["string", "null"] }, object_id: { type: ["string", "null"] }, scope: { type: "object" }
      }
    }
  },
  {
    name: "orgbrain_domain_context",
    description: "Use before answering an organization-specific question. Return a relevance-gated local Decision with rationale, rejected alternatives, constraints, success conditions, metrics, evidence, follow-up, and a trace link. Cite the trace when the answer uses this memory.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        query: { type: "string" }, tenant_id: { type: "string" }, project_id: { type: ["string", "null"] },
        principal_id: { type: ["string", "null"] }, session_id: { type: ["string", "null"] },
        object_type_key: { type: ["string", "null"] }, object_id: { type: ["string", "null"] }, scope: { type: "object" }
      }
    }
  },
  {
    name: "orgbrain_managed_object_search",
    description: "Search ACL-filtered managed objects in local SQLite.",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, tenant_id: { type: "string" }, project_id: { type: ["string", "null"] }, object_type_key: { type: ["string", "null"] }, principal_id: { type: ["string", "null"] }, limit: { type: "integer", minimum: 1, maximum: 50 } } }
  },
  {
    name: "orgbrain_metric_query",
    description: "Query aggregate local metric snapshots; stale and unknown values are numeric-free.",
    inputSchema: { type: "object", properties: { tenant_id: { type: "string" }, project_id: { type: ["string", "null"] }, metric_key: { type: ["string", "null"] }, scope_id: { type: ["string", "null"] }, limit: { type: "integer", minimum: 1, maximum: 200 } } }
  },
  {
    name: "orgbrain_domain_recall_feedback",
    description: "Record a user's correction without mutating the Decision. Map 範囲が違う to wrong_scope, 古い to outdated, 関係ない to not_relevant, 関係が違う to incorrect_relation, and この会話では使わない to dismiss_for_session.",
    inputSchema: { type: "object", required: ["recall_id", "feedback"], properties: { tenant_id: { type: "string" }, recall_id: { type: "string" }, candidate_id: { type: ["string", "null"] }, principal_id: { type: ["string", "null"] }, session_id: { type: ["string", "null"] }, feedback: { type: "string", enum: ["useful", "not_relevant", "wrong_scope", "outdated", "incorrect_relation", "dismiss_for_session"] }, note: { type: ["string", "null"] } } }
  },
  {
    name: "orgbrain_memory_observe",
    description: "Validate one current-turn durable learning event without persisting it. Use at most three times per turn.",
    inputSchema: {
      type: "object",
      required: ["schema_version", "lesson_type"],
      properties: {
        schema_version: { type: "integer", enum: [1, 2] },
        use_observation: {type:"object"},
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
        use_snapshot_id:{type:"string",maxLength:128},
        use_context:{type:"object",properties:{task:{type:"string",maxLength:600},target:{type:"string",maxLength:600},constraints:{type:"string",maxLength:600},conditions:{type:"string",maxLength:600}}},
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

export const LOCAL_MCP_TOOL_PROFILES = Object.freeze({
  default: null,
  "answer-ux-readonly": Object.freeze([
    "orgbrain_context_enrich",
    "orgbrain_domain_context"
  ])
});

function toolDefinitionsForProfile(profile = "default") {
  if (!Object.hasOwn(LOCAL_MCP_TOOL_PROFILES, profile)) {
    throw new Error(`unknown MCP tool profile: ${profile}`);
  }
  const allowed = LOCAL_MCP_TOOL_PROFILES[profile];
  if (allowed === null) return TOOL_DEFINITIONS;
  const allowedSet = new Set(allowed);
  const definitions = TOOL_DEFINITIONS.filter((definition) => allowedSet.has(definition.name));
  if (definitions.length !== allowed.length) throw new Error(`incomplete MCP tool profile: ${profile}`);
  return definitions;
}

function content(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function boundedString(value, limit, fallback = null) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, limit) : fallback;
}

function screenInteractiveMemory(value, field) {
  const text = boundedString(value, 20_000);
  if (!text) throw new Error(`${field}_required`);
  const sensitivePatterns = [
    /\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)\s*[:=]\s*[^\s,;]+/iu,
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/u
  ];
  if (sensitivePatterns.some((pattern) => pattern.test(text))) {
    throw new Error(`${field}_contains_sensitive_data`);
  }
  return text;
}

function rationaleProposal(item) {
  const sentences = item.content.split(/(?<=[。.!?])\s+|\n+/u).map((value) => value.trim()).filter(Boolean);
  const reason = sentences.find((sentence) => /^(?:理由|原因)\s*[:：]/u.test(sentence))
    ?? sentences.find((sentence) => /(?:理由|原因|because|root cause)/iu.test(sentence))
    ?? sentences.slice(0, 3).join(" ");
  return {
    decision_type: /(?:原則|必ず|使わず|毎回|再利用せず)/u.test(item.content) ? "policy" : "workaround",
    conclusion: boundedString(item.summary, 240) ?? boundedString(sentences[0], 240, "No conclusion extracted"),
    reason_summary: boundedString(reason?.replace(/^(?:理由|原因)\s*[:：]\s*/u, ""), 500, item.content),
    status: "accepted",
    confidence_score: 0.55
  };
}

function normalizedEntities(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((entity) => {
    const name = boundedString(entity?.name, 128);
    return name ? [{
      name,
      entity_type: boundedString(entity?.entity_type, 32, "unknown"),
      role: boundedString(entity?.role, 32, "subject"),
      confidence_score: Number.isFinite(entity?.confidence_score) ? entity.confidence_score : null,
      external_ref: boundedString(entity?.external_ref, 256)
    }] : [];
  });
}

function normalizedEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((entry) => {
    const reference = boundedString(entry?.evidence_ref, 512);
    return reference ? [{
      evidence_type: boundedString(entry?.evidence_type, 32, "external"),
      evidence_ref: reference,
      relation: boundedString(entry?.relation, 32, "supports"),
      note: boundedString(entry?.note, 500),
      weight_score: Number.isFinite(entry?.weight_score) ? entry.weight_score : null
    }] : [];
  });
}

function localReviewContext(raw) {
  if(raw===undefined) return undefined;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.candidate_id!=='string'||!raw.candidate_id||raw.candidate_id.length>128
    ||!(/^[a-f0-9]{64}$/u.test(raw.candidate_hash))||!Array.isArray(raw.source_references)||raw.source_references.length>8) throw new Error('invalid_review_context');
  const value={candidate_id:raw.candidate_id,candidate_hash:raw.candidate_hash,
    source_references:raw.source_references.map(ref=>{
      if(!ref||typeof ref!=='object'||typeof ref.ref!=='string'||!ref.ref||ref.ref.length>512) throw new Error('invalid_review_source');
      const structuralRef=/^turn:(?:sha256:)?[a-f0-9]{64}#[A-Za-z0-9._:-]+$/u.test(ref.ref);
      const result={ref:structuralRef?ref.ref:screenInteractiveMemory(ref.ref,'review_source')};
      for(const key of ['type','span_id','parent_span_id','role','content_hash']) if(ref[key]!=null) {
        if(typeof ref[key]!=='string'||ref[key].length>128) throw new Error('invalid_review_source');
        result[key]=key==='content_hash'&&/^(?:sha256:)?[a-f0-9]{64}$/u.test(ref[key])?ref[key]:screenInteractiveMemory(ref[key],'review_source');
      }
      return result;
    })};
  for(const key of ['conclusion','reason_summary','reuse_rule']) if(raw[key]!=null) {
    if(typeof raw[key]!=='string'||raw[key].length>2000) throw new Error('invalid_review_context');
    value[key]=screenInteractiveMemory(raw[key],key);
  }
  return value;
}

async function proposeLocalMemory(store, input) {
  if (!input?.item || typeof input.item !== "object") throw new Error("item_required");
  const tenantId = boundedString(input.tenant_id, 128, "default");
  const item = {
    external_key: boundedString(input.item.external_key, 256),
    content: screenInteractiveMemory(input.item.content, "item.content"),
    summary: input.item.summary == null ? null : screenInteractiveMemory(input.item.summary, "item.summary").slice(0, 1000),
    tags: Array.isArray(input.item.tags)
      ? [...new Set(input.item.tags.map((tag) => boundedString(tag, 64)).filter(Boolean))].slice(0, 16)
      : [],
    created_at: Number.isInteger(input.item.created_at) ? input.item.created_at : Date.now(),
    project_id: boundedString(input.item.project_id, 128),
    business_category_id: boundedString(input.item.business_category_id, 128),
    work_type: boundedString(input.item.work_type, 32)
  };
  const reviewContext=localReviewContext(input.review_context);
  const proposedRationale = rationaleProposal(item);
  if(reviewContext) {
    proposedRationale.conclusion=reviewContext.conclusion??item.summary??item.content;
    proposedRationale.reason_summary=reviewContext.reason_summary??'未確認';
    item.content=[proposedRationale.conclusion,`理由: ${proposedRationale.reason_summary}`,`再利用条件: ${reviewContext.reuse_rule??'未確認'}`].join('\n');
    item.summary=proposedRationale.conclusion.slice(0,1000);
    item.external_key=item.external_key||`review:${reviewContext.candidate_id}`;
  }
  const now = Date.now();
  const token = randomUUID();
  const payload = {
    tenant_id: tenantId,
    source: boundedString(input.source, 64, "local-mcp"),
    actor_type: boundedString(input.actor_type, 64, "principal"),
    actor_id: boundedString(input.actor_id, 128, process.env.USER || "local-user"),
    review_context:reviewContext,
    proposed_memory: item,
    proposed_rationale: proposedRationale,
    proposed_entities: normalizedEntities(input.entities),
    proposed_evidence: normalizedEvidence(input.evidence),
    expires_at: now + LOCAL_CONFIRMATION_TTL_MS
  };
  await store.saveMcpConfirmation({
    token,
    tenant_id: tenantId,
    payload,
    created_at: now,
    expires_at: payload.expires_at
  });
  return {
    tenant_id: tenantId,
    source: payload.source,
    confirmation_token: token,
    candidate_id:reviewContext?.candidate_id??null,
    proposed_memory: item,
    proposed_rationale: { ...proposedRationale, confirmation_state: "inferred_unconfirmed" },
    proposed_entities: payload.proposed_entities,
    proposed_evidence: payload.proposed_evidence
  };
}

async function confirmLocalMemory(store, input) {
  const tenantId = boundedString(input?.tenant_id, 128, "default");
  const token = boundedString(input?.confirmation_token, 64);
  if (!token) throw new Error("confirmation_token_required");
  let rationaleId = null;
  let confirmationState = null;
  let reviewLabel=null;
  const answer=input.review_answer==null?null:screenInteractiveMemory(input.review_answer,'review_answer');
  const selectedCategory=memoryCategoryFromReviewAnswer(answer);
  const consumed = await store.consumeMcpConfirmation({
    token,
    tenant_id: tenantId,
    approved: input.approved,
    requestHash:await useHash({...input,tenant_id:tenantId}),
    validateConfirmation(payload) {
      if(typeof input.approved!=='boolean') throw new Error('confirmation_approval_required');
      if(answer&&answer.length>2000) throw new Error('invalid_review_answer');
      const answerLabel=answer===null?null:classifyMemoryReviewAnswer(answer);
      const modified=Boolean(input.corrected_content||input.corrected_summary
        ||input.conclusion&&input.conclusion!==payload.proposed_rationale.conclusion
        ||input.reason_summary&&input.reason_summary!==payload.proposed_rationale.reason_summary
        ||input.decision_type&&input.decision_type!==payload.proposed_rationale.decision_type
        ||input.reuse_rule!=null&&input.reuse_rule!==payload.review_context?.reuse_rule
        ||input.entities?.length||input.evidence?.length);
      reviewLabel=input.review_label??answerLabel??(input.approved?(modified?'corrected':'accepted'):'not_needed');
      if(!MEMORY_REVIEW_LABELS.includes(reviewLabel)||input.review_label&&answerLabel&&input.review_label!==answerLabel) throw new Error('review_label_mismatch');
      if(payload.review_context&&!answer) throw new Error('review_answer_required');
      if(input.approved&&!['accepted','corrected'].includes(reviewLabel)||!input.approved&&['accepted','corrected'].includes(reviewLabel)) throw new Error('review_not_approved');
      if(input.approved&&answerLabel&&!['accepted','corrected'].includes(answerLabel)) throw new Error('review_not_approved');
      if(payload.review_context&&input.approved&&modified&&answerLabel!=='corrected') throw new Error('correction_not_approved');
      if(payload.review_context&&input.approved&&reviewLabel==='corrected'&&!input.corrected_content) throw new Error('corrected_content_required');
    },
    buildReceipt(payload,saved) {
      return {tenant_id:tenantId,approved:input.approved,saved:input.approved===true,
        ...(saved?{memory_id:saved.memory_id,rationale_id:rationaleId,confirmation_state:confirmationState}:{}),
        candidate_id:payload.review_context?.candidate_id??null,review_label:reviewLabel,review_answer:answer??'',
        memory_category:selectedCategory};
    },
    buildCaptureInput(payload) {
      const conclusion = boundedString(input.conclusion || input.corrected_summary || input.corrected_content, 240, payload.proposed_rationale.conclusion);
      const reason = boundedString(input.reason_summary, 500, payload.proposed_rationale.reason_summary);
      screenInteractiveMemory(conclusion, "conclusion");
      screenInteractiveMemory(reason, "reason_summary");
      const corrected = Boolean(input.corrected_content || input.corrected_summary) || conclusion !== payload.proposed_rationale.conclusion ||
        reason !== payload.proposed_rationale.reason_summary ||
        (input.decision_type && input.decision_type !== payload.proposed_rationale.decision_type) ||
        (Array.isArray(input.entities) && input.entities.length > 0) ||
        (Array.isArray(input.evidence) && input.evidence.length > 0);
      const entities = Array.isArray(input.entities) && input.entities.length > 0
        ? normalizedEntities(input.entities)
        : payload.proposed_entities;
      const evidence = Array.isArray(input.evidence) && input.evidence.length > 0
        ? normalizedEvidence(input.evidence)
        : payload.proposed_evidence;
      rationaleId = randomUUID();
      confirmationState = corrected ? "user_corrected" : "user_confirmed";
      return captureDefaults({
        ...payload.proposed_memory,
        tenant_id: tenantId,
        source: payload.source,
        source_references:payload.review_context?.source_references??[],
        actor_type: payload.actor_type,
        actor_id: payload.actor_id,
        kind: "semantic",
        tags: withMemoryCategoryTags(payload.proposed_memory.tags, selectedCategory),
        content: input.corrected_content ? screenInteractiveMemory(input.corrected_content, "corrected_content") : corrected ? `${conclusion}\n理由: ${reason}` : payload.proposed_memory.content,
        summary: input.corrected_summary ? screenInteractiveMemory(input.corrected_summary, "corrected_summary") : conclusion,
        rationale: reason,
        reuse_rule:input.reuse_rule!=null?screenInteractiveMemory(input.reuse_rule,'reuse_rule')
          :input.corrected_content?null:payload.review_context?.reuse_rule??null,
        entities: entities.map((entity) => entity.name),
        evidence: [...evidence, {
          evidence_type: "memory",
          evidence_ref: `local-rationale:${rationaleId}`,
          relation: "context_for",
          confirmation_state: confirmationState
        }]
      });
    }
  });
  return consumed.receipt;
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

async function callTool(store, name, input, toolProfile = "default") {
  const tenantId = input.tenant_id || "default";
  if (name === "orgbrain_memories_confirmation_status") return store.mcpConfirmationStatus({token:boundedString(input.confirmation_token,64),tenant_id:tenantId});
  if (name === "orgbrain_memories_propose") return proposeLocalMemory(store, input);
  if (name === "orgbrain_memories_confirm") return confirmLocalMemory(store, input);
  if (name === "orgbrain_context_enrich") {
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
    const memory = await store.retrieveContext({
      tenant_id: tenantId,
      project_id: input.project_id ?? null,
      work_type: input.work_type ?? "other",
      task_id: boundedString(input.task_id ?? input.task_title, 128) ?? "context-enrich",
      use_context: useContext,
      query: input.query,
      top_k: input.top_k ?? 5,
      token_budget: input.token_budget ?? (contextFormat === "full" ? 6_000 : 1_500),
      context_format: contextFormat,
      minimum_total_score: input.minimum_total_score ?? DEFAULT_CONTEXT_MINIMUM_TOTAL_SCORE,
      principal_id: input.principal_id ?? null,
      search_mode: "hybrid_v4"
    });
    const recall = input.include_domain_recall ? await previewLocalDomainRecall(store, { ...input, prompt: input.query }) : null;
    return { ...memory, ...(recall ? { domain_recall: recall.bundle, domain_recall_markdown: recall.inject ? recallBundleMarkdown(recall.bundle) : "" } : {}) };
  }
  if (name === "orgbrain_domain_context") return previewLocalDomainRecall(store, { ...input, prompt: input.query });
  if (name === "orgbrain_managed_object_search") return searchLocalManagedObjects(store, input);
  if (name === "orgbrain_metric_query") return queryLocalMetrics(store, input);
  if (name === "orgbrain_domain_recall_feedback") return recordLocalDomainRecallFeedback(store, input);
  if (name === "orgbrain_memory_observe") {
    if (input.use_observation) return observeMemoryUse(input.use_observation);
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
      task_id: input.task_id, use_context: input.use_context,use_snapshot_id:input.use_snapshot_id,
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
    return { results, meta: { usage_id: usage.usage_id, usage_item_ids:usage.usage_item_ids,usage_items:usage.usage_items, verification_sampled: usage.verification_sampled, use_history:results[0]?.use_history_meta } };
  }
  if (name === "orgbrain_memory_retrieve_context") {
    return store.retrieveContext({
      tenant_id: tenantId,
      project_id: input.project_id || null,
      business_category_id: input.business_category_id || null,
      work_type: input.work_type || null,
      query: input.query,
      task_id:input.task_id,use_context:input.use_context,use_snapshot_id:input.use_snapshot_id,
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
  const useOperations = {orgbrain_memory_use_context_record:"record",orgbrain_memory_use_history:"history",orgbrain_memory_use_evaluate:"evaluate",orgbrain_memory_use_revoke:"revoke"};
  if (useOperations[name]) return store.useHistory(useOperations[name], {...input.payload,tenant_id:tenantId,principal_id:process.env.ORGBRAIN_USE_PRINCIPAL || "local"});
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

export function sanitizeAnswerUxToolResult(name, result) {
  if (name === "orgbrain_context_enrich") {
    const summaryByMemoryId = new Map((result?.results ?? []).map((item) => [
      item?.memory?.id,
      boundedString(item?.memory?.summary, 500) ?? boundedString(item?.memory?.content, 500)
    ]));
    const bundle = result?.evidence_bundle ?? {};
    return {
      evidence_bundle: {
        query_at: bundle.query_at ?? null,
        evidence_status: bundle.evidence_status ?? "insufficient",
        answer_template: bundle.answer_template ?? "abstention",
        evidence: (bundle.evidence ?? []).slice(0, 3).map((item) => ({
          summary: summaryByMemoryId.get(item?.memory_id) ?? boundedString(item?.text, 500),
          source_ref: boundedString(item?.source_reference?.ref, 500)
        })),
        conflicts_count: Number.isInteger(bundle.conflicts_count) ? bundle.conflicts_count
          : Array.isArray(bundle.conflicts) ? bundle.conflicts.length : 0,
        missing_evidence: Array.isArray(bundle.missing_evidence) ? bundle.missing_evidence : [],
        abstention_recommended: bundle.abstention_recommended === true,
        degraded_reasons: Array.isArray(bundle.degraded_reasons) ? bundle.degraded_reasons : [],
        answer_guidance: bundle.answer_guidance ?? answerGuidanceForDisposition(
          { evidence_status: bundle.evidence_status ?? "insufficient" },
          (bundle.evidence ?? []).map((item) => item.source_reference)
        )
      },
      ...(typeof result?.domain_recall_markdown === "string" && result.domain_recall_markdown
        ? { domain_recall_markdown: result.domain_recall_markdown }
        : {})
    };
  }
  if (name === "orgbrain_domain_context") {
    return {
      inject: result?.inject === true,
      reason: boundedString(result?.reason, 160),
      answer_context_markdown: result?.inject && result?.bundle ? recallBundleMarkdown(result.bundle) : ""
    };
  }
  return result;
}

function profileToolResult(toolProfile, name, result) {
  return toolProfile === "answer-ux-readonly" ? sanitizeAnswerUxToolResult(name, result) : result;
}

function normalizeSearchMode(mode) {
  if (mode === "hybrid_v3" || mode === "lexical") return "hybrid_v3";
  if (mode === "hybrid_v4" || mode === "hybrid" || mode === "structured" || mode === "default") return "hybrid_v4";
  return mode;
}

export async function handleLocalMcpRequest(store, request, options = {}) {
  const toolProfile = options.toolProfile ?? "default";
  const definitions = toolDefinitionsForProfile(toolProfile);
  if (request.method === "initialize") {
    throw Object.assign(new Error(`unsupported protocol version; use ${LOCAL_MCP_PROTOCOL_VERSION}`), { code: -32001 });
  }
  if (request.method === "ping") return {};
  if (request.method === "server/discover") {
    return { supportedVersions: [LOCAL_MCP_PROTOCOL_VERSION], ttlMs: 300_000, cacheScope: "private" };
  }
  if (request.method === "tools/list") return { tools: definitions };
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (!definitions.some((definition) => definition.name === name)) {
      throw Object.assign(new Error(`tool not available in active profile: ${name}`), { code: -32601 });
    }
    const input = request.params?.arguments || {};
    try {
      const result = await callTool(store, name, input, toolProfile);
      return { content: content(profileToolResult(toolProfile, name, result)), isError: false };
    } catch (error) {
      return {
        content: content({ error: error instanceof Error ? error.message : String(error) }),
        isError: true
      };
    }
  }
  throw Object.assign(new Error(`method not found: ${request.method}`), { code: -32601 });
}

export function createLocalMcpServer(store, {
  protocolVersion = LOCAL_MCP_PROTOCOL_VERSION,
  toolProfile = "default"
} = {}) {
  const definitions = toolDefinitionsForProfile(toolProfile);
  const server = new McpServer(
    { name: "OrgBrain Local", version: "0.1.0" },
    {
      instructions: "Search OrgBrain before repeating source discovery. Use propose then confirm for interactive memory writes.",
      supportedProtocolVersions: [protocolVersion],
      cacheHints: {
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
        "tools/list": { ttlMs: 300_000, cacheScope: "private" }
      }
    }
  );
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        ...ORGBRAIN_TOOL_PRESENTATION,
        description: definition.description,
        inputSchema: fromJsonSchema(definition.inputSchema)
      },
      async (input) => {
        try {
          const result = await callTool(store, definition.name, input, toolProfile);
          return { content: content(profileToolResult(toolProfile, definition.name, result)), isError: false };
        } catch (error) {
          return {
            content: content({ error: error instanceof Error ? error.message : String(error) }),
            isError: true
          };
        }
      }
    );
  }
  return server;
}

export function createLocalMcpHttpHandler(store, options = {}) {
  const protocolVersion = options.protocolVersion ?? LOCAL_MCP_PROTOCOL_VERSION;
  const allowedHostnames = options.allowedHostnames ?? localhostAllowedHostnames();
  const allowedOriginHostnames = options.allowedOriginHostnames ?? localhostAllowedOrigins();
  const handler = createMcpHandler(
    () => createLocalMcpServer(store, { protocolVersion, toolProfile: options.toolProfile ?? "default" }),
    {
      legacy: options.legacy ?? "reject",
      route: options.route ?? "/mcp"
    }
  );
  return {
    ...handler,
    async fetch(request) {
      const rejected = hostHeaderValidationResponse(request, allowedHostnames)
        ?? originValidationResponse(request, allowedOriginHostnames);
      return rejected ?? handler.fetch(request);
    }
  };
}

export async function startLocalMcp(store, options = {}) {
  await store.init();
  const compatibility = options.compatibility === true;
  if (compatibility) {
    const deadline = Date.parse(String(options.legacyUntil ?? ""));
    if (!Number.isFinite(deadline)) throw new Error("--legacy-until must be a valid ISO-8601 timestamp");
    if (deadline <= Date.now()) throw new Error("local MCP compatibility deadline has expired");
  }
  return serveStdio(
    () => createLocalMcpServer(store, {
      protocolVersion: compatibility ? LOCAL_MCP_COMPAT_PROTOCOL_VERSION : LOCAL_MCP_PROTOCOL_VERSION,
      toolProfile: options.toolProfile ?? "default"
    }),
    {
      legacy: compatibility ? "serve" : "reject",
      onerror: (error) => process.stderr.write(`orgbrain mcp: ${error.message}\n`)
    }
  );
}
