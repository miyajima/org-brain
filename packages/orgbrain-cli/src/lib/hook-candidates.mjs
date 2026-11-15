import crypto from "node:crypto";
import { extractTaskCommitments } from "./task-commitment-store.mjs";
import { redactSensitiveText } from "./sensitive-text-redaction.mjs";
import { buildMemoryCaptureCandidateJson, buildProjectCategoryIdentity, extractDurableMemoryDrafts } from "../../../shared/src/memory-capture-v2-runtime.mjs";
import { MEMORY_CAPTURE_HOOK_PROFILE } from "../../../shared/src/memory-capture-profile.generated.mjs";
import { MEMORY_CONTRACT_V2_PROMPT_ID, MEMORY_CONTRACT_V2_VERIFIER_VERSION } from "../../../shared/src/memory-contract-v2-runtime.mjs";
import { MEMORY_CONTRACT_V2_CONTRACT_HASH, MEMORY_CONTRACT_V2_PROMPT_HASH } from "../../../shared/src/memory-contract-v2-contract.mjs";
import { collectVerifiedLearningEvents, collectVerifiedLearningEventsFromRows } from "./memory-learning-transcript.mjs";
import { buildPlanDecisionMemoryConfirmationCandidates } from "./memory-candidate-admission.mjs";
import { buildLearningExtractionPacket, buildTurnEvidenceV1, discoverLearningEpisodes } from "./turn-evidence-v1.mjs";

function hookPayloadFromRow(row) {
  if (!row || typeof row !== "object") return null;
  return row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : row;
}

function extractPlanTaskCommitments(rows, record, workspace) {
  const sessionId = firstString(record?.metadata?.sessionId, record?.metadata?.turnId, record?.externalKey);
  const extracted = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const payload = hookPayloadFromRow(row);
    if (!payload || typeof payload !== "object") continue;
    const normalizedPayload = {
      ...payload,
      session_id: firstString(payload.session_id, payload.sessionId, sessionId),
      turn_id: firstString(payload.turn_id, payload.turnId, record?.metadata?.turnId),
      cwd: firstString(payload.cwd, record?.cwd, workspace?.workspaceRoot),
      project_id: firstString(payload.project_id, workspace?.projectId)
    };
    // Transcript rows use `invocation` + `result`, while the post-tool hook
    // envelope uses `tool_input` + `tool_result`. Normalize the former before
    // passing it to the commitment parser; its generic unwrap helper treats a
    // top-level `result` as an envelope and would otherwise drop task identity.
    if (normalizedPayload.tool_name === undefined && normalizedPayload.invocation?.tool) {
      normalizedPayload.tool_name = normalizedPayload.invocation.tool;
    }
    if (normalizedPayload.tool_input === undefined && normalizedPayload.invocation?.arguments !== undefined) {
      normalizedPayload.tool_input = normalizedPayload.invocation.arguments;
    }
    if (normalizedPayload.tool_result === undefined && normalizedPayload.result !== undefined) {
      normalizedPayload.tool_result = normalizedPayload.result;
      delete normalizedPayload.result;
    }
    const commitments = extractTaskCommitments(normalizedPayload);
    extracted.push(...commitments);
  }
  return extracted.filter((commitment, index, all) => all.findIndex((item) =>
    item.task_key === commitment.task_key &&
    item.decision_key === commitment.decision_key &&
    item.evidence?.digest === commitment.evidence?.digest
  ) === index);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

export function dedupeTags(tags) {
  return [...new Set(tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim()))].slice(
    0,
    16
  );
}

