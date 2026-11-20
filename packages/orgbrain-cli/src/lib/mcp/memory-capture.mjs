import { screenInteractiveProse, normalizeMemoryReviewContext as localReviewContext } from "@org-brain/shared/runtime/memory-review-runtime";
import { useHash } from "@org-brain/shared/runtime/memory-use-history-runtime";
import { randomUUID } from "node:crypto";
import { classifyMemoryReviewAnswer, memoryCategoryFromReviewAnswer, MEMORY_REVIEW_LABELS, withMemoryCategoryTags } from "@org-brain/shared/runtime/memory-usefulness-runtime";
const LOCAL_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
import { classifiedAutoSaveEnabled } from "../memory-classified-autosave.mjs";
import { receiveLocalUseObservation } from "../local-use-observations.mjs";
import { observeMemoryLearningEvent } from "@org-brain/shared/runtime/memory-learning-runtime";
import { MEMORY_CONTRACT_V2_PROMPT_ID, MEMORY_CONTRACT_V2_VERIFIER_VERSION, observeMemoryContractV2Event } from "@org-brain/shared/runtime/memory-contract-v2-runtime";
import { MEMORY_CONTRACT_V2_CONTRACT_HASH, MEMORY_CONTRACT_V2_PROMPT_HASH } from "@org-brain/shared/runtime/memory-contract-v2-contract";
import { isAiConsensusCertified } from "@org-brain/shared/runtime/memory-contract-judge";
import { TaskCommitmentStore } from "../task-commitment-store.mjs";
import { boundedString } from "./common.mjs";

