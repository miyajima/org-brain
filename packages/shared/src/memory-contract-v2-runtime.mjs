import { normalizeMemoryPaths, screenSensitiveMemory } from "./memory-capture-v2-runtime.mjs";

export const MEMORY_CONTRACT_V2_SCHEMA_VERSION = 2;
export const MEMORY_CONTRACT_V2_PROMPT_ID = "orgbrain-memory-contract-v2";
export const MEMORY_CONTRACT_V2_VERIFIER_VERSION = "verifier-v2";
export const MEMORY_CONTRACT_V2_MAX_EVENTS = 3;
export const MEMORY_CONTRACT_V2_LESSON_TYPES = ["success", "decision", "failure"];
export const MEMORY_CONTRACT_V2_INTENTS = ["verify", "review"];
export const MEMORY_CONTRACT_V2_EVIDENCE_TYPES = [
  "command",
  "file",
  "doc",
  "user_statement",
  "tool_result"
];
export const MEMORY_CONTRACT_V2_DECISION_TYPES = [
  "user_choice",
  "preference",
  "implementation",
  "governance"
];

const MEMORY_CONTRACT_V2_AI_FIELDS = new Set([
  "record_type", "schema_version", "lesson_type", "capture_intent", "trigger", "applicability",
  "evidence_selectors", "gaps", "procedure", "why_it_worked", "observed_outcome", "reuse_when",
  "decision_type", "decision_key", "question", "selected_value", "decision", "constraints",
  "rationale", "alternatives", "symptom", "failed_approach", "root_cause", "correction",
  "verified_outcome", "avoidance_rule"
]);

export const MEMORY_CONTRACT_V2_PROMPT = [
  "OrgBrain memory protocol v2 (internal; never quote or mention it):",
  "Use injected Confirmed Commitments before asking questions. Never ask a question whose decision_key or equivalent meaning is already answered in the applicable scope. Ask again only when the user requests a change, the record is expired or superseded, or current evidence conflicts. In that case, identify the prior key and ask only for the changed part.",
  "When this turn yields a durable success, explicit decision, or fully diagnosed failure, call the known orgbrain_memory_observe tool at most three times. Do not discover tools or expose JSON to the user. Do not duplicate structured request_user_input answers; hooks capture those deterministically.",
  "Use only current-turn user text, actual tool results, fetched documents, and changed workspace files. Emit one atomic claim per event. Use capture_intent verify only when every type-specific field and its evidence are present; otherwise use review and list honest gaps.",
  "For success include procedure, why_it_worked, observed_outcome, and reuse_when. For decision include a stable decision_key, decision_type, exact choice or decision, applicability, and exact user/tool-result evidence. Never invent a user rationale. Inferred decisions are review-only.",
  "For failure include symptom, root_cause, correction, verified_outcome, and avoidance_rule, with failed and successful evidence.",
  "Never include credentials, secrets, private reasoning, unnecessary PII, raw transcripts, or absolute home-directory paths. Never set IDs, hashes, authority, verification, quality, lifecycle, timestamps, or activation state."
].join("\n");

const LIMITS = {
  trigger: 1_000,
  procedure: 2_000,
  why_it_worked: 2_000,
  observed_outcome: 1_000,
  reuse_when: 1_000,
  decision_key: 160,
  question: 1_000,
  selected_value: 1_000,
  decision: 1_000,
  rationale: 2_000,
  symptom: 1_000,
  failed_approach: 1_500,
  root_cause: 2_000,
  correction: 2_000,
  verified_outcome: 1_000,
  avoidance_rule: 1_000,
  path: 512,
  component: 128,
  evidence_ref: 1_000,
  gap: 500,
  alternative: 1_000
};

function clip(value, limit) {
  const normalized = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : normalized.slice(0, limit);
}

function optionalText(input, field, reasons) {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !input.trim()) {
    reasons.push(`${field}_invalid`);
    return null;
  }
  return clip(input, LIMITS[field] ?? 2_000);
}

function requiredText(input, field, reasons, allowMissing) {
  const value = optionalText(input, field, reasons);
  if (!value && !allowMissing) reasons.push(`${field}_required`);
  return value;
}

function normalizedStrings(value, limit, maxItems, reasons, field, allowMissing = false) {
  if (value === undefined && allowMissing) return [];
  if (!Array.isArray(value)) {
    reasons.push(`${field}_array_required`);
    return [];
  }
  const result = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== "string" || !item.trim()) {
      reasons.push(`${field}_invalid_item`);
      continue;
    }
    const normalized = clip(item, limit);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizeDecisionKey(value, reasons, allowMissing) {
  const raw = requiredText(value, "decision_key", reasons, allowMissing);
  if (!raw) return null;
  const normalized = raw.toLocaleLowerCase().replace(/[^a-z0-9._:-]+/gu, "_").replace(/^[_:.]+|[_:.]+$/gu, "");
  if (!normalized) {
    reasons.push("decision_key_invalid");
    return null;
  }
  return normalized.slice(0, LIMITS.decision_key);
}