export function normalizeWhitespace(value) {
  return firstString(value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function redactHookMemoryText(value) {
  return redactSensitiveText(String(value ?? ""), { phoneNumbers: "filtered" });
}

export function buildActorId(record) {
  const metadata = record?.metadata ?? {};
  const stableId = firstString(metadata.turnId, metadata.threadId, metadata.sessionId, metadata.sessionKey, metadata.messageId);
  return stableId ? `${record.sourceName}:${stableId}`.slice(0, 128) : firstString(record.sourceName, "unknown").slice(0, 128);
}

export function resolveMemoryCaptureV2Mode(env = process.env) {
  const value = firstString(env.ORGBRAIN_MEMORY_CAPTURE_V2_MODE, "off").toLowerCase();
  return value === "on" || value === "shadow" ? value : "off";
}

function canonicalEvidence(record) {
  return (record.evidence ?? []).map((item) => ({
    type: firstString(item.type, item.evidence_type, "external"),
    ref: firstString(item.ref, item.evidence_ref),
    ...(firstString(item.note) ? { note: firstString(item.note) } : {}),
    ...(Number.isFinite(item.weight ?? item.weight_score)
      ? { weight: Number(item.weight ?? item.weight_score) }
      : {})
  })).filter((item) => item.ref);
}

export function captureCandidateJson(record) {
  return buildMemoryCaptureCandidateJson({
    ...record,
    content: redactHookMemoryText(record.content),
    summary: redactHookMemoryText(record.summary),
    rationale: redactHookMemoryText(record.rationale),
    reuseRule: redactHookMemoryText(record.reuseRule ?? record.reuse_rule),
    evidence: canonicalEvidence(record)
  });
}

export function captureItemPayload(record) {
  const candidate = captureCandidateJson(record);
  const candidateId = firstString(
    record.candidate_id,
    record.candidateId,
    record.learning?.contract_metadata?.candidate_id
  );
  const aiCertification = firstString(
    record.ai_certification,
    record.certification,
    record.learning?.contract_metadata?.ai_certification
  );
  const judgeConsensus = record.judge_consensus ?? record.learning?.contract_metadata?.judge_consensus;
  const learning = record.learning && typeof record.learning === "object"
    ? {
      ...record.learning,
      contract_metadata: {
        ...(record.learning.contract_metadata && typeof record.learning.contract_metadata === "object"
          ? record.learning.contract_metadata
          : {}),
        ...(candidateId ? { candidate_id: candidateId } : {}),
        ...(aiCertification ? { ai_certification: aiCertification } : {}),
        ...(judgeConsensus ? { judge_consensus: judgeConsensus } : {})
      }
    }
    : null;
  return {
    ...candidate,
    evidence: (candidate.evidence ?? []).map((item, index) => ({
      evidence_type: ["file", "command", "doc"].includes(item.type) ? item.type : "external",
      evidence_ref: item.ref,
      relation: "supports",
      note: item.note ?? null,
      weight_score: item.weight ?? null,
      ...(record.evidence?.[index]?.contentHash ? { content_hash: record.evidence[index].contentHash } : {}),
      ...(record.evidence?.[index]?.diffHash ? { diff_hash: record.evidence[index].diffHash } : {}),
      ...(record.evidence?.[index]?.observedAt ? { observed_at: record.evidence[index].observedAt } : {}),
      ...(record.evidence?.[index]?.attestationRef ? { attestation_ref: record.evidence[index].attestationRef } : {})
    })),
    ...(learning ? { learning } : {}),
    ...(candidateId ? { candidate_id: candidateId } : {}),
    ...(aiCertification ? { ai_certification: aiCertification } : {}),
    ...(judgeConsensus ? { judge_consensus: judgeConsensus } : {}),
    ...(record.captureOrigin ? { capture_origin: record.captureOrigin } : {}),
    ...(record.captureRoute ? { capture_route: record.captureRoute } : {}),
    ...(record.captureBatchId ? { capture_batch_id: record.captureBatchId } : {}),
    ...(record.verification ? { verification: record.verification } : {}),
    ...(record.qualityDimensions ? { quality_dimensions: record.qualityDimensions } : {}),
    ...(record.learning?.reported_verification ? { verification_state: "unverified" } : {})
  };
}

export function deterministicRecordConfirmationCandidate(record) {
  if (!record || typeof record !== "object") return null;
  // Rule extraction identifies durable assertions, not executed success/failure
  // chains. Those categories must come through the existing observed-learning
  // verifier. A summary is never a symptom, failed attempt or checked outcome.
  if (["procedure", "pitfall"].includes(record.kind)) return null;
  const evidence = Array.isArray(record.evidence) ? record.evidence.slice(0, 3) : [];
  if (!record.content || !record.rationale || !record.reuseRule || evidence.length === 0) return null;
  const common = {
    external_key: record.externalKey,
    project_id: record.projectId,
    verification: { state: "partial", evidence },
    evidence,
    source_references: Array.isArray(record.sourceReferences) ? record.sourceReferences.slice(0, 3) : [],
    observation: {
      schema_version: 2,
      capture_intent: "review",
      evidence_selectors: evidence,
      gaps: []
    }
  };
  return {
    ...common,
    confirmation_only: true,
    observation: {
      ...common.observation,
      lesson_type: "decision",
      decision_type: record.kind === "preference" ? "preference" : "policy",
      selected_value: record.content,
      rationale: record.rationale,
      reuse_when: record.reuseRule
    }
  };
}

export function isMemoryConfirmationFlowArtifact(candidate) {
  const value = JSON.stringify(candidate ?? {});
  return /orgbrain_memory_confirmation_|<hook_prompt>|OrgBrainに記録しますか[？?]|保存する \(Recommended\)/u.test(value);
}

export async function prepareMemoryRecordsV2(record, workspace, tenantId, options = {}) {
  const extraction = extractDurableMemoryDrafts({
    event_id: record.externalKey,
    tenant_id: tenantId,
    project_id: workspace.projectId,
    source: record.sourceName,
    occurred_at: record.createdAt,
    text: record.assistantText
  }, {
    workspace_root: workspace.workspaceRoot,
    sensitive_policy: workspace.sensitiveMemory,
    max_candidates: MEMORY_CAPTURE_HOOK_PROFILE.max_candidates,
    capture_profile: MEMORY_CAPTURE_HOOK_PROFILE
  });
  const categoryDigest = sha256(`${tenantId}\0${workspace.projectId || "global"}`);
  const category = buildProjectCategoryIdentity(tenantId, workspace.projectId, categoryDigest);
  const businessCategoryId = record.businessCategoryId ?? workspace.businessCategoryId ?? category.id;
  const workType = record.workType ?? workspace.workType ?? "other";
  const recordFromDraft = (draft, extras = {}) => {
    const canonicalKey = sha256(`${tenantId}\0${workspace.projectId || "global"}\0${draft.kind}\0${draft.canonical_text}`);
    return {
      externalKey: `v2:${sha256(`${record.externalKey}\0${canonicalKey}`)}`,
      canonicalKey,
      createdAt: record.createdAt,
      cwd: record.cwd,
      projectId: workspace.projectId,
      projectIdExplicit: record.projectIdExplicit,
      businessCategoryId,
      businessCategory: category,
      workType,
      summary: draft.summary,
      tags: dedupeTags([...draft.tags, record.eventType]),
      content: draft.content,
      kind: draft.kind,
      rationale: draft.rationale,
      reuseRule: draft.reuse_rule,
      ...(draft.reported_verification ? {
        learning: { reported_verification: draft.reported_verification }
      } : {}),
      evidence: draft.evidence.map((item) => ({
        type: ["file", "command", "doc"].includes(item.type) ? item.type : "external",
        ref: item.ref,
        ...(item.note ? { note: item.note } : {}),
        weight: item.type === "file" || item.type === "doc" ? 0.9 : 0.8
      })),
      sourceReferences: draft.source_references,
      validUntil: draft.valid_until,
      confidenceScore: draft.confidence_score,
      utilityScore: draft.utility_score,
      visibility: draft.visibility,
      allowedPrincipals: draft.allowed_principals,
      qualityScore: draft.quality_score,
      captureProfileId: draft.capture_profile_id,
      captureRoute: "realtime_hook",
      ...extras,
      actorType: "system",
      actorId: buildActorId(record)
    };
  };
  const records = extraction.drafts.map((draft) => recordFromDraft(draft));
  const evidenceRows = Array.isArray(options.rows) && (options.rows.length > 0 || options.requireFullTurn === true)
    ? options.rows
    : [{
        timestamp: new Date(record.createdAt).toISOString(),
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: record.assistantText }]
        }
      }];
  const turnEvidence = await buildTurnEvidenceV1({
    rows: evidenceRows,
    session_hash: record.metadata?.sessionHash ?? (record.metadata?.sessionId ? sha256(record.metadata.sessionId) : null),
    turn_hash: record.metadata?.turnHash ?? (record.metadata?.turnId ? sha256(record.metadata.turnId) : null),
    project_id: workspace.projectId,
    provider: record.metadata?.modelProvider ?? null,
    model: record.metadata?.model ?? null
  }, {
    workspace_root: workspace.workspaceRoot,
    sensitive_policy: workspace.sensitiveMemory,
    preserve_snippet_text: options.extractionProfile === "coverage/v1" || options.refinementProfile === "a-plus/v1"
  });
  const episodeDiscovery = await discoverLearningEpisodes(turnEvidence, {
    workspace_root: workspace.workspaceRoot,
    sensitive_policy: workspace.sensitiveMemory
  });
  const eagerActionEvidence = (turnEvidence.review_diagnostics?.successful_actions_after_miss ?? []).map((item) => ({
    type: "external",
    ref: `turn:${turnEvidence.turn_hash ?? turnEvidence.evidence_hash}#call:${item.call_id}`,
    note: [
      `tool=${item.tool}`,
      `result_hash=${item.result_hash}`,
      Number.isInteger(item.exit_code) ? `exit_code=${item.exit_code}` : null,
      Number.isInteger(item.http_status) ? `http_status=${item.http_status}` : null
    ].filter(Boolean).join("; "),
    weight: 1,
    contentHash: item.result_hash,
    observedAt: record.createdAt,
    attestationRef: turnEvidence.evidence_hash
  }));
  const evidenceOnlyReasons = new Set([
    "quality_missing_evidence",
    "quality_invalid_evidence",
    "quality_insufficient_evidence"
  ]);
  const eagerReviewDrafts = (extraction.review_drafts ?? []).filter((draft) => {
    const reasons = draft.review_reason_codes ?? [];
    return reasons.length > 0 &&
      reasons.every((reason) => evidenceOnlyReasons.has(reason)) &&
      typeof draft.rationale === "string" && draft.rationale.trim().length >= MEMORY_CAPTURE_HOOK_PROFILE.minimum_rationale_characters &&
      typeof draft.reuse_rule === "string" && draft.reuse_rule.trim().length >= MEMORY_CAPTURE_HOOK_PROFILE.minimum_reuse_rule_characters;
  });
  const eagerRetrievalMiss = turnEvidence.review_diagnostics?.latest_retrieval === "miss";
  const eagerRecords = eagerRetrievalMiss && eagerActionEvidence.length > 0 && !turnEvidence.hard_exclusion_reason
    ? [...extraction.drafts, ...eagerReviewDrafts].slice(0, MEMORY_CAPTURE_HOOK_PROFILE.max_candidates).map((draft) => recordFromDraft({
        ...draft,
        evidence: [...(draft.evidence ?? []), ...eagerActionEvidence].slice(0, 8),
        tags: [...new Set([...(draft.tags ?? []), "eager-learning", "retrieval-gap-closed"])]
      }, {
        captureOrigin: "retrieval-gap"
      }))
    : [];
  const planDecisionCandidates = buildPlanDecisionMemoryConfirmationCandidates(
    extractPlanTaskCommitments(options.rows, record, workspace),
    { projectId: workspace.projectId, sensitivePolicy: workspace.sensitiveMemory }
  );
  // Rule proposals are hints for the one bounded LLM call. They are no longer
  // independently persisted as durable review candidates, because doing so
  // made the prefilter an irreversible final classifier.
  const reviewCandidates = [];
  // These are questions for the human, not verified learning or an automatic
  // capture batch. A missing rationale is precisely something we may clarify.
  const confirmationCandidates = (episodeDiscovery.review_drafts ?? [])
    .filter((draft) => draft.observation?.lesson_type === "decision")
    .flatMap((draft) => {
      const references = (draft.support_span_ids ?? []).flatMap((spanId) => {
        const parent = turnEvidence.snippets.find((snippet) => spanId === snippet.span_id || spanId.startsWith(`${snippet.span_id}.`));
        if (!parent || parent.context_only) return [];
        return [{
          type: "turn_evidence", ref: `turn:${turnEvidence.turn_hash ?? turnEvidence.evidence_hash}#${spanId}`,
          span_id: spanId, parent_span_id: parent.span_id, role: parent.role,
          content_hash: `sha256:${sha256(parent.text)}`
        }];
      }).slice(0, 3);
      if (!references.length) return [];
      return [{
        ...draft, project_id: workspace.projectId, confirmation_only: true,
        confirmation_prompt: "decision_signal",
        source_references: references,
        evidence: references.map((reference) => ({ type: "thread", ref: reference.ref })),
        external_key: `human-review:${draft.event_hash}`
      }];
    });
  // Plan answers already have exact request_user_input evidence and are
  // explicit task commitments. Offer them as a separate, low-friction
  // promotion question without requiring rationale/alternatives up front.
  const allConfirmationCandidates = [...planDecisionCandidates, ...confirmationCandidates];
  const operational = episodeDiscovery.operational_history;
  const operationalRecords = operational && workspace.projectId
    ? (() => {
        const canonicalKey = sha256(`${tenantId}\0${workspace.projectId}\0episodic\0${operational.content}`);
        return [{
          externalKey: `episodic:v3:${canonicalKey}`,
          canonicalKey,
          createdAt: record.createdAt,
          cwd: record.cwd,
          projectId: workspace.projectId,
          projectIdExplicit: record.projectIdExplicit,
          businessCategoryId,
          businessCategory: category,
          workType,
          summary: operational.summary,
          tags: dedupeTags(["capture-v3", "operational-history", "ttl-30d", record.eventType]),
          content: operational.content,
          kind: "episodic",
          rationale: "Short-lived project history retained for chronology and repeat-prevention only.",
          reuseRule: "Use only for the same project while unexpired; do not treat as a durable rule.",
          evidence: [{ type: "external", ref: `turn:${turnEvidence.turn_hash ?? turnEvidence.evidence_hash}`, weight: 0.8 }],
          sourceReferences: operational.support_span_ids.map((spanId) => ({ type: "turn_evidence", ref: spanId })),
          validUntil: record.createdAt + operational.expires_in_days * 24 * 60 * 60 * 1000,
          confidenceScore: 0.8,
          utilityScore: 0.55,
          visibility: "private",
          allowedPrincipals: [],
          qualityScore: 70,
          captureProfileId: "memory-extraction-router/v2",
          captureRoute: "realtime_hook",
          actorType: "system",
          actorId: buildActorId(record)
        }];
      })()
    : [];
  let extractionPacket = null;
  let extractionPacketError = null;
  if (episodeDiscovery.llm_recommended && turnEvidence.provider && turnEvidence.model) {
    try {
      extractionPacket = buildLearningExtractionPacket(turnEvidence, episodeDiscovery, {
        extraction_profile: options.extractionProfile,
        refinement_profile: options.refinementProfile
      });
    } catch (error) {
      extractionPacketError = error instanceof Error ? error.message : "memory_extraction_packet_failed";
    }
  }
  const hardExcluded = episodeDiscovery.excluded.filter((item) => item.disposition === "hard_excluded");
  const extractionWirePacket = extractionPacket
    ? Object.fromEntries(Object.entries(extractionPacket).filter(([key]) => key !== "packet_hash"))
    : null;
  return {
    records,
    eagerRecords,
    operationalRecords,
    reviewCandidates,
    confirmationCandidates: allConfirmationCandidates,
    extractionRequest: extractionPacket ? {
      packet: extractionWirePacket,
      packet_hash: extractionPacket.packet_hash,
      provider: turnEvidence.provider,
      model: turnEvidence.model,
      reserved_tokens: extractionWirePacket.extraction_profile === "coverage/v1" ? 5_600 : 2_800
    } : null,
    category,
    report: {
      candidate_count: records.length,
      review_count: reviewCandidates.length,
      confirmation_candidate_count: allConfirmationCandidates.length,
      no_candidate: records.length === 0 && reviewCandidates.length === 0 && allConfirmationCandidates.length === 0 && hardExcluded.length === 0,
      hard_excluded_count: hardExcluded.length,
      would_call_llm: Boolean(extractionPacket),
      routing: episodeDiscovery.routing,
      operational_history_count: operationalRecords.length,
      packet_hash: extractionPacket?.packet_hash ?? null,
      extraction_error: extractionPacketError,
      collection_diagnostics: turnEvidence.collection_diagnostics,
      input_diagnostics: extractionPacket?.input_diagnostics ?? extractionPacket?.coverage?.input_diagnostics ?? null,
      provider: turnEvidence.provider,
      model: turnEvidence.model,
      reserved_tokens: extractionPacket ? (extractionPacket.extraction_profile === "coverage/v1" ? 5_600 : 2_800) : 0,
      candidate_hashes: records.map((candidate) => sha256(JSON.stringify(captureCandidateJson(candidate)))),
      capture_profile_id: MEMORY_CAPTURE_HOOK_PROFILE.profile_id,
      capture_profile_source_hash: MEMORY_CAPTURE_HOOK_PROFILE.source_dataset_sha256,
      quality_scores: records.map((candidate) => candidate.qualityScore ?? null),
      eager_candidate_count: eagerRecords.length,
      recall_miss_count: Number(turnEvidence.review_diagnostics?.recall_misses ?? 0),
      recall_hit_count: Number(turnEvidence.review_diagnostics?.recall_hits ?? 0),
      latest_retrieval: turnEvidence.review_diagnostics?.latest_retrieval ?? null,
      opaque_tool_wrappers: Number(turnEvidence.review_diagnostics?.opaque_tool_wrappers ?? 0),
      successful_actions_after_miss: eagerActionEvidence.length,
      excluded_reasons: [...new Set([
        ...extraction.excluded.map((item) => item.reason),
        ...episodeDiscovery.excluded.map((item) => item.reason)
      ])],
      sensitivity_reason: extraction.sensitivity.reason,
      sensitive_counts: extraction.sensitivity.counts
    }
  };
}

