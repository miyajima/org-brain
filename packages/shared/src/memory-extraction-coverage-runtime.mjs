export const MEMORY_EXTRACTION_COVERAGE_PROFILE = "coverage/v1";
export const MEMORY_EXTRACTION_REFINED_PROFILE = "a-plus/v1";
export const MEMORY_EXTRACTION_COVERAGE_MAX_POOL_SPANS = 16;
export const MEMORY_EXTRACTION_COVERAGE_MAX_POOL_BYTES = 16 * 1024;
export const MEMORY_EXTRACTION_COVERAGE_MAX_SNIPPETS = 8;

export const COVERAGE_PRIORITY = Object.freeze({
  correction: 1,
  decision: 2,
  failure: 3,
  verified_procedure: 4,
  other: 5
});

const CORRECTION = /\b(?:retract(?:ed)?|correct(?:ed|ion)?|instead|must not|never|except|unless|prohibit(?:ed)?)\b|(?:撤回|訂正|誤り|禁止|例外|ただし|ではなく|しないこと)/iu;
const DECISION = /\b(?:decid(?:e|ed)|choose|chose|selected|must|prefer|default|required|constraint)\b|(?:決定|採用|選択|必須|制約|希望|優先|既定|デフォルト)/iu;
const FAILURE = /\b(?:fail(?:ed|ure)?|error|regression|timed? out|root cause|did not work)\b|(?:失敗|エラー|不具合|回帰|原因|動かな|タイムアウト)/iu;
const PROCEDURE = /\b(?:run|use|change|fix|implement|configure|deploy)\b|(?:実行|使用|変更|修正|実装|設定|デプロイ)/iu;
const VERIFIED = /\b(?:pass(?:ed)?|succeed(?:ed)?|verified|resolved|exit[_ ]?code\s*[=:]?\s*0)\b|(?:成功|通った|検証済み|解消|終了コード\s*0)/iu;
const EXPLICIT_REASON = /^(?:理由|なぜなら|because\b|the reason\b|(?:reason|rationale)\s*[:：])/iu;
const QUALIFIER = /\b(?:not|never|only|unless|except|if|when|must|cannot|failed?)\b|(?:ない|禁止|のみ|場合|条件|例外|ただし|必須|失敗|撤回|訂正)/iu;
const STANDALONE_CORRECTION = /^(?:違います|訂正します|そうではなく|that's wrong)[。.!]?$/iu;
const HUMAN_DECISION_FIELDS = new Set(["decision", "selected_value", "constraint", "constraints", "preference", "approval"]);
const HUMAN_DECISION_CONTEXT_FIELDS = new Set(["rationale", "reason_rejected", "applicability", "reuse_when", "why_it_worked", "avoidance_rule", "conditions", "scope", "exceptions", "alternative", "alternatives", "question"]);
const OUTCOME_FIELDS = new Set(["observed_outcome", "verified_outcome"]);
const CONTROL_FIELDS = new Set(["persistence", "memory_kind", "action", "target_memory_id", "decision_type"]);
const TRANSIENT_CONTENT = /\b(?:for now|this time|temporary|one[- ]off|for this (?:submission|preview|demo|run|task) only)\b|(?:今回(?:だけ|限り)|今回の(?:レビュー|確認|提出|デモ|試写|実行|作業)(?:だけ|限り)|この(?:ターン|回答|確認|提出分|試写|説明会|デモ|実行|作業|検証回|テスト回)(?:だけ|限り)|一時的|ひとまず|今だけ|(?:通常|既定|デフォルト)(?:の[^。\n]{0,24})?(?:には?|を|は)?(?:保存|変更|更新)(?:しない|しません)|次回(?:から)?[^。\n]{0,24}(?:戻す|戻します))/iu;

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function byteLength(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

function trimBounds(source, start, end) {
  while (start < end && /\s/u.test(source[start])) start += 1;
  while (end > start && /\s/u.test(source[end - 1])) end -= 1;
  return [start, end];
}

function periodEndsSentence(source, index) {
  const previous = source[index - 1] ?? "";
  const next = source[index + 1] ?? "";
  if (/\d/u.test(previous) && /\d/u.test(next)) return false;
  if (next && !/\s/u.test(next)) return false;
  const tokenStart = Math.max(source.lastIndexOf(" ", index), source.lastIndexOf("\n", index)) + 1;
  const token = source.slice(tokenStart, index + 1);
  if (/^(?:https?:\/\/|www\.)/iu.test(token)) return false;
  return true;
}

export function splitCoverageSentences(snippets, options = {}) {
  const hashText = typeof options.hash_text === "function" ? options.hash_text : null;
  let order = 0;
  return (Array.isArray(snippets) ? snippets : []).flatMap((raw) => {
    const snippet = asRecord(raw);
    if (typeof snippet.span_id !== "string" || typeof snippet.text !== "string") return [];
    const source = snippet.text;
    const boundaries = [];
    let start = 0;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      const hard = character === "。" || character === "！" || character === "？" || character === "!" || character === "?" || character === "\n";
      const dot = character === "." && periodEndsSentence(source, index);
      if (!hard && !dot) continue;
      const end = character === "\n" ? index : index + 1;
      const bounds = trimBounds(source, start, end);
      if (bounds[1] > bounds[0]) boundaries.push(bounds);
      start = index + 1;
    }
    const tail = trimBounds(source, start, source.length);
    if (tail[1] > tail[0]) boundaries.push(tail);
    return boundaries.map(([sentenceStart, sentenceEnd]) => {
      const text = source.slice(sentenceStart, sentenceEnd);
      const spanId = `${snippet.span_id}@${sentenceStart}:${sentenceEnd}`;
      return {
        span_id: spanId,
        parent_span_id: snippet.span_id,
        turn_id: snippet.turn_id ?? null,
        timestamp: snippet.timestamp ?? null,
        source_order: snippet.source_order ?? null,
        role: typeof snippet.role === "string" ? snippet.role : "unknown",
        source: typeof snippet.source === "string" ? snippet.source : (typeof snippet.role === "string" ? snippet.role : "unknown"),
        start: sentenceStart,
        end: sentenceEnd,
        order: order++,
        text,
        text_hash: hashText ? hashText(text) : (typeof snippet.text_hash === "string" && boundaries.length === 1 ? snippet.text_hash : null),
        review_signal_score: Number(snippet.review_signal_score) || 0,
        review_signal_reasons: snippet.review_signal_reasons ?? [],
        context_only: snippet.context_only === true,
        call_id: typeof snippet.call_id === "string" ? snippet.call_id : null
      };
    });
  });
}

export function coveragePriority(text, options = {}) {
  if (CORRECTION.test(text)) return COVERAGE_PRIORITY.correction;
  if (DECISION.test(text)) return COVERAGE_PRIORITY.decision;
  if (FAILURE.test(text)) return COVERAGE_PRIORITY.failure;
  if (PROCEDURE.test(text) && (VERIFIED.test(text) || options.verified === true)) return COVERAGE_PRIORITY.verified_procedure;
  return COVERAGE_PRIORITY.other;
}

function shouldAttach(left, right) {
  if (!left || !right) return false;
  if (left.parent_span_id !== right.parent_span_id) {
    // A human's consecutive explanation may qualify their own choice. An
    // assistant's explanation must never be attached as the human's rationale.
    return left.role === "user" && right.role === "user"
      && (DECISION.test(left.text) || EXPLICIT_REASON.test(left.text) || QUALIFIER.test(left.text))
      && (EXPLICIT_REASON.test(right.text) || /^(?:ただし|例外|unless\b|except\b)/iu.test(right.text));
  }
  return EXPLICIT_REASON.test(right.text) || EXPLICIT_REASON.test(left.text)
    || QUALIFIER.test(left.text) || QUALIFIER.test(right.text)
    || FAILURE.test(left.text) && (PROCEDURE.test(right.text) || VERIFIED.test(right.text))
    || PROCEDURE.test(left.text) && VERIFIED.test(right.text);
}

export function buildCoverageEvidenceGroups(snippets, events = [], options = {}) {
  const spans = splitCoverageSentences(snippets, options).filter((span) => !span.context_only && span.text.trim());
  const components = [];
  for (const span of spans) {
    const current = components.at(-1);
    if (current && shouldAttach(current.at(-1), span)) current.push(span);
    else components.push([span]);
  }
  const roots = components.map((_, index) => index);
  const root = (index) => {
    while (roots[index] !== index) { roots[index] = roots[roots[index]]; index = roots[index]; }
    return index;
  };
  const merge = (indices) => {
    if (indices.length < 2) return;
    const target = Math.min(...indices.map(root));
    for (const index of indices) roots[root(index)] = target;
  };
  const byCall = new Map();
  for (const [index, members] of components.entries()) for (const span of members) {
    if (span.source !== "tool_result" || !span.call_id) continue;
    if (!byCall.has(span.call_id)) byCall.set(span.call_id, new Set());
    byCall.get(span.call_id).add(index);
  }
  const linkedCallIds = new Set();
  const operationEvents = events.filter((event) => event.name && event.argument_hash && byCall.has(event.call_id))
    .sort((a,b)=>Math.min(...[...byCall.get(a.call_id)].flatMap(i=>components[i].map(s=>s.order)))
      - Math.min(...[...byCall.get(b.call_id)].flatMap(i=>components[i].map(s=>s.order))));
  for (const [eventIndex, earlier] of operationEvents.entries()) {
    const later = operationEvents.slice(eventIndex + 1).find((event) => event.name === earlier.name
      && event.argument_hash === earlier.argument_hash);
    if (!later || earlier.status !== "failed" && later.status !== "failed") continue;
    const earlierIndices = [...byCall.get(earlier.call_id)];
    const laterIndices = [...byCall.get(later.call_id)];
    const start = Math.min(...earlierIndices.flatMap((index) => components[index].map((span) => span.order)));
    const end = Math.max(...laterIndices.flatMap((index) => components[index].map((span) => span.order)));
    if (start >= end) continue;
    // Retain the cause, fix and limiting context between attempts. They may be
    // separate assistant finals or human turns. Attribution remains on each row.
    const between = components.flatMap((members, index) => members.some((span) => span.order >= start && span.order <= end) ? [index] : []);
    const after = components.flatMap((members, index) => members.some((span) => span.order === end + 1
      && span.role === "assistant" && (EXPLICIT_REASON.test(span.text) || QUALIFIER.test(span.text) || VERIFIED.test(span.text))) ? [index] : []);
    const preceding = spans.find(span=>span.order===start-1 && span.role!=="tool");
    const before = preceding && spans.some(span=>span.parent_span_id===preceding.parent_span_id
      && /\b(?:TDD|test[- ]first|expected (?:test )?failure|red[- ]green)\b|先に失敗するテスト|失敗を確認してから実装/iu.test(span.text))
      ? components.flatMap((members,index)=>members.some(span=>span.parent_span_id===preceding.parent_span_id)?[index]:[]) : [];
    linkedCallIds.add(earlier.call_id); linkedCallIds.add(later.call_id);
    merge([...before, ...between, ...after]);
  }
  const merged = new Map();
  for (const [index, members] of components.entries()) {
    const key = root(index);
    merged.set(key, [...(merged.get(key) ?? []), ...members]);
  }
  return [...merged.values()].map((members) => {
    const unique = [...new Map(members.map((span) => [span.span_id, span])).values()];
    const verified = (Array.isArray(events) ? events : []).some((event) => {
      const row = asRecord(event);
      return row.evidence_kind !== "record_read" && row.status === "completed" && (row.exit_code === 0 || Number(row.http_status) >= 200 && Number(row.http_status) < 300)
        && unique.some((span) => span.call_id && span.call_id === row.call_id);
    });
    const priority = Math.min(...unique.map((span) => coveragePriority(span.text, { verified })));
    const linkedEvents = operationEvents.filter((event) => linkedCallIds.has(event.call_id) && unique.some((span) => span.call_id === event.call_id));
    if (!linkedEvents.length) linkedEvents.push(...operationEvents.filter(event=>unique.some(span=>span.call_id===event.call_id)));
    const failed = linkedEvents.some((event) => event.status === "failed");
    const successful = linkedEvents.some((event) => event.evidence_kind !== "record_read" && event.status === "completed"
      && (event.exit_code === 0 || Number(event.http_status) >= 200 && Number(event.http_status) < 300));
    const last = linkedEvents.at(-1);
    const outcomeState = failed && successful ? (last?.status === "failed" ? "regression" : "recovered")
      : failed ? "unresolved" : successful ? "verified_tool_result" : "reported_only";
    return {
      outcome_state: outcomeState,
      lesson_tags: failed && successful ? ["failure", "success"] : failed ? ["failure"] : successful ? ["success"] : [],
      test_first_reported: unique.some((span) => /\b(?:TDD|test[- ]first|expected (?:test )?failure|red[- ]green)\b|先に失敗するテスト|失敗を確認してから実装/iu.test(span.text)),
      group_id: `group:${unique.map((span) => span.span_id).join("+")}`,
      span_ids: unique.map((span) => span.span_id),
      parent_span_ids: [...new Set(unique.map((span) => span.parent_span_id))],
      priority,
      important: priority <= COVERAGE_PRIORITY.verified_procedure,
      review_signal_score: Math.max(...unique.map((span) => span.review_signal_score)),
      review_signal_reasons: [...new Set(unique.flatMap((span) => span.review_signal_reasons))],
      latest_order: Math.max(...unique.map((span) => span.order)),
      byte_length: unique.reduce((sum, span) => sum + byteLength(span.text), 0),
      snippets: unique
    };
  });
}

export function selectCoverageEvidence(groups, options = {}) {
  const maxPoolSpans = Number.isInteger(options.max_pool_spans) ? options.max_pool_spans : MEMORY_EXTRACTION_COVERAGE_MAX_POOL_SPANS;
  const maxPoolBytes = Number.isInteger(options.max_pool_bytes) ? options.max_pool_bytes : MEMORY_EXTRACTION_COVERAGE_MAX_POOL_BYTES;
  const ranked = [...(Array.isArray(groups) ? groups : [])].sort((a, b) => a.priority - b.priority || (b.review_signal_score ?? 0) - (a.review_signal_score ?? 0) || b.latest_order - a.latest_order || a.group_id.localeCompare(b.group_id));
  const selected = [];
  const omitted = [];
  let spanCount = 0;
  let bytes = 0;
  for (const group of ranked) {
    const snippetIds = new Set((Array.isArray(group.snippets) ? group.snippets : []).map((snippet) => snippet.span_id));
    if (!Array.isArray(group.span_ids) || group.span_ids.length === 0 || group.span_ids.some((id) => !snippetIds.has(id))) {
      omitted.push({ group_id: group.group_id, span_ids: Array.isArray(group.span_ids) ? group.span_ids : [], reason: "dependency_missing" });
      continue;
    }
    if (spanCount + group.snippets.length > maxPoolSpans || bytes + group.byte_length > maxPoolBytes) {
      omitted.push({ group_id: group.group_id, span_ids: group.span_ids, reason: "pool_limit" });
      continue;
    }
    selected.push(group);
    spanCount += group.snippets.length;
    bytes += group.byte_length;
  }
  return { groups: selected, omitted, span_count: spanCount, text_bytes: bytes };
}

export function packCoverageGroups(packet, groups, options = {}) {
  const maxSnippets = Number.isInteger(options.max_snippets) ? options.max_snippets : MEMORY_EXTRACTION_COVERAGE_MAX_SNIPPETS;
  const reserveBytes = Number.isInteger(options.reserve_bytes) ? options.reserve_bytes : 0;
  const upperBound = typeof options.upper_bound === "function" ? options.upper_bound : (() => 0);
  const selected = [];
  const omitted = [];
  const requestPacket = (rows) => {
    const snippets = rows.flatMap((row) => row.snippets).sort((a, b) => a.order - b.order);
    if (packet.extraction_profile !== MEMORY_EXTRACTION_COVERAGE_PROFILE) return { ...packet, snippets };
    const calls = new Set(snippets.map((snippet) => snippet.call_id).filter(Boolean));
    return { ...packet, snippets,
      events: (packet.events ?? []).filter((event) => event.call_id && calls.has(event.call_id)),
      coverage: { ...packet.coverage, groups: rows.map((group) => ({
        group_id: group.group_id, span_ids: group.span_ids, priority: group.priority
      })) }
    };
  };
  for (const group of groups) {
    if (selected.reduce((sum, row) => sum + row.snippets.length, 0) + group.snippets.length > maxSnippets) {
      omitted.push({ group_id: group.group_id, span_ids: group.span_ids, reason: "input_budget" });
      continue;
    }
    const next = [...selected, group];
    if (upperBound(requestPacket(next)) + reserveBytes > 2_000) {
      omitted.push({ group_id: group.group_id, span_ids: group.span_ids, reason: "input_budget" });
      continue;
    }
    selected.push(group);
  }
  const packed = requestPacket(selected);
  const bound = upperBound(packed);
  return { packet: packed, groups: selected, omitted, upper_bound: bound,
    diagnostics: { schema: "memory-extraction-packing/v1", input_ceiling: 2_000, input_upper_bound: bound,
      reserve_bytes: reserveBytes, packed_span_count: packed.snippets.length,
      packed_text_bytes: packed.snippets.reduce((sum, snippet) => sum + byteLength(snippet.text), 0),
      omitted_group_count: omitted.length } };
}

export function decideCoverageSecondPass({ groups = [], pass1_presented_group_ids = [], pass1_adopted_span_ids = [], pass1_status = "succeeded" } = {}) {
  if (pass1_status !== "succeeded") return { run: false, reason: "pass1_not_successful", group_ids: [] };
  const presented = new Set(pass1_presented_group_ids);
  const adopted = new Set(pass1_adopted_span_ids);
  const remaining = groups.filter((group) => group.important && (!presented.has(group.group_id) || !group.span_ids.some((id) => adopted.has(id))));
  return remaining.length > 0
    ? { run: true, reason: "important_groups_remaining", group_ids: remaining.map((group) => group.group_id) }
    : { run: false, reason: "coverage_not_needed", group_ids: [] };
}

function candidateFields(candidate) {
  const fields = new Map();
  for (const raw of Array.isArray(candidate?.fields) ? candidate.fields : []) {
    if (typeof raw?.name !== "string" || !Array.isArray(raw.values)) continue;
    fields.set(raw.name, raw.values.filter((value) => typeof value === "string" && value.trim()));
  }
  return fields;
}

function retainsQualifiedSnippet(text, contentValues) {
  const source = String(text);
  if (STANDALONE_CORRECTION.test(source.trim())) return true;
  const correctionPrefix = source.match(/^(?:違います|訂正します|そうではなく|that's wrong)[。.!]?\s*/iu)?.[0].length ?? 0;
  const covered = new Uint8Array(source.length);
  for (const value of contentValues) {
    let start = 0;
    while (start <= source.length - value.length) {
      const index = source.indexOf(value, start);
      if (index < 0) break;
      covered.fill(1, index, index + value.length);
      start = index + Math.max(1, value.length);
    }
  }
  for (let index = 0; index < source.length;) {
    const character = String.fromCodePoint(source.codePointAt(index));
    if (index >= correctionPrefix && covered[index] !== 1 && !/[\p{P}\p{Z}\s]/u.test(character)) return false;
    index += character.length;
  }
  return true;
}

export function validateCoverageCandidate(candidate, packet) {
  const supportIds = [...new Set(Array.isArray(candidate?.support_span_ids) ? candidate.support_span_ids.filter((id) => typeof id === "string") : [])];
  const snippets = (Array.isArray(packet?.snippets) ? packet.snippets : []).filter((snippet) => supportIds.includes(snippet.span_id));
  const packetEvents = Array.isArray(packet?.events) ? packet.events : [];
  const events = packetEvents.filter((event) => supportIds.includes(event.event_id));
  const reasons = [];
  if (supportIds.length === 0) reasons.push("support_missing");
  if (supportIds.some((id) => !snippets.some((snippet) => snippet.span_id === id) && !events.some((event) => event.event_id === id))) reasons.push("support_id_unresolved");
  const fields = candidateFields(candidate);
  for (const [name, values] of fields) {
    if (CONTROL_FIELDS.has(name)) continue;
    for (const value of values) {
      if (/^[+-]?\d+(?:[.,]\d+)?$/u.test(value.trim())) reasons.push(`${name}_numeric_only`);
      if (!snippets.some((snippet) => String(snippet.text).includes(value))) reasons.push(`${name}_not_single_fragment_grounded`);
    }
  }
  const humanValues = [...fields].filter(([name]) => HUMAN_DECISION_FIELDS.has(name)
    || candidate?.lesson_type === "decision" && HUMAN_DECISION_CONTEXT_FIELDS.has(name)).flatMap(([, values]) => values);
  const humanClaim = candidate?.lesson_type === "decision" || humanValues.length > 0;
  if (humanClaim && (humanValues.length === 0 || humanValues.some((value) => !snippets.some((snippet) => snippet.role === "user" && String(snippet.text).includes(value))))) reasons.push("human_attribution_unsupported");
  for (const [name, values] of fields) {
    if (!OUTCOME_FIELDS.has(name)) continue;
    for (const value of values) {
      const groundedResults = snippets.filter((snippet) => snippet.source === "tool_result" && snippet.call_id && String(snippet.text).includes(value));
      if (!groundedResults.some((snippet) => packetEvents.some((event) => event.call_id === snippet.call_id && event.evidence_kind !== "record_read" && event.status === "completed"
        && (event.exit_code === 0 || Number(event.http_status) >= 200 && Number(event.http_status) < 300)))) reasons.push("verified_tool_outcome_missing");
    }
  }
  const dependencyIds = new Set((packet?.coverage?.groups ?? []).filter((group) => group.span_ids.some((id) => supportIds.includes(id))).flatMap((group) => group.span_ids));
  const qualified = (packet?.snippets ?? []).filter((snippet) => (supportIds.includes(snippet.span_id) || dependencyIds.has(snippet.span_id))
    && (QUALIFIER.test(String(snippet.text)) || STANDALONE_CORRECTION.test(String(snippet.text).trim())));
  const contentValues = [...fields].filter(([name]) => !CONTROL_FIELDS.has(name)).flatMap(([, values]) => values);
  if (contentValues.some((value) => TRANSIENT_CONTENT.test(value))) reasons.push("explicitly_transient");
  if (qualified.length > 0 && !qualified.every((snippet) => retainsQualifiedSnippet(snippet.text, contentValues))) reasons.push("qualifier_not_retained");
  return { valid: reasons.length === 0, reason_codes: [...new Set(reasons)].sort() };
}

// Inspect persisted content, never evidence selectors or compatibility aliases:
// retaining a quote in provenance does not retain it in the extracted lesson.
export function validateNormalizedRetention(candidate, packet, observation) {
  const fieldsByLesson = {
    success: ["procedure", "why_it_worked", "observed_outcome", "reuse_when"],
    decision: ["question", "selected_value", "decision", "constraints", "rationale", "alternatives", "reuse_when"],
    failure: ["symptom", "failed_approach", "root_cause", "correction", "verified_outcome", "avoidance_rule"]
  };
  const strings = (value) => typeof value === "string" ? [value] : Array.isArray(value)
    ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const retained = [...(fieldsByLesson[observation.lesson_type] ?? []).flatMap((name) => strings(observation[name])),
    ...strings(observation.reported_verification?.text)];
  const canonical = (value) => String(value).normalize("NFKC").replace(/\s+/gu, " ").trim();
  const keeps = (text, values = retained) => {
    const source = canonical(text);
    const content = values.map(canonical);
    return content.some((value) => value.includes(source)) || retainsQualifiedSnippet(source, content);
  };
  const support = new Set(candidate.support_span_ids ?? []);
  for (const group of packet?.coverage?.groups ?? []) {
    if (group.span_ids.some((id) => support.has(id))) for (const id of group.span_ids) support.add(id);
  }
  const snippets = (packet.snippets ?? []).filter((snippet) => support.has(snippet.span_id));
  const reasons = [];
  for (const name of OUTCOME_FIELDS) for (const value of candidateFields(candidate).get(name) ?? []) {
    if (!snippets.some((snippet) => snippet.source === "tool_result" && snippet.call_id && String(snippet.text).includes(value)
      && (packet.events ?? []).some((event) => event.call_id === snippet.call_id && event.evidence_kind !== "record_read" && event.status === "completed"
        && (event.exit_code === 0 || (Number(event.http_status) >= 200 && Number(event.http_status) < 300)))))
      reasons.push("verified_tool_outcome_missing");
  }
  for (const snippet of snippets) {
    const text = String(snippet.text);
    if ((QUALIFIER.test(text) || STANDALONE_CORRECTION.test(text.trim())) && !keeps(text))
      reasons.push("normalized_qualifier_not_retained");
    if ((EXPLICIT_REASON.test(text.trim()) || /\b(?:because|the reason)\b|(?:理由は|なぜなら)/iu.test(text))
        && !keeps(text)) reasons.push("normalized_reason_not_retained");
    if (observation.lesson_type !== "decision" && snippet.source === "tool_result" && snippet.call_id
        && (packet.events ?? []).some((event) => event.call_id === snippet.call_id && event.evidence_kind !== "record_read" && event.status === "completed"
          && (event.exit_code === 0 || (Number(event.http_status) >= 200 && Number(event.http_status) < 300)))
        && !keeps(text, strings(observation.lesson_type === "success" ? observation.observed_outcome : observation.verified_outcome)))
      reasons.push("normalized_outcome_not_retained");
  }
  const allContent = [...retained, ...strings(observation.trigger), ...strings(observation.applicability?.target_files)];
  for (const [name, values] of candidateFields(candidate)) {
    if (!CONTROL_FIELDS.has(name) && values.some((value) => !keeps(value, allContent)))
      reasons.push("normalized_field_not_retained");
  }
  return { valid: reasons.length === 0, reason_codes: [...new Set(reasons)].sort() };
}

export function coverageCandidateFingerprint(candidate) {
  const fields = [...candidateFields(candidate)].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, [...values].map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim()).sort()]);
  return JSON.stringify([candidate.action ?? "create", candidate.target_memory_id ?? null, candidate.lesson_type ?? null, fields]);
}

