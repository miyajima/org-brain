const DURABLE_KIND_ORDER = ["fact", "decision", "constraint", "pitfall", "preference"];
const DERIVABLE_REQUIRED_FIELDS = ["rationale", "reuse_rule", "evidence"];
const REPOSITORY_REFERENCE_PATTERN = /^(?:apps|packages|scripts|docs|src|test|tests|config|migrations)\//u;
const VERIFIED_COMMAND_PATTERN = /(?:^|;)\s*exit_code=0(?:;|$)/u;
const ATOMIC_CONNECTOR_PATTERN = /(?:;|；|\b(?:and|also)\b|(?:および|かつ|さらに|また))\s*/iu;
const DURABLE_SIGNAL_PATTERN = /\b(?:must|must not|never|always|decided|adopt|prefer)\b|(?:必須|禁止|必ず|してはいけない|決定|採用|方針|優先する|根本原因|回避策)/giu;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function acceptedExamples(dataset) {
  if (!dataset || typeof dataset !== "object" || Array.isArray(dataset)) {
    throw new Error("memory capture gold dataset must be an object");
  }
  if (dataset.schema_version !== 1) throw new Error("memory capture gold dataset schema_version must be 1");
  if (!nonEmptyString(dataset.dataset_id)) throw new Error("memory capture gold dataset_id is required");
  if (!nonEmptyString(dataset.profile_id)) throw new Error("memory capture gold profile_id is required");
  if (!Array.isArray(dataset.examples) || dataset.examples.length === 0) {
    throw new Error("memory capture gold examples are required");
  }
  return dataset.examples.filter((example) => example?.expected?.accept === true);
}

function expectedCandidates(example) {
  const candidates = example?.expected?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`accepted gold example requires candidates: ${example?.id ?? "unknown"}`);
  }
  return candidates;
}

export function deriveMemoryCaptureHookProfile(dataset, options = {}) {
  const accepted = acceptedExamples(dataset);
  if (accepted.length === 0) throw new Error("memory capture gold dataset requires accepted examples");
  const allCandidates = accepted.flatMap(expectedCandidates);
  const kinds = uniqueSorted(allCandidates.map((candidate) => candidate.kind));
  for (const kind of kinds) {
    if (!DURABLE_KIND_ORDER.includes(kind)) throw new Error(`unsupported gold memory kind: ${kind}`);
  }

  const requiredFields = DERIVABLE_REQUIRED_FIELDS.filter((field) => allCandidates.every((candidate) => {
    if (field === "evidence") return Array.isArray(candidate.evidence) && candidate.evidence.length > 0;
    return nonEmptyString(candidate[field]);
  }));
  const minimumEvidenceByKind = {};
  const ttlDaysByKind = {};
  for (const kind of kinds) {
    const candidates = allCandidates.filter((candidate) => candidate.kind === kind);
    minimumEvidenceByKind[kind] = Math.min(...candidates.map((candidate) => candidate.evidence?.length ?? 0));
    const ttlValues = [...new Set(candidates.map((candidate) => Number(candidate.ttl_days)))].sort((left, right) => left - right);
    if (ttlValues.length !== 1 || !Number.isInteger(ttlValues[0]) || ttlValues[0] < 1) {
      throw new Error(`gold ttl_days must be one positive integer per kind: ${kind}`);
    }
    ttlDaysByKind[kind] = ttlValues[0];
  }

  const observedMaximum = Math.max(...accepted.map((example) => expectedCandidates(example).length));
  const configuredMaximum = Number(dataset.safety?.max_candidates ?? observedMaximum);
  if (!Number.isInteger(configuredMaximum) || configuredMaximum < observedMaximum || configuredMaximum > 3) {
    throw new Error("gold safety.max_candidates must cover examples and be between 1 and 3");
  }

  return {
    schema_version: 1,
    profile_id: dataset.profile_id,
    source_dataset: dataset.dataset_id,
    source_dataset_sha256: nonEmptyString(options.dataset_sha256) ? options.dataset_sha256 : null,
    max_candidates: configuredMaximum,
    accepted_kinds: DURABLE_KIND_ORDER.filter((kind) => kinds.includes(kind)),
    required_fields: requiredFields,
    minimum_rationale_characters: requiredFields.includes("rationale")
      ? Math.min(...allCandidates.map((candidate) => candidate.rationale.trim().length))
      : 0,
    minimum_reuse_rule_characters: requiredFields.includes("reuse_rule")
      ? Math.min(...allCandidates.map((candidate) => candidate.reuse_rule.trim().length))
      : 0,
    minimum_evidence_by_kind: minimumEvidenceByKind,
    allowed_evidence_types: uniqueSorted(allCandidates.flatMap((candidate) =>
      (candidate.evidence ?? []).map((item) => item.type)
    )),
    ttl_days_by_kind: ttlDaysByKind,
    reject_gaps: dataset.safety?.reject_gaps !== false,
    require_atomic_conclusion: dataset.safety?.require_atomic_conclusion !== false,
    require_distinct_rationale: dataset.safety?.require_distinct_rationale !== false,
    rejected_example_reasons: uniqueSorted(dataset.examples.flatMap((example) =>
      example?.expected?.accept === false && nonEmptyString(example.expected.reason)
        ? [example.expected.reason]
        : []
    ))
  };
}