export const memoryCaptureDefinitions = [
  {name:"orgbrain_memories_confirmation_status",description:"Read a local proposal or durable save receipt after an uncertain response. Does not save or ask again.",inputSchema:{type:"object",required:["confirmation_token"],properties:{tenant_id:{type:"string"},confirmation_token:{type:"string",minLength:1,maxLength:64}}}},
  {
    name: "orgbrain_memories_propose",
    description: "Propose one local memory and inferred rationale without persisting it. Show the conclusion and reason to the user before confirming.",
    inputSchema: {
      type: "object",
      required: ["item"],
      properties: {
        tenant_id: { type: "string" },
        source: { type: "string" },
        review_context: {type:"object",required:["candidate_id","candidate_hash","source_references"],properties:{
          candidate_id:{type:"string",maxLength:128},candidate_hash:{type:"string",pattern:"^[a-f0-9]{64}$"},
          source_references:{type:"array",maxItems:8,items:{type:"object"}},
          conclusion:{type:"string",maxLength:2000},reason_summary:{type:"string",maxLength:2000},reuse_rule:{type:"string",maxLength:2000}
        }},
        actor_type: { type: "string" },
        actor_id: { type: "string" },
        item: {
          type: "object",
          required: ["content"],
          properties: {
            external_key: { type: "string", maxLength: 256 },
            content: { type: "string", minLength: 1, maxLength: 20000 },
            summary: { type: "string", maxLength: 1000 },
            tags: { type: "array", maxItems: 16, items: { type: "string", maxLength: 64 } },
            created_at: { type: "integer" },
            project_id: { type: ["string", "null"], maxLength: 128 },
            business_category_id: { type: ["string", "null"], maxLength: 128 },
            work_type: { type: ["string", "null"] }
          }
        },
        entities: { type: "array", maxItems: 8, items: { type: "object" } },
        evidence: { type: "array", maxItems: 8, items: { type: "object" } }
      }
    }
  },
  {
    name: "orgbrain_memories_confirm",
    description: "Persist a previously proposed local memory only after explicit user confirmation.",
    inputSchema: {
      type: "object",
      required: ["confirmation_token", "approved"],
      properties: {
        tenant_id: { type: "string" },
        confirmation_token: { type: "string", minLength: 1, maxLength: 64 },
        approved: { type: "boolean" },
        review_label:{type:"string",enum:MEMORY_REVIEW_LABELS},
        review_answer:{type:"string",maxLength:2000},
        corrected_content: { type: "string", maxLength: 20000 },
        corrected_summary: { type: "string", maxLength: 1000 },
        conclusion: { type: "string", maxLength: 240 },
        reason_summary: { type: "string", maxLength: 500 },
        reuse_rule: { type: "string", maxLength: 2000 },
        decision_type: { type: "string", enum: ["adopt", "reject", "prioritize", "diagnose", "workaround", "policy"] },
        status: { type: "string", maxLength: 64 },
        entities: { type: "array", maxItems: 8, items: { type: "object" } },
        evidence: { type: "array", maxItems: 8, items: { type: "object" } }
      }
    }
  },
  {
    name: "orgbrain_memory_observe",
    description: "Validate one current-turn learning event without saving a memory. For use_observation, issue a local tracking receipt pending transcript verification; print use_receipt in wrapped tool output. Use actual call IDs, never tool names. At most three per turn.",
    inputSchema: {
      type: "object",
      required: ["schema_version", "lesson_type"],
      properties: {
        schema_version: { type: "integer", enum: [1, 2] },
        tenant_id: { type: "string" },
        use_observation: {type:"object"},
        lesson_type: { type: "string", enum: ["success", "decision", "failure"] },
        kind: { type: "string", enum: ["decision", "constraint", "pitfall", "preference", "fact"] },
        record_type: { type: "string", const: "learning_observation" },
        capture_intent: { type: "string", enum: ["verify", "review"] },
        trigger: { type: ["string", "null"] }, conclusion: { type: ["string", "null"] }, rationale: { type: ["string", "null"] },
        reuse_rule: { type: ["string", "null"] }, outcome: { type: ["string", "null"] },
        procedure: { type: ["string", "null"] }, why_it_worked: { type: ["string", "null"] },
        observed_outcome: { type: ["string", "null"] }, reuse_when: { type: ["string", "null"] },
        decision_type: { type: "string", enum: ["user_choice", "preference", "implementation", "governance"] },
        decision_key: { type: ["string", "null"] }, question: { type: ["string", "null"] },
        selected_value: { type: ["string", "null"] }, decision: { type: ["string", "null"] },
        constraints: { type: "array", items: { type: "string" } },
        alternatives: { type: "array", items: { type: "object" } },
        symptom: { type: ["string", "null"] }, failed_approach: { type: ["string", "null"] },
        root_cause: { type: ["string", "null"] }, correction: { type: ["string", "null"] },
        verified_outcome: { type: ["string", "null"] }, avoidance_rule: { type: ["string", "null"] },
        applicability: {
          type: "object", required: ["target_files", "components"],
          properties: {
            target_files: { type: "array", maxItems: 16, items: { type: "string" } },
            components: { type: "array", maxItems: 16, items: { type: "string" } }
          }
        },
        evidence_selectors: {
          type: "array", minItems: 1, maxItems: 16,
          items: {
            type: "object", required: ["type"],
            properties: {
              type: { type: "string", enum: ["command", "file", "doc", "user_statement", "tool_result"] },
              ref: { type: "string" }, digest: { type: "string" }, supports: { type: "array", items: { type: "string" } }
            }
          }
        },
        gaps: { type: "array", maxItems: 16, items: { type: "string" } }
      }
    }
  },
  {
    name: "orgbrain_learning_batch_ingest",
    description: "Persist explicit task commitments, verified memories, and autonomous quarantine candidates as one idempotent local batch.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string" },
        project_id: { type: ["string", "null"] },
        task_key: { type: ["string", "null"] },
        source: { type: "string", maxLength: 64 },
        prompt_contract_id: { type: "string", maxLength: 128 },
        prompt_hash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        verifier_version: { type: "string", maxLength: 128 },
        contract_hash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        commitments: { type: "array", maxItems: 16, items: { type: "object" } },
        verified_items: { type: "array", maxItems: 3, items: { type: "object" } },
        deterministically_verified_items: { type: "array", maxItems: 3, items: { type: "object" } },
        review_candidates: { type: "array", maxItems: 3, items: { type: "object" } },
        quarantine_candidates: { type: "array", maxItems: 3, items: { type: "object" } },
        semantic_aliases: { type: "array", maxItems: 16, items: { type: "object" } }
      }
    }
  },
  {
    name: "orgbrain_memory_capture",
    description: "Capture one durable memory in the local OrgBrain SQLite store.",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string" },
        summary: { type: ["string", "null"] },
        tenant_id: { type: "string" },
        target_tenant_id: { const: "all" },
        project_id: { type: ["string", "null"] },
        business_category_id: { type: ["string", "null"] },
        work_type: {
          type: ["string", "null"],
          enum: ["implementation", "review", "debug", "proposal", "support", "research", "operations", "other", null]
        },
        kind: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } },
        source_references: { type: "array", items: { type: "object" } },
        valid_from: { type: ["number", "null"] },
        valid_until: { type: ["number", "null"] },
        confidence_score: { type: ["number", "null"] },
        utility_score: { type: ["number", "null"] }
      }
    }
  },
  {
    name: "orgbrain_memory_revise",
    description: "Revise a local memory while retaining immutable version history.",
    inputSchema: {
      type: "object",
      required: ["memory_id"],
      properties: {
        memory_id: { type: "string" },
        tenant_id: { type: "string" },
        content: { type: "string" },
        summary: { type: ["string", "null"] },
        tags: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "orgbrain_memory_suppress",
    description: "Suppress a local memory without destroying its version history.",
    inputSchema: {
      type: "object",
      required: ["memory_id", "reason"],
      properties: {
        memory_id: { type: "string" },
        reason: { type: "string" },
        tenant_id: { type: "string" }
      }
    }
  },
  {
    name: "orgbrain_memory_delete",
    description: "Permanently delete a local memory and all retrieval projections.",
    inputSchema: {
      type: "object",
      required: ["memory_id"],
      properties: {
        memory_id: { type: "string" },
        tenant_id: { type: "string" }
      }
    }
  }
];

export async function callMemoryCapture(store, name, input, toolProfile = "default") {
  const tenantId = input.tenant_id || "default";
  if (name === "orgbrain_memories_confirmation_status") return store.mcpConfirmationStatus({token:boundedString(input.confirmation_token,64),tenant_id:tenantId});
  if (name === "orgbrain_memories_propose") return proposeLocalMemory(store, input);
  if (name === "orgbrain_memories_confirm") return confirmLocalMemory(store, input);
  if (name === "orgbrain_memory_observe") {
    if (input.use_observation) return receiveLocalUseObservation(store, tenantId, input.use_observation);
    const observe = input.schema_version === 2
      ? observeMemoryContractV2Event
      : observeMemoryLearningEvent;
    // tenant_id is transport scope (already resolved as tenantId above), not
    // part of the strict learning-event body.
    const { tenant_id: _transportTenantId, ...learningInput } = input;
    return observe(learningInput, {
      workspaceRoot: process.cwd(),
      sensitivePolicy: { mode: "deny", allowed_principals: [] }
    });
  }
  if (name === "orgbrain_learning_batch_ingest") {
    const expectedPromptHash = MEMORY_CONTRACT_V2_PROMPT_HASH;
    const expectedContractHash = MEMORY_CONTRACT_V2_CONTRACT_HASH;
    if (
      (input.prompt_contract_id && input.prompt_contract_id !== MEMORY_CONTRACT_V2_PROMPT_ID) ||
      (input.prompt_hash && input.prompt_hash !== expectedPromptHash) ||
      (input.contract_hash && input.contract_hash !== MEMORY_CONTRACT_V2_CONTRACT_HASH) ||
      (input.verifier_version && input.verifier_version !== MEMORY_CONTRACT_V2_VERIFIER_VERSION)
    ) throw new Error("memory contract prompt or verifier hash does not match the deployed contract");
    const commitmentStore = new TaskCommitmentStore(store.dbPath);
    const commitments = [];
    for (const commitment of (input.commitments ?? []).slice(0, 16)) {
      commitments.push(await commitmentStore.upsert({
        ...commitment,
        tenant_id: tenantId,
        project_id: input.project_id ?? commitment.project_id ?? null
      }));
    }
    const semanticAliases = [];
    for (const alias of (input.semantic_aliases ?? []).slice(0, 16)) {
      const saved = await commitmentStore.saveSemanticAlias({
        tenantId,
        projectId: input.project_id ?? alias.project_id ?? null,
        taskKey: alias.task_key,
        decisionKey: alias.decision_key,
        question: alias.question,
        judgeConsensus: alias.judge_consensus,
        certification: alias.ai_certification
      });
      if (!saved.saved) throw new Error(saved.reason ?? "semantic_alias_not_saved");
      semanticAliases.push(saved);
    }
    const candidateInputs = [...(input.review_candidates ?? []), ...(input.quarantine_candidates ?? [])]
      .filter((candidate, index, all) => {
        const key = String(candidate.external_key ?? `candidate-${index}`);
        return all.findIndex((other) => String(other.external_key ?? "") === key) === index;
      });
    const reviewCandidates = await commitmentStore.saveLearningCandidates({
      tenantId,
      projectId: input.project_id ?? null,
      taskKey: input.task_key ?? null,
      autoSaveClassified: classifiedAutoSaveEnabled(),
      candidates: [
        ...candidateInputs,
        ...(input.deterministically_verified_items ?? []).slice(0, 3).map((item, index) => ({
          external_key: item.external_key ?? `learning-deterministic-review:${index}`,
          item,
          observation: item.learning ?? null,
          verification: item.verification ?? null,
          evidence: item.evidence ?? [],
          reason_codes: ["ai_consensus_pending"],
          capture_intent: "verify",
          created_at: item.created_at ?? Date.now(),
          expires_at: item.expires_at ?? item.valid_until ?? Date.now() + 180 * 24 * 60 * 60 * 1000
        }))
      ].slice(0, 3).map((candidate) => ({
        ...candidate,
        prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
        prompt_hash: expectedPromptHash,
        contract_hash: expectedContractHash,
        verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION
      }))
    });
    const verifiedResults = [];
    for (const originalItem of (input.verified_items ?? []).slice(0, 3)) {
      const item = originalItem?.learning && typeof originalItem.learning === "object"
        ? {
          ...originalItem,
          learning: {
            ...originalItem.learning,
            contract_metadata: {
              ...(originalItem.learning.contract_metadata && typeof originalItem.learning.contract_metadata === "object"
                ? originalItem.learning.contract_metadata
                : {}),
              prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
              prompt_hash: expectedPromptHash,
              contract_hash: expectedContractHash,
              verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
              producer_agent: input.source ?? "local",
              producer_model: null
            }
          }
        }
        : originalItem;
      if (!isAiConsensusCertified(item)) throw new Error("verified_items require unanimous ai_consensus_certified judges");
      if (item?.verification?.state !== "verified" || !Array.isArray(item?.evidence) || item.evidence.length === 0) {
        throw new Error("verified_items must contain deterministic verification state and evidence");
      }
      const backing = await commitmentStore.assertCandidateBacked({
        tenantId,
        projectId: input.project_id ?? item.project_id ?? null,
        item
      });
      if (!backing.ok) throw new Error(backing.reason);
      if (item?.learning?.schema_version !== 2) {
        throw new Error("verified_items must use LearningObservationV2; legacy observations remain review-only");
      }
      if (item.learning.capture_intent !== "verify") {
        throw new Error("verified_items must contain only verify observations");
      }
      if (item.learning.lesson_type === "decision" && ["user_choice", "preference"].includes(item.learning.decision_type)) {
        throw new Error("verified_items user choices and preferences must be stored as task commitments");
      }
      verifiedResults.push(await store.capture(captureDefaults({
        ...item,
        tenant_id: tenantId,
        project_id: input.project_id ?? item.project_id ?? null,
        source: item.source ?? input.source ?? "local-learning-contract",
        capture_origin: item.capture_origin ?? "observed",
        verification_state: item.verification_state ?? "verified",
        verified_at: item.verified_at ?? item.verification?.verified_at ?? Date.now()
      })));
    }
    return {
      ok: true,
      verified_inserted: verifiedResults.filter((result) => result?.created).length,
      auto_saved: reviewCandidates.filter(item => item.status === 'active').length,
      review_inserted: reviewCandidates.filter(item => item.status === 'quarantine').length,
      quarantine_inserted: reviewCandidates.filter(item => item.status === 'quarantine').length,
      commitments: commitments.map((result) => result.commitment),
      semantic_aliases: semanticAliases,
      review_candidates: reviewCandidates,
      quarantine_candidates: reviewCandidates
    };
  }
  if (name === "orgbrain_memory_capture") {
    if (input.target_tenant_id === undefined) return store.capture(captureDefaults(input));
    if (input.target_tenant_id !== "all") throw new Error("target_tenant_id_must_be_all");
    return store.capture(captureDefaults({ ...input, tenant_id: "all", project_id: null, scope_type: "tenant", scope_key: "all" }));
  }
  if (name === "orgbrain_memory_revise") {
    const { memory_id: memoryId, tenant_id: _tenant, ...revision } = input;
    return store.revise(tenantId, memoryId, revision);
  }
  if (name === "orgbrain_memory_suppress") {
    return store.suppress(tenantId, input.memory_id, input.reason, {
      actor_type: "principal",
      actor_id: process.env.USER || "local-user"
    });
  }
  if (name === "orgbrain_memory_delete") {
    return store.delete(tenantId, input.memory_id, {
      actor_type: "principal",
      actor_id: process.env.USER || "local-user"
    });
  }
  throw new Error(`unknown tool: ${name}`);
}

function rationaleProposal(item) {
  const sentences = item.content.split(/(?<=[。.!?])\s+|\n+/u).map((value) => value.trim()).filter(Boolean);
  const reason = sentences.find((sentence) => /^(?:理由|原因)\s*[:：]/u.test(sentence))
    ?? sentences.find((sentence) => /(?:理由|原因|because|root cause)/iu.test(sentence))
    ?? sentences.slice(0, 3).join(" ");
  return {
    decision_type: /(?:原則|必ず|使わず|毎回|再利用せず)/u.test(item.content) ? "policy" : "workaround",
    conclusion: boundedString(item.summary, 240) ?? boundedString(sentences[0], 240, "No conclusion extracted"),
    reason_summary: boundedString(reason?.replace(/^(?:理由|原因)\s*[:：]\s*/u, ""), 500, item.content),
    status: "accepted",
    confidence_score: 0.55
  };
}

function normalizedEntities(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((entity) => {
    const name = boundedString(entity?.name, 128);
    return name ? [{
      name,
      entity_type: boundedString(entity?.entity_type, 32, "unknown"),
      role: boundedString(entity?.role, 32, "subject"),
      confidence_score: Number.isFinite(entity?.confidence_score) ? entity.confidence_score : null,
      external_ref: boundedString(entity?.external_ref, 256)
    }] : [];
  });
}

function normalizedEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((entry) => {
    const reference = boundedString(entry?.evidence_ref, 512);
    return reference ? [{
      evidence_type: boundedString(entry?.evidence_type, 32, "external"),
      evidence_ref: reference,
      relation: boundedString(entry?.relation, 32, "supports"),
      note: boundedString(entry?.note, 500),
      weight_score: Number.isFinite(entry?.weight_score) ? entry.weight_score : null
    }] : [];
  });
}

