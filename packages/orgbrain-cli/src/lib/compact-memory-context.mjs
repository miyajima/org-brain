import { randomUUID } from "node:crypto";
import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";
import { requiresMultipleEvidenceSources } from "../../../shared/src/evidence-disposition.mjs";

let encoder;
export function countContextTokens(value) {
  encoder ??= new Tiktoken(ranks);
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value, null, 2), [], []).length;
}

function measured(response) {
  // Count the complete MCP text, including receipts and JSON framing. The
  // tokenizer is a local estimate, not provider billing or a task-cost ledger.
  for (let i = 0; i < 4; i += 1) {
    const count = countContextTokens(response);
    if (response.evidence_bundle.estimated_tokens === count) break;
    response.evidence_bundle.estimated_tokens = count;
  }
  return response;
}

export function buildCompactMemoryContext({ results, query, topK, tokenBudget, at, usageId,
  verificationSampled = false, judgment = null, protectedIds = [] }) {
  const multiple = requiresMultipleEvidenceSources(query);
  const conflicted = results.some(({ memory }) => memory.conflicts?.length)
    || (judgment?.applied && (judgment.decisions ?? []).some((item) => item.reason_codes?.includes("conflicting_evidence")));
  const selected = [];
  const seen = new Set();
  let budgetLimited = false;
  let duplicates = 0;

  const responseFor = (items, missing = []) => measured({
    results: items.map(({ result: { memory, score } }) => ({
      memory: { id: memory.id, project_id: memory.project_id, summary: memory.summary,
        kind: memory.kind, work_type: memory.work_type, current_version: memory.current_version },
      score: { total: score.total }
    })),
    meta: {
      usage_id: usageId,
      usage_item_ids: items.map((item) => item.id),
      usage_items: items.map(({ id, result: { memory } }) => ({ usage_item_id: id,
        source_type: "memory", source_id: memory.id, source_version: memory.current_version })),
      verification_sampled: verificationSampled,
      ...(judgment?.mode && judgment.mode !== "off" ? { memory_judgment: {
        mode: judgment.mode, status: judgment.status, applied: judgment.applied, reason_code: judgment.reason_code
      } } : {})
    },
    evidence_bundle: {
      query_at: at,
      token_budget: tokenBudget,
      estimated_tokens: 0,
      token_count_basis: "o200k_base_complete_mcp_text",
      context_format: "compact",
      evidence_status: conflicted ? "conflicted" : items.length ? "degraded" : "insufficient",
      answer_template: items.length ? "evidence" : "abstention",
      evidence: items.map(({ result: { memory } }) => ({
        memory_id: memory.id,
        text: memory.content,
        ...(memory.rationale ? { rationale: memory.rationale } : {}),
        ...(memory.reuse_rule ? { reuse_rule: memory.reuse_rule } : {}),
        source_reference: memory.source_references?.[0] ?? null,
        ...(memory.source_references?.length > 1 ? { additional_sources: memory.source_references.slice(1) } : {}),
        verification_state: memory.verification_state,
        valid_until: memory.valid_until,
        expires_at: memory.expires_at
      })),
      conflicts_count: conflicted ? results.filter(({ memory }) => memory.conflicts?.length).length || 1 : 0,
      missing_evidence: missing,
      abstention_recommended: items.length === 0,
      budget_limited: budgetLimited,
      duplicates_omitted: duplicates,
      degraded_reasons: ["local_sparse_retrieval", ...(items.some(({ result: { memory } }) =>
        Number(memory.confidence_score ?? 0.5) < 0.5) ? ["low_confidence_evidence"] : [])],
      guidance: "Historical evidence only. Verify current sources and reuse conditions before applying; a retrieval is not proof of use or savings."
    }
  });

  if (!conflicted) for (const result of results) {
    if (selected.length >= topK) break;
    const { memory } = result;
    const key = JSON.stringify([memory.project_id, memory.kind, memory.content, memory.rationale, memory.reuse_rule]
      .map((value) => String(value ?? "").replace(/\s+/gu, " ").trim()));
    // Comparisons need independently sourced evidence even when text matches.
    if (!multiple && !protectedIds.includes(memory.id) && seen.has(key)) { duplicates++; continue; }
    const item = { id: randomUUID(), result };
    if (responseFor([...selected, item]).evidence_bundle.estimated_tokens > tokenBudget) {
      budgetLimited = true;
      continue;
    }
    selected.push(item);
    seen.add(key);
  }
  let missing = conflicted ? ["conflicting_evidence"] : [];
  if (!conflicted && protectedIds.some((id) => !selected.some((item) => item.result.memory.id === id))) {
    missing.push("protected_context_budget_exhausted");
    budgetLimited = true;
  }
  const sources = new Set(selected.map(({ result: { memory } }) => memory.source_references?.[0]?.ref ?? memory.id));
  if (!conflicted && multiple && sources.size < 2 && results.length) missing.push("insufficient_independent_sessions");
  if (!conflicted && selected.length === 0) missing.push(results.length ? "context_budget_exhausted" : "no_relevant_evidence");
  if (missing.length) selected.length = 0;
  let response = responseFor(selected, missing);
  // Changes to omission counters can alter the encoded length at a boundary.
  while (selected.length && response.evidence_bundle.estimated_tokens > tokenBudget) {
    selected.pop();
    budgetLimited = true;
    if (multiple || !selected.length || protectedIds.some((id) => !selected.some((item) => item.result.memory.id === id))) {
      selected.length = 0;
      missing = ["context_budget_exhausted"];
    }
    response = responseFor(selected, missing);
  }
  if (response.evidence_bundle.estimated_tokens > tokenBudget) throw new Error("context_budget_below_envelope");
  return { response, items: selected.map(({ id, result: { memory, score } }, index) => ({
    id, source_type: "memory", source_id: memory.id, source_version: memory.current_version,
    rank: index + 1, score: score.total, reference_type: "injected", used_state: "unknown",
    injected_token_estimate: countContextTokens(response.evidence_bundle.evidence[index])
  })) };
}
