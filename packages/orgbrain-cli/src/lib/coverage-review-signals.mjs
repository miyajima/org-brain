import crypto from "node:crypto";

// Current-turn diagnostics only. A retrieval miss is not proof that knowledge
// does not exist; intervention signals never attest a decision or an outcome.
function object(value) {
  if (typeof value === "string") { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cryptoHash(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function resultObject(value) {
  const parsed = object(value);
  if (parsed.Ok !== undefined) return resultObject(parsed.Ok);
  if (parsed.data !== undefined) return resultObject(parsed.data);
  if (parsed.structuredContent) return object(parsed.structuredContent);
  if (Array.isArray(parsed.content)) {
    const text = parsed.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    return object(text);
  }
  return parsed;
}

function retrievalState(call, result, projectId) {
  const name = String(call?.name ?? "").split("__").at(-1);
  if (!projectId || call?.args?.project_id !== projectId) return null;
  if (/^orgbrain_(?:memory_search|memories_search|memory_retrieve_context|memories_retrieve_context|decision_memories_search)$/u.test(name)) {
    if (!Array.isArray(result.results)) return null;
    return result.results.length === 0 ? "miss" : "hit";
  }
  if (name !== "orgbrain_context_enrich") return null;
  const bundle = object(result.evidence_bundle);
  // Abstention can mean evidence exists but cannot safely be used. It is not
  // a knowledge gap and must also clear any earlier miss in this turn.
  if (bundle.evidence_status === "conflicted" || bundle.budget_limited === true
      || (Array.isArray(bundle.missing_evidence) ? bundle.missing_evidence : []).some((reason) => ["context_budget_exhausted", "insufficient_independent_sessions"].includes(reason))) return "blocked";
  if (bundle.abstention_recommended === true || bundle.evidence_status === "insufficient") return "miss";
  if (Array.isArray(bundle.evidence)) return bundle.evidence.length === 0 ? "miss" : "hit";
  if (Array.isArray(result.results)) return result.results.length === 0 ? "miss" : "hit";
  return null;
}

function isWorkAction(call) {
  const name = String(call?.name ?? "").split("__").at(-1);
  if (!name || name.startsWith("orgbrain_") || /(?:request_user_input|read_thread|list_threads|wait_threads)$/u.test(name)) return false;
  if (["exec", "exec_command"].includes(name)) {
    const command = String(call?.args?.cmd ?? call?.args?.command ?? "");
    return /(?:^|[\s/])(?:test|check|verify|doctor|lint|build|install|configure|migrate|deploy|publish|curl|node|npm|pnpm|yarn|bun|cargo|go|make|bundle|rspec)(?:\s|$)/iu.test(command);
  }
  return /(?:apply_patch|create|update|write|edit|install|configure|migrate|deploy|publish|execute|submit|build|verify|test)/iu.test(name);
}

export function collectCoverageReviewSignals(rows, projectId) {
  const calls = new Map();
  const seenResults = new Set();
  const failures = new Map();
  const signals = [];
  let misses = 0;
  let hits = 0;
  let pendingMiss = null;
  let latestRetrieval = null;
  let opaqueToolWrappers = 0;
  const successfulActionsAfterMiss = [];
  for (const [order, row] of rows.entries()) {
    const p = row?.payload ?? row;
    const id = p.call_id ?? p.id;
    const invocation = p.invocation ?? {};
    const humanText = p.type === "user_message" ? p.message : p.type === "message" && p.role === "user"
      ? (p.content ?? []).filter?.((item) => item.type === "input_text").map((item) => item.text).join("\n") : null;
    if (typeof humanText === "string" && /(?:違います|そうではなく|訂正|やり直|中止して|止めて|that's wrong|please stop)/iu.test(humanText)) {
      signals.push({ order: order - 0.5, reason: "human_correction_or_interruption", event_id: `message:${order}`,
        ...(pendingMiss ? { recall_miss_id: pendingMiss.event_id } : {}) });
    }
    if (["function_call", "custom_tool_call", "mcp_tool_call", "mcp_tool_call_end"].includes(p.type)) {
      const name = invocation.tool ?? p.name ?? p.tool_name;
      const args = object(invocation.arguments ?? p.arguments ?? p.input);
      if (p.type === "custom_tool_call" && String(name).split(".").at(-1) === "exec"
          && typeof p.input === "string" && /\btools\./u.test(p.input)) opaqueToolWrappers++;
      calls.set(id, { name, args, order });
    }
    if (["function_call_output", "custom_tool_call_output", "tool_result", "mcp_tool_call_end"].includes(p.type) && id && !seenResults.has(id)) {
      seenResults.add(id);
      const call = calls.get(id);
      const raw = p.output ?? p.result ?? p.content;
      const result = resultObject(raw);
      const exitMatch = typeof raw === "string" ? raw.match(/(?:Process exited with code|exit_code["\s]*:)\s*(-?\d+)/u) : null;
      const failed = p.is_error === true || object(raw).isError === true || result.isError === true || result.is_error === true
        || (Number.isInteger(result.exit_code) && result.exit_code !== 0) || (exitMatch !== null && Number(exitMatch[1]) !== 0);
      const rejected = result.status === "rejected" || result.status === "denied";
      const state = call && !failed && !rejected ? retrievalState(call, result, projectId) : null;
      if (state === "miss") {
        misses++;
        latestRetrieval = "miss";
        pendingMiss = { order, event_id: String(id) };
        successfulActionsAfterMiss.length = 0;
      } else if (state === "hit" || state === "blocked") {
        if (state === "hit") hits++;
        latestRetrieval = state;
        pendingMiss = null;
        successfulActionsAfterMiss.length = 0;
      } else if (call && pendingMiss && call.order > pendingMiss.order && !failed && !rejected && isWorkAction(call)) {
        successfulActionsAfterMiss.push({
          call_id: String(id),
          tool: String(call.name ?? "tool").split("__").at(-1).slice(0, 128),
          result_hash: `sha256:${cryptoHash(raw)}`,
          ...(Number.isInteger(result.exit_code) ? { exit_code: result.exit_code } : {}),
          ...(Number.isInteger(result.http_status) ? { http_status: result.http_status } : {})
        });
      }
      if (call && !failed && !rejected) failures.delete(JSON.stringify([call.name, call.args]));
      if (call && (failed || rejected)) {
        const operationKey = JSON.stringify([call.name, call.args]);
        const count = (failures.get(operationKey) ?? 0) + 1;
        if (failed) failures.set(operationKey, count);
        const reason = rejected ? "tool_rejected" : count >= 2 ? "repeated_tool_failure" : "tool_failure";
        signals.push({ order, reason, event_id: String(id), ...(pendingMiss && pendingMiss.order < call.order ? { recall_miss_id: pendingMiss.event_id } : {}) });
      }
    }
  }
  return {
    schema: "coverage-review-signals/v1",
    recall_hits: hits,
    recall_misses: misses,
    latest_retrieval: latestRetrieval,
    opaque_tool_wrappers: opaqueToolWrappers,
    successful_actions_after_miss: successfulActionsAfterMiss.slice(0, 4),
    signals
  };
}

export function annotateCoverageReviewSignals(snippets, diagnostics) {
  const annotated = snippets.map((snippet) => ({ ...snippet, review_signal_score: 0, review_signal_reasons: [] }));
  for (const signal of diagnostics.signals) {
    const anchored = annotated.find((snippet) => snippet.call_id === signal.event_id);
    const target = anchored ?? annotated.find((snippet) => signal.reason === "human_correction_or_interruption"
      ? snippet.role === "user" && snippet.source_order === signal.order + 0.5
      : snippet.source_order > signal.order);
    if (!target) continue;
    // Tool failures are diagnostic unless a human correction anchors the lesson.
    // Temporal proximity alone does not establish that an assistant conclusion is related.
    if (!anchored && signal.reason !== "human_correction_or_interruption") {
      target.review_signal_reasons.push(signal.reason);
      continue;
    }
    target.review_signal_score = Math.min(8, target.review_signal_score + (["repeated_tool_failure", "human_correction_or_interruption"].includes(signal.reason) ? 2 : 1) + (signal.recall_miss_id ? 1 : 0));
    target.review_signal_reasons.push(signal.reason, ...(signal.recall_miss_id ? ["recall_gap_and_friction"] : []));
  }
  return annotated.map((snippet) => ({ ...snippet, review_signal_reasons: [...new Set(snippet.review_signal_reasons)] }));
}
