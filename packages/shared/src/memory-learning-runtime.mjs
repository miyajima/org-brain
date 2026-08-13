import { normalizeMemoryPaths, screenSensitiveMemory } from "./memory-capture-v2-runtime.mjs";

export const MEMORY_LEARNING_SCHEMA_VERSION = 1;
export const MEMORY_LEARNING_MAX_EVENTS = 3;
export const MEMORY_LESSON_TYPES = ["success", "decision", "failure"];
export const MEMORY_LEARNING_KINDS = ["decision", "constraint", "pitfall", "preference", "fact"];
export const MEMORY_EVIDENCE_SELECTOR_TYPES = ["command", "file", "doc", "user_statement"];

const LIMITS = {
  trigger: 1_000,
  conclusion: 1_000,
  rationale: 2_000,
  reuse_rule: 1_000,
  outcome: 1_000,
  path: 512,
  component: 128,
  evidence_ref: 1_000,
  gap: 500
};

function clip(value, limit) {
  const normalized = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : normalized.slice(0, limit);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function stringField(input, field, reasons, options = {}) {
  const value = input?.[field];
  if (value === null && options.nullable) return null;
  if (typeof value !== "string" || !value.trim()) {
    reasons.push(`${field}_required`);
    return options.nullable ? null : "";
  }
  return clip(value, LIMITS[field]);
}

function normalizedStrings(value, limit, maxItems, reasons, field) {
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

export async function normalizeMemoryLearningEvent(input, options = {}) {
  const reasons = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { accepted: false, event_hash: null, reason_codes: ["invalid_event"], event: null };
  }
  if (input.schema_version !== MEMORY_LEARNING_SCHEMA_VERSION) reasons.push("unsupported_schema_version");
  const lessonType = MEMORY_LESSON_TYPES.includes(input.lesson_type) ? input.lesson_type : null;
  const kind = MEMORY_LEARNING_KINDS.includes(input.kind) ? input.kind : null;
  if (!lessonType) reasons.push("invalid_lesson_type");
  if (!kind) reasons.push("invalid_kind");
  if (lessonType === "failure" && kind && !["pitfall", "fact"].includes(kind)) reasons.push("failure_kind_mismatch");
  if (lessonType === "decision" && kind && !["decision", "constraint", "preference"].includes(kind)) reasons.push("decision_kind_mismatch");

  const trigger = stringField(input, "trigger", reasons);
  const conclusion = stringField(input, "conclusion", reasons);
  const rationale = stringField(input, "rationale", reasons);
  const reuseRule = stringField(input, "reuse_rule", reasons);
  const outcome = stringField(input, "outcome", reasons, { nullable: lessonType === "decision" });
  if (lessonType !== "decision" && outcome === null) reasons.push("outcome_required");
  if (conclusion && rationale && conclusion.toLocaleLowerCase() === rationale.toLocaleLowerCase()) {
    reasons.push("rationale_duplicates_conclusion");
  }

  const applicability = input.applicability && typeof input.applicability === "object" && !Array.isArray(input.applicability)
    ? input.applicability
    : {};
  if (applicability !== input.applicability) reasons.push("applicability_required");
  const targetFiles = normalizedStrings(applicability.target_files, LIMITS.path, 16, reasons, "target_files")
    .map((item) => normalizeMemoryPaths(item, options.workspaceRoot ?? null));
  if (targetFiles.some((item) => item === "[external-path]" || item.startsWith("/") || /^[A-Za-z]:\\/u.test(item))) {
    reasons.push("absolute_path_rejected");
  }
  const components = normalizedStrings(applicability.components, LIMITS.component, 16, reasons, "components");

  const selectors = [];
  if (!Array.isArray(input.evidence_selectors)) {
    reasons.push("evidence_selectors_array_required");
  } else {
    for (const [index, selector] of input.evidence_selectors.slice(0, 16).entries()) {
      if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
        reasons.push(`evidence_selector_${index}_invalid`);
        continue;
      }
      if (!MEMORY_EVIDENCE_SELECTOR_TYPES.includes(selector.type)) {
        reasons.push(`evidence_selector_${index}_type_invalid`);
        continue;
      }
      const ref = clip(selector.ref, LIMITS.evidence_ref);
      if (!ref) {
        reasons.push(`evidence_selector_${index}_ref_required`);
        continue;
      }
      selectors.push({ type: selector.type, ref: normalizeMemoryPaths(ref, options.workspaceRoot ?? null) });
    }
  }
  if (selectors.length === 0) reasons.push("evidence_selector_required");
  const gaps = normalizedStrings(input.gaps, LIMITS.gap, 16, reasons, "gaps");

  const event = {
    schema_version: MEMORY_LEARNING_SCHEMA_VERSION,
    lesson_type: lessonType,
    kind,
    trigger,
    conclusion,
    rationale,
    reuse_rule: reuseRule,
    outcome,
    applicability: { target_files: targetFiles, components },
    evidence_selectors: selectors,
    gaps
  };
  const sensitive = screenSensitiveMemory(JSON.stringify(event), options.sensitivePolicy ?? {
    mode: "deny",
    allowed_principals: []
  });
  if (!sensitive.allowed) reasons.push(sensitive.reason ?? "sensitive_content_rejected");
  const fatal = reasons.filter((reason) => reason !== "gaps_present");
  if (gaps.length > 0) reasons.push("gaps_present");
  const accepted = fatal.length === 0 && sensitive.allowed;
  return {
    accepted,
    event_hash: accepted ? await sha256(JSON.stringify(stableValue(event))) : null,
    reason_codes: [...new Set(reasons)],
    event: accepted ? event : null
  };
}

export async function observeMemoryLearningEvent(input, options = {}) {
  const result = await normalizeMemoryLearningEvent(input, options);
  return {
    accepted: result.accepted,
    event_hash: result.event_hash,
    reason_codes: result.reason_codes
  };
}