export function mergeCoverageCandidates(passCandidates, options = {}) {
  const priorityBySpan = options.priority_by_span ?? {};
  const flattened = (Array.isArray(passCandidates) ? passCandidates : []).flatMap((items, passIndex) => (Array.isArray(items) ? items : []).map((candidate) => ({ ...candidate, pass_no: passIndex + 1 })));
  const deduped = new Map();
  for (const candidate of flattened) {
    const fingerprint = coverageCandidateFingerprint(candidate);
    const existing = deduped.get(fingerprint);
    if (existing) existing.support_span_ids = [...new Set([...(existing.support_span_ids ?? []), ...(candidate.support_span_ids ?? [])])];
    else deduped.set(fingerprint, { ...candidate, fingerprint });
  }
  const values = [...deduped.values()];
  const conflicted = new Set();
  for (let left = 0; left < values.length; left += 1) for (let right = left + 1; right < values.length; right += 1) {
    const leftSupport = [...(values[left].support_span_ids ?? [])].sort();
    const rightSupport = [...(values[right].support_span_ids ?? [])].sort();
    const sameAtom = JSON.stringify(leftSupport) === JSON.stringify(rightSupport)
      && values[left].lesson_type === values[right].lesson_type
      && (values[left].action ?? "create") === (values[right].action ?? "create")
      && (values[left].target_memory_id ?? null) === (values[right].target_memory_id ?? null);
    if (!sameAtom) continue;
    const leftFields = candidateFields(values[left]);
    const rightFields = candidateFields(values[right]);
    const contradicts = [...leftFields.keys()].some((name) => rightFields.has(name)
      && JSON.stringify([...leftFields.get(name)].sort()) !== JSON.stringify([...rightFields.get(name)].sort()));
    if (contradicts) { conflicted.add(left); conflicted.add(right); }
  }
  const conflicts = values.filter((_, index) => conflicted.has(index)).map((candidate) => ({ candidate, reason: "atomic_evidence_conflict" }));
  const eligible = values.filter((_, index) => !conflicted.has(index)).sort((a, b) => {
    const aPriority = Math.min(...(a.support_span_ids ?? []).map((id) => priorityBySpan[id] ?? 5));
    const bPriority = Math.min(...(b.support_span_ids ?? []).map((id) => priorityBySpan[id] ?? 5));
    const aOrder = Math.max(...(a.support_span_ids ?? []).map((id) => options.order_by_span?.[id] ?? -1));
    const bOrder = Math.max(...(b.support_span_ids ?? []).map((id) => options.order_by_span?.[id] ?? -1));
    const aSignal = Math.max(0, ...(a.support_span_ids ?? []).map((id) => options.signal_by_span?.[id] ?? 0));
    const bSignal = Math.max(0, ...(b.support_span_ids ?? []).map((id) => options.signal_by_span?.[id] ?? 0));
    return aPriority - bPriority || bSignal - aSignal || bOrder - aOrder || a.fingerprint.localeCompare(b.fingerprint);
  });
  return { candidates: eligible.slice(0, 3), conflicts, omitted: eligible.slice(3).map((candidate) => ({ candidate, reason: "candidate_limit" })) };
}