export function isVerifiableMemoryEvidence(item, profile) {
  if (!item || typeof item !== "object" || !profile.allowed_evidence_types.includes(item.type)) return false;
  const ref = typeof item.ref === "string" ? item.ref.trim() : "";
  if (!ref || ref.includes("[external-path]")) return false;
  if (item.type === "file") return REPOSITORY_REFERENCE_PATTERN.test(ref);
  if (item.type === "doc") return /^https:\/\/[^\s]+$/u.test(ref);
  if (item.type === "command") return VERIFIED_COMMAND_PATTERN.test(String(item.note ?? ""));
  return false;
}

function isAtomicConclusion(content) {
  const text = String(content ?? "").trim();
  if (!text) return false;
  const sentences = text.split(/(?:[。!?](?:\s+|$)|[.!?](?:\s+|$))/u).filter(Boolean);
  if (sentences.length > 1) return false;
  const signals = text.match(DURABLE_SIGNAL_PATTERN) ?? [];
  return !(signals.length > 1 && ATOMIC_CONNECTOR_PATTERN.test(text));
}

export function assessMemoryCaptureDraft(draft, profile) {
  const reasons = [];
  if (!profile.accepted_kinds.includes(draft.kind)) reasons.push("quality_kind_not_allowed");
  if (profile.required_fields.includes("rationale") && !nonEmptyString(draft.rationale)) {
    reasons.push("quality_missing_rationale");
  } else if (nonEmptyString(draft.rationale) && draft.rationale.trim().length < profile.minimum_rationale_characters) {
    reasons.push("quality_rationale_too_short");
  }
  if (profile.required_fields.includes("reuse_rule") && !nonEmptyString(draft.reuse_rule)) {
    reasons.push("quality_missing_reuse_rule");
  } else if (nonEmptyString(draft.reuse_rule) && draft.reuse_rule.trim().length < profile.minimum_reuse_rule_characters) {
    reasons.push("quality_reuse_rule_too_short");
  }

  const evidence = Array.isArray(draft.evidence) ? draft.evidence : [];
  const verifiableEvidence = evidence.filter((item) => isVerifiableMemoryEvidence(item, profile));
  const requiredEvidence = profile.minimum_evidence_by_kind[draft.kind] ?? 1;
  if (verifiableEvidence.length < requiredEvidence) {
    reasons.push(
      verifiableEvidence.length > 0
        ? "quality_insufficient_evidence"
        : evidence.length > 0
          ? "quality_invalid_evidence"
          : "quality_missing_evidence"
    );
  }
  if (profile.reject_gaps && nonEmptyString(draft.gaps)) reasons.push("quality_unresolved_gaps");
  if (
    profile.require_distinct_rationale &&
    nonEmptyString(draft.rationale) &&
    canonicalText(draft.content) === canonicalText(draft.rationale)
  ) {
    reasons.push("quality_rationale_duplicates_content");
  }
  if (profile.require_atomic_conclusion && !isAtomicConclusion(draft.content)) {
    reasons.push("quality_non_atomic_conclusion");
  }

  const uniqueReasons = uniqueSorted(reasons);
  return {
    accepted: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    verifiable_evidence: verifiableEvidence,
    quality_score: Math.max(0, 100 - uniqueReasons.length * 25)
  };
}

export function enforceMemoryCaptureHookProfile(result, profile) {
  const drafts = [];
  const excluded = [...(result.excluded ?? [])];
  for (const draft of result.drafts ?? []) {
    const assessment = assessMemoryCaptureDraft(draft, profile);
    if (!assessment.accepted) {
      excluded.push(...assessment.reasons.map((reason) => ({ reason })));
      continue;
    }
    const ttlDays = profile.ttl_days_by_kind[draft.kind];
    drafts.push({
      ...draft,
      evidence: assessment.verifiable_evidence,
      valid_until: draft.valid_from + ttlDays * 24 * 60 * 60 * 1000,
      quality_score: assessment.quality_score,
      capture_profile_id: profile.profile_id,
      tags: [...new Set([...(draft.tags ?? []), `capture-profile:${profile.profile_id}`])]
    });
  }
  return { ...result, drafts, excluded, capture_profile: profile };
}
