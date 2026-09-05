// V3-only contracts. Legacy provider serialization and validation stay intact.

const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const fail = (code) => { throw new Error(code); };
// This profile is for offline packing experiments only. No verified Sol request
// envelope/encoding is currently installed: callers must not send its packets.
export function assertV3ProviderProfile() {
  fail("unsupported_token_profile");
}


export function validateV3Packet(packet) {
  if (packet?.schema !== "learning-extraction-proposal/v3") return;
  const routing = packet.routing;
  if (!record(routing) || routing.schema !== "memory-extraction-router/v3") fail("v3_routing_invalid");
  const route = routing.primary_route;
  if (!["hard_excluded", "llm_candidate", "operational_history", "discard"].includes(route)) fail("v3_primary_route_invalid");
  const durable = route === "llm_candidate";
  const operational = route === "operational_history";
  if (routing.disposition !== route || routing.llm_recommended !== durable
    || routing.operational_history_recommended !== operational
    || routing.decisions?.hard_excluded !== (route === "hard_excluded")
    || routing.decisions?.durable_candidate !== durable || routing.decisions?.operational_history !== operational) fail("v3_route_flags_mismatch");
  const probabilities = routing.probabilities;
  const probability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (!record(probabilities) || !probability(probabilities.durable_candidate)
    || (durable || route === "hard_excluded" ? probabilities.operational_history !== null : !probability(probabilities.operational_history))) fail("v3_probability_invalid");
  if (!Array.isArray(packet.snippets) || packet.snippets.length > 8 || durable && !packet.snippets.length) fail("v3_snippets_invalid");
  const ids = new Set();
  for (const span of packet.snippets) {
    if (!record(span) || typeof span.span_id !== "string" || ids.has(span.span_id)
      || typeof span.text !== "string" || !span.text.trim() || span.context_only === true
      || typeof span.parent_span_id !== "string" || !Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < 0 || span.end - span.start !== span.text.length) fail("v3_span_invalid");
    ids.add(span.span_id);
  }
  if (!Array.isArray(routing.support_span_ids) || routing.support_span_ids.some((id) => typeof id !== "string" || !ids.has(id))) fail("v3_support_invalid");
  for (const proposal of packet.rule_proposals ?? []) {
    if (!Array.isArray(proposal.support_span_ids) || proposal.support_span_ids.some((id) => !ids.has(id))) fail("v3_proposal_support_unresolved");
  }
}

const CONTENT = {
  success: ["trigger", "target_files", "procedure", "why_it_worked", "observed_outcome", "reuse_when"],
  decision: ["trigger", "target_files", "question", "selected_value", "decision", "constraints", "rationale", "alternative", "reason_rejected", "reuse_when"],
  failure: ["trigger", "target_files", "symptom", "failed_approach", "root_cause", "correction", "verified_outcome", "avoidance_rule"]
};
const CONTROLS = ["persistence", "memory_kind", "action", "target_memory_id", "decision_type"];
const MULTIPLE = new Set(["target_files", "constraints", "alternative", "reason_rejected"]);
export function validateV3Candidate(raw, packet) {
  const reject = (reason) => ({ valid: false, reason });
  if (!record(raw) || Object.keys(raw).some((key) => !["lesson_type", "support_span_ids", "gaps", "fields"].includes(key))
    || !Object.hasOwn(CONTENT, raw.lesson_type)) return reject("candidate_schema_invalid");
  if (!Array.isArray(raw.support_span_ids) || !raw.support_span_ids.length || raw.support_span_ids.length > 16
    || raw.support_span_ids.some((id) => typeof id !== "string") || new Set(raw.support_span_ids).size !== raw.support_span_ids.length) return reject("support_invalid");
  const spans = raw.support_span_ids.map((id) => packet.snippets.find((span) => span.span_id === id && !span.context_only));
  if (spans.some((span) => !span)) return reject("support_id_unresolved");
  if (!Array.isArray(raw.gaps) || raw.gaps.length > 16 || raw.gaps.some((gap) =>
    typeof gap !== "string" || !CONTENT[raw.lesson_type].some((field) => gap === `${field}_missing`))) return reject("gap_code_invalid");
  if (!Array.isArray(raw.fields) || raw.fields.length > 24) return reject("fields_invalid");
  const fields = new Map();
  for (const field of raw.fields) {
    if (!record(field) || Object.keys(field).some((key) => !["name", "values"].includes(key))
      || ![...CONTENT[raw.lesson_type], ...CONTROLS].includes(field.name) || fields.has(field.name)
      || !Array.isArray(field.values) || field.values.length > (MULTIPLE.has(field.name) ? 8 : 1)
      || field.values.some((value) => typeof value !== "string" || !value.trim() || value.length > 4000)) return reject("field_schema_invalid");
    if (CONTENT[raw.lesson_type].includes(field.name)
      && field.values.some((value) => !spans.some((span) => span.text.includes(value)))) return reject("field_not_exactly_grounded");
    fields.set(field.name, field.values);
  }
  const one = (name) => fields.get(name)?.[0];
  if (one("persistence") !== "durable") return reject("persistence_invalid");
  const kinds = { success: ["fact", "org_knowledge"], decision: ["decision", "constraint", "preference"], failure: ["pitfall"] };
  if (!kinds[raw.lesson_type].includes(one("memory_kind"))) return reject("lesson_memory_kind_mismatch");
  if (raw.lesson_type === "decision" && !["user_choice", "preference", "implementation", "governance"].includes(one("decision_type"))) return reject("decision_type_invalid");
  if (raw.lesson_type !== "decision" && one("decision_type")) return reject("decision_type_unexpected");
  if (!["create", "skip", "update", "conflict"].includes(one("action"))) return reject("action_invalid");
  const primary = { success: ["procedure", "observed_outcome"], decision: ["decision", "selected_value"], failure: ["symptom", "failed_approach"] };
  if (one("action") !== "skip" && !primary[raw.lesson_type].some((name) => one(name))) return reject("content_missing");
  if (["create", "skip"].includes(one("action")) && one("target_memory_id")) return reject("target_memory_id_unexpected");
  if (["update", "conflict"].includes(one("action")) && !(packet.existing_memories ?? []).some((item) => item.id === one("target_memory_id"))) return reject("target_memory_id_unsearched");
  return { valid: true, reason: null };
}