export async function proposeLocalMemory(store, input, { pinnedSourceReview = false } = {}) {
  if (!input?.item || typeof input.item !== "object") throw new Error("item_required");
  if (!pinnedSourceReview && boundedString(input.source, 64) === "task-closeout-lesson") {
    throw new Error("task_lesson_requires_scoped_proposal");
  }
  const tenantId = boundedString(input.tenant_id, 128, "default");
  const item = {
    external_key: boundedString(input.item.external_key, 256),
    content: screenInteractiveProse(input.item.content, "item.content"),
    summary: input.item.summary == null ? null : screenInteractiveProse(input.item.summary, "item.summary").slice(0, 1000),
    tags: Array.isArray(input.item.tags)
      ? [...new Set(input.item.tags.map((tag) => boundedString(tag, 64)).filter(Boolean))].slice(0, 16)
      : [],
    created_at: Number.isInteger(input.item.created_at) ? input.item.created_at : Date.now(),
    project_id: boundedString(input.item.project_id, 128),
    business_category_id: boundedString(input.item.business_category_id, 128),
    work_type: boundedString(input.item.work_type, 32)
  };
  const reviewContext=localReviewContext(input.review_context);
  const proposedRationale = rationaleProposal(item);
  if(reviewContext) {
    proposedRationale.conclusion=reviewContext.conclusion??item.summary??item.content;
    proposedRationale.reason_summary=reviewContext.reason_summary??'未確認';
    item.content=[proposedRationale.conclusion,`理由: ${proposedRationale.reason_summary}`,`再利用条件: ${reviewContext.reuse_rule??'未確認'}`].join('\n');
    item.summary=proposedRationale.conclusion.slice(0,1000);
    item.external_key=item.external_key||`review:${reviewContext.candidate_id}`;
  }
  const now = Date.now();
  const token = randomUUID();
  const payload = {
    tenant_id: tenantId,
    source: boundedString(input.source, 64, "local-mcp"),
    actor_type: boundedString(input.actor_type, 64, "principal"),
    actor_id: boundedString(input.actor_id, 128, process.env.USER || "local-user"),
    review_context:reviewContext,
    ...(pinnedSourceReview ? { pinned_source_review: true } : {}),
    proposed_memory: item,
    proposed_rationale: proposedRationale,
    proposed_entities: normalizedEntities(input.entities),
    proposed_evidence: normalizedEvidence(input.evidence),
    expires_at: now + LOCAL_CONFIRMATION_TTL_MS
  };
  await store.saveMcpConfirmation({
    token,
    tenant_id: tenantId,
    payload,
    created_at: now,
    expires_at: payload.expires_at
  });
  return {
    tenant_id: tenantId,
    source: payload.source,
    confirmation_token: token,
    candidate_id:reviewContext?.candidate_id??null,
    proposed_memory: item,
    proposed_rationale: { ...proposedRationale, confirmation_state: "inferred_unconfirmed" },
    proposed_entities: payload.proposed_entities,
    proposed_evidence: payload.proposed_evidence
  };
}

