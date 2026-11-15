import { previewLocalDomainRecall, queryLocalMetrics, recordLocalDomainRecallFeedback, searchLocalManagedObjects } from "../local-domain-recall.mjs";
import { canonicalLocalProjectId } from "./common.mjs";

export const knowledgeDefinitions = [
  {
    name: "orgbrain_wiki_assess",
    description: "Assess selected LLM Wiki sections against original evidence and scoped memories. Returns prediction and one parent review bundle; never saves or revises memories.",
    inputSchema: { type: "object", required: ["project_id"], properties: {
      project_id: { type: "string", minLength: 1 }, tenant_id: { type: "string" },
      pages: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string" } },
      vault: { type: "string" }, changed_since: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 }, principal_id: { type: ["string", "null"] }
    } }
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
  }
];

export async function callKnowledge(store, name, input, toolProfile = "default") {
  const tenantId = input.tenant_id || "default";
  if (name === "orgbrain_wiki_assess") {
    const { assessLocalWiki } = await import("../wiki-memory-assessment.mjs");
    const changedSince = input.changed_since ? Date.parse(input.changed_since) : null;
    if (changedSince !== null && !Number.isFinite(changedSince)) throw new Error("invalid_wiki_changed_since");
    return assessLocalWiki({ store, dbPath: store.dbPath, projectId: await canonicalLocalProjectId(input.project_id), tenantId,
      vault: input.vault, pages: input.pages, changedSince, limit: input.limit ?? 10, principalId: input.principal_id ?? null });
  }
  if (name === "orgbrain_domain_context") return previewLocalDomainRecall(store, { ...input, prompt: input.query });
  if (name === "orgbrain_managed_object_search") return searchLocalManagedObjects(store, input);
  if (name === "orgbrain_metric_query") return queryLocalMetrics(store, input);
  if (name === "orgbrain_domain_recall_feedback") return recordLocalDomainRecallFeedback(store, input);
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
  throw new Error(`unknown tool: ${name}`);
}
