import { randomUUID } from "node:crypto";
import { countContextTokens, measureCompactMemoryContext } from "./compact-memory-context.mjs";

export const WORKING_LLM_GUIDANCE = "Pending candidates only; previews are not evidence or adopted memory. Select relevant IDs, or [] if none apply. Before applying EVERY selected candidate, fetch its full pinned version with orgbrain_memory_get using the same tenant, principal and task scope; verify sources, current facts, conflicts and complete reuse conditions. Failed or stale detail reads require abstention for that candidate. Detail retrieval is not use; record used/not_used separately from actual subsequent work.";
const present = (value) => typeof value === "string" && value.trim().length > 0;
const short = (value, max = 256) => typeof value === "string" && value.length <= max ? value : null;
const omitNullMetadata = (value) => {
  if (Array.isArray(value)) return value.map(omitNullMetadata);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== null).map(([key, item]) => [key, omitNullMetadata(item)]));
  return value;
};

// Keep complete applicability text. Budget packers omit whole candidates rather
// than cutting a condition. Only canonical, bounded metadata enters the preview.
export function workingLlmCandidate(memory, context = {}) {
  const values = [present(memory.summary) ? memory.summary : memory.content, memory.rationale, memory.reuse_rule]
    .filter(present);
  const unique = [...new Set(values)];
  const reference = memory.source_references?.[0];
  const sourceReference = reference && typeof reference === "object"
    ? Object.fromEntries(["ref", "source", "source_id", "version", "content_hash", "captured_at"]
      .filter((key) => typeof reference[key] === "number" || short(reference[key], key === "ref" ? 512 : 256) !== null)
      .map((key) => [key, reference[key]])) : null;
  return {
    memory_id: memory.id,
    ...(memory.kind == null ? {} : {kind:memory.kind}),
    current_version: memory.current_version,
    preview: unique.join("\n"),
    preview_basis: present(memory.summary) ? "summary_rationale_reuse_rule" : "content_fallback_rationale_reuse_rule",
    full_body_omitted: present(memory.content) && !unique.includes(memory.content),
    scope: omitNullMetadata({ project_id: memory.project_id ?? null, business_category_id: memory.business_category_id ?? null,
      work_type: memory.work_type ?? null, scope_type: memory.scope_type ?? null, scope_key: short(memory.scope_key) }),
    verification: omitNullMetadata({ verification_state: memory.verification_state ?? null, confirmation_state: memory.confirmation_state ?? null,
      conflict_count: memory.conflicts?.length ?? 0 }),
    validity: omitNullMetadata({ lifecycle_state: memory.lifecycle_state ?? null, valid_from: memory.valid_from ?? null,
      valid_until: memory.valid_until ?? null, expires_at: memory.expires_at ?? null }),
    ...(sourceReference === null ? {} : {source_reference:omitNullMetadata(sourceReference)}),
    additional_source_count: Math.max(0, (memory.source_references?.length ?? 0) - 1),
    detail_ref: { tool: "orgbrain_memory_get", arguments: { tenant_id: memory.tenant_id ?? "default",
      memory_id: memory.id, expected_version: memory.current_version,
      ...Object.fromEntries(["principal_id","project_id","business_category_id","work_type"]
        .filter(key => Object.hasOwn(context,key) && context[key] != null).map(key => [key,context[key]])) } }
  };
}

export function workingLlmCandidates(results, limit = 20, context = {}) {
  return results.slice(0, limit).map(({ memory }) => workingLlmCandidate(memory, context));
}

// One projection is shared by CLI and MCP, including version-pinned receipts.
export function memorySearchDelivery(selection, limit) {
  const pending = selection.local_relevance?.status === "pending_host_selection";
  const results = pending ? [] : selection.results.slice(0, limit);
  const candidates = pending ? (selection.candidates ?? []).slice(0, limit) : null;
  const items = pending ? candidates.map((candidate, index) => ({ source_type:"memory", source_id:candidate.memory_id,
    source_version:candidate.current_version, rank:index+1, reference_type:"returned", used_state:"unknown" }))
    : results.map(({memory,score}, index) => ({ source_type:"memory", source_id:memory.id, source_version:memory.current_version,
      rank:index+1, score:score?.total ?? null, reference_type:"returned", used_state:"unknown" }));
  return { results, ...(pending ? {candidates, selection_guidance:WORKING_LLM_GUIDANCE} : {}), items,
    local_relevance: selection.local_relevance ? {...selection.local_relevance,
      ...(pending ? {returned_candidate_count:candidates.length} : {})} : null };
}

export function buildWorkingLlmContext({ candidates, topK = 20, tokenBudget = 1500, at = Date.now(),
  usageId = randomUUID(), localRelevance = {}, envelope = {}, contextFormat = "compact" }) {
  const selected = [];
  let budgetLimited = false;
  const responseFor = (entries) => measureCompactMemoryContext({
    ...envelope,
    results: [], candidates: entries.map((entry) => entry.candidate),
    meta: { local_relevance:{...localRelevance,status:"pending_host_selection",returned_candidate_count:entries.length},
      usage_id:usageId, usage_item_ids:entries.map((entry)=>entry.item.id),
      usage_items:entries.map(({candidate,item})=>({usage_item_id:item.id,source_type:"memory",source_id:candidate.memory_id,source_version:candidate.current_version})) },
    evidence_bundle: {query_at:at,token_budget:tokenBudget,context_format:contextFormat,estimated_tokens:0,token_count_basis:"o200k_base_complete_mcp_text",
      evidence_status:"insufficient", evidence:[],current_state:[],timeline:[],conflicts:[],
      abstention_recommended:true,missing_evidence:["host_selection_and_full_version_verification_pending"],
      budget_limited:budgetLimited,guidance:WORKING_LLM_GUIDANCE}
  });
  for (const candidate of candidates) {
    if (selected.length >= topK) break;
    const item = {id:randomUUID(),source_type:"memory",source_id:candidate.memory_id,source_version:candidate.current_version,
      rank:selected.length+1,reference_type:"returned",used_state:"unknown"};
    const entry={candidate,item};
    if (countContextTokens(responseFor([...selected,entry]))>tokenBudget) {budgetLimited=true;continue;}
    selected.push(entry);
  }
  const response=responseFor(selected);
  // The fixed pending contract fits the minimum supported 512-token budget.
  if (countContextTokens(response)>tokenBudget) throw new Error("working_llm_context_budget_exceeded");
  return {response,items:selected.map(({item})=>item)};
}