export async function prepareObservedLearningRecords(record, workspace, tenantId, options = {}) {
  const transcriptOptions = {
    tenantId,
    transcriptPath: record.metadata?.transcriptPath,
    turnId: record.metadata?.turnId,
    workspaceRoot: workspace.workspaceRoot,
    sensitivePolicy: workspace.sensitiveMemory
  };
  const transcript = await (Array.isArray(options.rows)
    ? collectVerifiedLearningEventsFromRows(options.rows, transcriptOptions)
    : collectVerifiedLearningEvents(transcriptOptions)).catch((error) => ({
    events: [],
    reviews: [{ reason_codes: ["transcript_read_failed"], detail_hash: sha256(String(error)) }],
    raw_transcript_persisted: false
  }));
  const categoryDigest = sha256(`${tenantId}\0${workspace.projectId || "global"}`);
  const category = buildProjectCategoryIdentity(tenantId, workspace.projectId, categoryDigest);
  const businessCategoryId = record.businessCategoryId ?? workspace.businessCategoryId ?? category.id;
  const workType = record.workType ?? workspace.workType ?? "other";
  const ttl = { fact: 90, decision: 180, constraint: 180, pitfall: 180, preference: 180 };
  const commitmentOnlyCount = transcript.events.filter(({ learning }) =>
    learning.schema_version === 2 && learning.lesson_type === "decision" &&
    ["user_choice", "preference"].includes(learning.decision_type)
  ).length;
  const formalEvents = transcript.events.filter(({ learning }) => !(
    learning.schema_version === 2 && learning.lesson_type === "decision" &&
    ["user_choice", "preference"].includes(learning.decision_type)
  ));
  const records = formalEvents.map(({ event_hash: eventHash, learning: observedLearning, verification }) => {
    const learning = {
      ...observedLearning,
      contract_metadata: {
        session_id_hash: record.metadata?.sessionId ? `sha256:${sha256(record.metadata.sessionId)}` : null,
        turn_id_hash: record.metadata?.turnId ? `sha256:${sha256(record.metadata.turnId)}` : null,
        contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH
      }
    };
    const canonicalText = normalizeWhitespace(learning.conclusion || learning.selected_value || learning.decision || learning.correction || "learning").toLocaleLowerCase();
    const canonicalKey = sha256(`${tenantId}\0${workspace.projectId || "global"}\0${learning.kind}\0${canonicalText}`);
    const validUntil = record.createdAt + (ttl[learning.kind] ?? 180) * 24 * 60 * 60 * 1000;
    return {
      externalKey: `learning:${sha256(`${record.externalKey}\0${eventHash}\0${canonicalKey}`)}`,
      canonicalKey,
      createdAt: record.createdAt,
      cwd: record.cwd,
      projectId: workspace.projectId,
      projectIdExplicit: record.projectIdExplicit,
      businessCategoryId,
      businessCategory: category,
      workType,
      summary: learning.conclusion || learning.selected_value || learning.decision || learning.correction || "Verified learning",
      tags: dedupeTags(["verified-learning", learning.lesson_type, learning.kind, record.eventType]),
      content: learning.conclusion || learning.selected_value || learning.decision || learning.correction || "Verified learning",
      kind: learning.kind,
      rationale: learning.rationale,
      reuseRule: learning.reuse_rule,
      evidence: verification.evidence.map((item) => ({
        type: item.type,
        ref: item.ref,
        note: [
          `content_hash=${item.content_hash}`,
          item.diff_hash ? `diff_hash=${item.diff_hash}` : null,
          `observed_at=${item.observed_at}`,
          `attestation_ref=${item.attestation_ref}`,
          Number.isInteger(item.exit_code) ? `exit_code=${item.exit_code}` : null
        ].filter(Boolean).join("; "),
        weight: 1,
        contentHash: item.content_hash,
        diffHash: item.diff_hash,
        observedAt: item.observed_at,
        attestationRef: item.attestation_ref
      })),
      sourceReferences: [{ type: "codex-turn", ref: `sha256:${eventHash}`, captured_at: record.createdAt }],
      validUntil,
      confidenceScore: verification.evidence.length >= 2 ? 0.95 : 0.9,
      utilityScore: 0.95,
      visibility: workspace.projectId ? "project" : "tenant",
      allowedPrincipals: [],
      qualityScore: verification.quality_score,
      captureOrigin: "observed",
      captureRoute: "realtime_hook",
      learning,
      verification: {
        state: verification.verification_state,
        verified_at: verification.verified_at,
        attestation_ref: `sha256:${eventHash}`
      },
      qualityDimensions: verification.quality_dimensions,
      actorType: "system",
      actorId: "hook:codex-stop"
    };
  });
  const reviewCandidates = transcript.reviews
    .filter((item) => item?.learning)
    .slice(0, 3)
    .map((item) => ({
      external_key: `learning-review:${sha256(`${record.externalKey}\0${item.event_hash ?? sha256(JSON.stringify(item.learning))}`)}`,
      prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
      prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
      contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
      verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
      capture_intent: "review",
      project_id: workspace.projectId,
      task_key: firstString(record.metadata?.sessionId, record.metadata?.turnId) ? `codex:${firstString(record.metadata?.sessionId, record.metadata?.turnId)}` : null,
      observation: item.learning,
      reason_codes: item.reason_codes ?? item.verification?.reason_codes ?? [],
      verification: item.verification ?? null,
      created_at: record.createdAt,
      expires_at: record.createdAt + 180 * 24 * 60 * 60 * 1000
    }));
  const deterministicReviewCandidates = options.includeDeterministicReviewCandidates === false
    ? []
    : records.map((item) => ({
    external_key: `learning-review:${sha256(`${record.externalKey}\0${item.externalKey}`)}`,
    prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
    prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
    contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
    verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
    capture_intent: "verify",
    project_id: workspace.projectId,
    task_key: firstString(record.metadata?.sessionId, record.metadata?.turnId) ? `codex:${firstString(record.metadata?.sessionId, record.metadata?.turnId)}` : null,
    item: captureItemPayload(item),
    observation: item.learning,
    verification: item.verification,
    evidence: item.evidence,
    reason_codes: ["ai_consensus_pending"],
    created_at: record.createdAt,
    expires_at: record.createdAt + 180 * 24 * 60 * 60 * 1000
  }));
  const allReviewCandidates = [...deterministicReviewCandidates, ...reviewCandidates].slice(0, 3);
  return {
    records,
    reviewCandidates: allReviewCandidates,
    category,
    report: {
      mode: workspace.memoryLearningMode,
      observed_count: transcript.events.length,
      commitment_only_count: commitmentOnlyCount,
      review_count: allReviewCandidates.length,
      candidate_hashes: records.map((candidate) => sha256(JSON.stringify(captureItemPayload(candidate)))),
      review_reason_codes: [...new Set(transcript.reviews.flatMap((item) => item.reason_codes ?? []))],
      scanned_bytes: transcript.scanned_bytes ?? 0,
      raw_transcript_persisted: false
    }
  };
}