async function confirmLocalMemory(store, input) {
  const tenantId = boundedString(input?.tenant_id, 128, "default");
  const token = boundedString(input?.confirmation_token, 64);
  if (!token) throw new Error("confirmation_token_required");
  let rationaleId = null;
  let confirmationState = null;
  let reviewLabel=null;
  const answer=input.review_answer==null?null:screenInteractiveProse(input.review_answer,'review_answer');
  const selectedCategory=memoryCategoryFromReviewAnswer(answer);
  const consumed = await store.consumeMcpConfirmation({
    token,
    tenant_id: tenantId,
    approved: input.approved,
    requestHash:await useHash({...input,tenant_id:tenantId}),
    validateConfirmation(payload) {
      if(typeof input.approved!=='boolean') throw new Error('confirmation_approval_required');
      if(answer&&answer.length>2000) throw new Error('invalid_review_answer');
      const answerLabel=answer===null?null:classifyMemoryReviewAnswer(answer);
      const modified=Boolean(input.corrected_content||input.corrected_summary
        ||input.conclusion&&input.conclusion!==payload.proposed_rationale.conclusion
        ||input.reason_summary&&input.reason_summary!==payload.proposed_rationale.reason_summary
        ||input.decision_type&&input.decision_type!==payload.proposed_rationale.decision_type
        ||input.reuse_rule!=null&&input.reuse_rule!==payload.review_context?.reuse_rule
        ||input.entities?.length||input.evidence?.length);
      reviewLabel=input.review_label??answerLabel??(input.approved?(modified?'corrected':'accepted'):'not_needed');
      if(!MEMORY_REVIEW_LABELS.includes(reviewLabel)||input.review_label&&answerLabel&&input.review_label!==answerLabel) throw new Error('review_label_mismatch');
      if(payload.review_context&&!answer) throw new Error('review_answer_required');
      if(payload.pinned_source_review&&input.approved&&(modified||reviewLabel==='corrected')) throw new Error('pinned_source_review_requires_new_proposal');
      if(input.approved&&!['accepted','corrected'].includes(reviewLabel)||!input.approved&&['accepted','corrected'].includes(reviewLabel)) throw new Error('review_not_approved');
      if(input.approved&&answerLabel&&!['accepted','corrected'].includes(answerLabel)) throw new Error('review_not_approved');
      if(payload.review_context&&input.approved&&modified&&answerLabel!=='corrected') throw new Error('correction_not_approved');
      if(payload.review_context&&input.approved&&reviewLabel==='corrected'&&!input.corrected_content) throw new Error('corrected_content_required');
    },
    buildReceipt(payload,saved) {
      return {tenant_id:tenantId,approved:input.approved,saved:input.approved===true,
        ...(saved?{memory_id:saved.memory_id,memory_version:saved.version,deduplicated:saved.deduplicated===true,rationale_id:rationaleId,confirmation_state:confirmationState}:{}),
        candidate_id:payload.review_context?.candidate_id??null,review_label:reviewLabel,review_answer:answer??'',
        memory_category:selectedCategory};
    },
    buildCaptureInput(payload) {
      // Validate the supplied prose before the persisted rationale bounds.
      for (const field of ['conclusion', 'reason_summary']) {
        if (input[field] != null) screenInteractiveProse(input[field], field);
      }
      const conclusion = boundedString(input.conclusion || input.corrected_summary || input.corrected_content, 240, payload.proposed_rationale.conclusion);
      const reason = boundedString(input.reason_summary, 500, payload.proposed_rationale.reason_summary);
      screenInteractiveProse(conclusion, "conclusion");
      screenInteractiveProse(reason, "reason_summary");
      const corrected = Boolean(input.corrected_content || input.corrected_summary) || conclusion !== payload.proposed_rationale.conclusion ||
        reason !== payload.proposed_rationale.reason_summary ||
        (input.decision_type && input.decision_type !== payload.proposed_rationale.decision_type) ||
        (Array.isArray(input.entities) && input.entities.length > 0) ||
        (Array.isArray(input.evidence) && input.evidence.length > 0);
      const entities = Array.isArray(input.entities) && input.entities.length > 0
        ? normalizedEntities(input.entities)
        : payload.proposed_entities;
      const evidence = Array.isArray(input.evidence) && input.evidence.length > 0
        ? normalizedEvidence(input.evidence)
        : payload.proposed_evidence;
      rationaleId = randomUUID();
      confirmationState = corrected ? "user_corrected" : "user_confirmed";
      return captureDefaults({
        ...payload.proposed_memory,
        tenant_id: tenantId,
        source: payload.source,
        source_references:payload.review_context?.source_references??[],
        actor_type: payload.actor_type,
        actor_id: payload.actor_id,
        kind: "semantic",
        // A pinned document proves provenance, not execution or the applicant's rationale.
        ...(payload.pinned_source_review ? { verification_state: "partial" } : {}),
        tags: withMemoryCategoryTags(payload.proposed_memory.tags, selectedCategory),
        content: input.corrected_content ? screenInteractiveProse(input.corrected_content, "corrected_content") : corrected ? `${conclusion}\n理由: ${reason}` : payload.proposed_memory.content,
        summary: input.corrected_summary ? screenInteractiveProse(input.corrected_summary, "corrected_summary") : conclusion,
        rationale: reason,
        reuse_rule:input.reuse_rule!=null?screenInteractiveProse(input.reuse_rule,'reuse_rule')
          :input.corrected_content?null:payload.review_context?.reuse_rule??null,
        entities: entities.map((entity) => entity.name),
        evidence: [...evidence, {
          evidence_type: "memory",
          evidence_ref: `local-rationale:${rationaleId}`,
          relation: "context_for",
          confirmation_state: confirmationState
        }]
      });
    }
  });
  return consumed.receipt;
}

function captureDefaults(input) {
  const tenantId = input.tenant_id || "default";
  const projectId = input.project_id || null;
  return {
    tenant_id: tenantId,
    project_id: projectId,
    kind: "episodic",
    lifecycle_state: "active",
    scope_type: projectId ? "project" : "tenant",
    scope_key: projectId || tenantId,
    content: "",
    summary: null,
    tags: [],
    entities: [],
    source: "local-mcp",
    source_references: [],
    external_key: null,
    actor_type: "principal",
    actor_id: process.env.USER || "local-user",
    valid_from: null,
    valid_until: null,
    confidence_score: null,
    utility_score: null,
    rationale: null,
    evidence: [],
    conflicts: [],
    permissions: [],
    ...input
  };
}

