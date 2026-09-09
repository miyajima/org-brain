// Current-turn diagnostics only. A retrieval miss is not proof that knowledge
// does not exist; intervention signals never attest a decision or an outcome.
function object(value) {
  if (typeof value === "string") { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function resultObject(value) {
  const parsed = object(value);
  if (parsed.structuredContent) return object(parsed.structuredContent);
  if (Array.isArray(parsed.content)) {
    const text = parsed.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    return object(text);
  }
  return parsed;
}

export function collectCoverageReviewSignals(rows, projectId) {
  const calls = new Map();
  const seenResults = new Set();
  const failures = new Map();
  const signals = [];
  let misses = 0;
  let hits = 0;
  let pendingMiss = null;
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
      calls.set(id, { name: invocation.tool ?? p.name ?? p.tool_name, args: object(invocation.arguments ?? p.arguments ?? p.input), order });
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
      if (call && /(?:^|__)orgbrain_(?:memories|decision_memories)_search$/u.test(call.name ?? "")
        && projectId && call.args.project_id === projectId && !failed && !rejected && Array.isArray(result.results)) {
        if (result.results.length === 0) { misses++; pendingMiss = { order, event_id: String(id) }; }
        else { hits++; pendingMiss = null; }
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
  return { schema: "coverage-review-signals/v1", recall_hits: hits, recall_misses: misses, signals };
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