function normalizeAlternatives(value, reasons, allowMissing) {
  if (value === undefined && allowMissing) return [];
  if (!Array.isArray(value)) {
    reasons.push("alternatives_array_required");
    return [];
  }
  return value.slice(0, 16).flatMap((item, index) => {
    if (typeof item === "string" && item.trim()) return [{ alternative: clip(item, LIMITS.alternative), reason_rejected: null }];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      reasons.push(`alternative_${index}_invalid`);
      return [];
    }
    const alternative = optionalText(item.alternative ?? item.option, "alternative", reasons);
    const reasonRejected = optionalText(item.reason_rejected ?? item.reason, "alternative", reasons);
    if (!alternative) {
      reasons.push(`alternative_${index}_required`);
      return [];
    }
    return [{ alternative, reason_rejected: reasonRejected }];
  });
}

function normalizeEvidence(value, workspaceRoot, reasons, allowMissing) {
  if (value === undefined && allowMissing) return [];
  if (!Array.isArray(value)) {
    reasons.push("evidence_selectors_array_required");
    return [];
  }
  return value.slice(0, 16).flatMap((selector, index) => {
    if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
      reasons.push(`evidence_selector_${index}_invalid`);
      return [];
    }
    if (!MEMORY_CONTRACT_V2_EVIDENCE_TYPES.includes(selector.type)) {
      reasons.push(`evidence_selector_${index}_type_invalid`);
      return [];
    }
    const ref = optionalText(selector.ref, "evidence_ref", reasons);
    const digest = optionalText(selector.digest ?? selector.command_hash, "evidence_ref", reasons);
    if (digest && !/^sha256:[a-f0-9]{64}$/iu.test(digest.startsWith("sha256:") ? digest : `sha256:${digest}`)) {
      reasons.push(`evidence_selector_${index}_digest_invalid`);
    }
    if (!ref && !digest) {
      reasons.push(`evidence_selector_${index}_ref_required`);
      return [];
    }
    if (["file", "doc", "user_statement"].includes(selector.type) && !ref) {
      reasons.push(`evidence_selector_${index}_ref_required_for_${selector.type}`);
    }
    if (selector.type === "tool_result" && !digest) {
      reasons.push(`evidence_selector_${index}_digest_required_for_tool_result`);
    }
    const supports = normalizedStrings(selector.supports, 128, 12, reasons, `evidence_selector_${index}_supports`, allowMissing);
    const normalizedRef = ref ? normalizeMemoryPaths(ref, workspaceRoot ?? null) : null;
    if (normalizedRef === "[external-path]" || normalizedRef?.startsWith("/") || /^[A-Za-z]:\\/u.test(normalizedRef ?? "")) {
      reasons.push("absolute_path_rejected");
      return [];
    }
    return [{
      type: selector.type,
      ...(normalizedRef ? { ref: normalizedRef } : {}),
      ...(digest ? { digest: digest.startsWith("sha256:") ? digest : `sha256:${digest}` } : {}),
      supports
    }];
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function legacyProjection(event) {
  if (event.lesson_type === "success") {
    return {
      kind: "fact",
      conclusion: event.procedure,
      rationale: event.why_it_worked,
      reuse_rule: event.reuse_when,
      outcome: event.observed_outcome
    };
  }
  if (event.lesson_type === "failure") {
    return {
      kind: "pitfall",
      conclusion: event.correction ?? event.root_cause,
      rationale: event.root_cause,
      reuse_rule: event.avoidance_rule,
      outcome: event.verified_outcome
    };
  }
  return {
    kind: event.decision_type === "preference" ? "preference" : "decision",
    conclusion: event.selected_value ?? event.decision,
    rationale: event.rationale,
    reuse_rule: event.reuse_when ?? event.avoidance_rule,
    outcome: event.selected_value ?? event.decision
  };
}

export async function normalizeMemoryContractV2Event(input, options = {}) {
  const reasons = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { accepted: false, event_hash: null, reason_codes: ["invalid_event"], event: null };
  }
  for (const field of Object.keys(input)) {
    if (!MEMORY_CONTRACT_V2_AI_FIELDS.has(field)) reasons.push("unknown_field");
  }
  if (input.schema_version !== MEMORY_CONTRACT_V2_SCHEMA_VERSION) reasons.push("unsupported_schema_version");
  if (input.record_type !== undefined && input.record_type !== "learning_observation") reasons.push("invalid_record_type");
  const lessonType = MEMORY_CONTRACT_V2_LESSON_TYPES.includes(input.lesson_type) ? input.lesson_type : null;
  const captureIntent = MEMORY_CONTRACT_V2_INTENTS.includes(input.capture_intent) ? input.capture_intent : null;
  if (!lessonType) reasons.push("invalid_lesson_type");
  if (!captureIntent) reasons.push("invalid_capture_intent");
  const allowMissing = captureIntent === "review";
  const trigger = requiredText(input.trigger, "trigger", reasons, allowMissing);
  const applicabilityInput = input.applicability && typeof input.applicability === "object" && !Array.isArray(input.applicability)
    ? input.applicability
    : {};
  if (!input.applicability && !allowMissing) reasons.push("applicability_required");
  const targetFiles = normalizedStrings(applicabilityInput.target_files, LIMITS.path, 16, reasons, "target_files", allowMissing)
    .map((item) => normalizeMemoryPaths(item, options.workspaceRoot ?? null));
  const components = normalizedStrings(applicabilityInput.components, LIMITS.component, 16, reasons, "components", allowMissing);
  if (targetFiles.length + components.length === 0 && !allowMissing) reasons.push("scope_missing");
  const evidenceSelectors = normalizeEvidence(input.evidence_selectors, options.workspaceRoot, reasons, allowMissing);
  if (evidenceSelectors.length === 0 && !allowMissing) reasons.push("evidence_selector_required");
  const gaps = normalizedStrings(input.gaps, 500, 16, reasons, "gaps", allowMissing);
  if (gaps.length > 0) reasons.push("gaps_present");

  const event = {
    record_type: "learning_observation",
    schema_version: MEMORY_CONTRACT_V2_SCHEMA_VERSION,
    lesson_type: lessonType,
    capture_intent: captureIntent,
    trigger,
    applicability: { target_files: targetFiles, components },
    evidence_selectors: evidenceSelectors,
    gaps
  };

  if (lessonType === "success") {
    event.procedure = requiredText(input.procedure, "procedure", reasons, allowMissing);
    event.why_it_worked = requiredText(input.why_it_worked, "why_it_worked", reasons, allowMissing);
    event.observed_outcome = requiredText(input.observed_outcome, "observed_outcome", reasons, allowMissing);
    event.reuse_when = requiredText(input.reuse_when, "reuse_when", reasons, allowMissing);
  }
  if (lessonType === "decision") {
    event.decision_type = MEMORY_CONTRACT_V2_DECISION_TYPES.includes(input.decision_type) ? input.decision_type : null;
    if (!event.decision_type) reasons.push("invalid_decision_type");
    event.decision_key = normalizeDecisionKey(input.decision_key, reasons, allowMissing);
    event.question = requiredText(input.question, "question", reasons, allowMissing);
    event.selected_value = optionalText(input.selected_value, "selected_value", reasons);
    event.decision = optionalText(input.decision, "decision", reasons);
    event.constraints = normalizedStrings(input.constraints, 500, 16, reasons, "constraints", allowMissing);
    event.rationale = optionalText(input.rationale, "rationale", reasons);
    event.alternatives = normalizeAlternatives(input.alternatives, reasons, allowMissing);
    event.reuse_when = optionalText(input.reuse_when, "reuse_when", reasons);
    if (!allowMissing && !event.selected_value && !event.decision) reasons.push("decision_value_required");
    if (!allowMissing && event.selected_value && event.decision) reasons.push("decision_value_ambiguous");
    if (!allowMissing && ["implementation", "governance"].includes(event.decision_type)) {
      if (!event.rationale) reasons.push("rationale_required_for_decision_type");
      if (event.alternatives.length === 0) reasons.push("alternatives_required_for_decision_type");
    }
  }
  if (lessonType === "failure") {
    event.symptom = requiredText(input.symptom, "symptom", reasons, allowMissing);
    event.failed_approach = requiredText(input.failed_approach, "failed_approach", reasons, allowMissing);
    event.root_cause = requiredText(input.root_cause, "root_cause", reasons, allowMissing);
    event.correction = requiredText(input.correction, "correction", reasons, allowMissing);
    event.verified_outcome = requiredText(input.verified_outcome, "verified_outcome", reasons, allowMissing);
    event.avoidance_rule = requiredText(input.avoidance_rule, "avoidance_rule", reasons, allowMissing);
  }

  Object.assign(event, legacyProjection(event));
  const sensitive = screenSensitiveMemory(JSON.stringify(event), options.sensitivePolicy ?? {
    mode: "deny",
    allowed_principals: []
  });
  if (!sensitive.allowed) reasons.push(sensitive.reason ?? "sensitive_content_rejected");
  const fatal = reasons.filter((reason) => reason !== "gaps_present" || captureIntent !== "review");
  const accepted = fatal.length === 0 && sensitive.allowed;
  return {
    accepted,
    event_hash: accepted ? await digest(JSON.stringify(stableValue(event))) : null,
    reason_codes: [...new Set(reasons)],
    event: accepted ? event : null
  };
}

export async function observeMemoryContractV2Event(input, options = {}) {
  const result = await normalizeMemoryContractV2Event(input, options);
  return {
    accepted: result.accepted,
    event_hash: result.event_hash,
    reason_codes: result.reason_codes
  };
}
