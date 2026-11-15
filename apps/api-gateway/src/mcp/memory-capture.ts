import { receiveCloudUseObservation } from "../memory-use-observation-service";
import { HttpError, sha256, validateMemoryContractV2Event, observeMemoryContractV2Event, observeMemoryLearningEvent } from "@org-brain/shared";
import { z } from "zod";
import { refreshMemoryByRequest, suppressMemoryByRequest, upsertMemories } from "../memory-service";
import { allTenantPayload } from "../all-tenant-search";
import { captureMemoryWithInferredRationale, confirmProposedMemory, getMemoryConfirmationStatus, proposeMemoryWithRationale, getMemoryConfirmationProject, cancelMemoryConfirmation } from "../rationale-service";
import { extractMemoryCandidates } from "../memory-extraction-service";
import { stageConversationMemories } from "../conversation-memory-service";
import { ingestVerifiedKnowledgeBundle } from "../verified-ingestion-service";
import { enqueueMemoryExtraction } from "../memory-extraction-enqueue-service";
import { getTaskCommitmentContext, ingestLearningContractBatch } from "../memory-contract-service";
import type { OrgBrainMcpTools } from "../mcp";
import { toContent, registerTool, normalizeTenant, workTypeSchema } from "./common";

export function registerMemoryCapture(tools: OrgBrainMcpTools) {
  const captureEvidenceSchema = z.object({
      evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"]).optional(),
      evidence_ref: z.string().min(1).max(512),
      relation: z.enum(["supports", "contradicts", "context_for"]).optional(),
      note: z.string().max(500).nullable().optional(),
      weight_score: z.number().min(0).max(1).optional(),
      content_hash: z.string().max(128).nullable().optional(),
      diff_hash: z.string().max(128).nullable().optional(),
      observed_at: z.number().int().nullable().optional(),
      attestation_ref: z.string().max(512).nullable().optional()
    });

  const captureRationaleItemSchema = z.object({
      external_key: z.string().min(1).max(256),
      content: z.string().min(1).max(20000),
      summary: z.string().max(1000).optional(),
      tags: z.array(z.string().min(1).max(64)).max(16).optional(),
      created_at: z.number().int().optional(),
      project_id: z.string().max(128).nullable().optional(),
      business_category_id: z.string().max(128).nullable().optional(),
      work_type: workTypeSchema.nullable().optional(),
      canonical_key: z.string().min(1).max(256).nullable().optional(),
      kind: z.enum(["decision", "constraint", "pitfall", "preference", "fact"]).optional(),
      rationale: z.string().max(4000).nullable().optional(),
      reuse_rule: z.string().max(1000).nullable().optional(),
      evidence: z.array(captureEvidenceSchema).max(8).optional(),
      source_references: z.array(z.object({
        type: z.string().min(1).max(80),
        ref: z.string().min(1).max(512),
        title: z.string().max(240).optional(),
        captured_at: z.number().int().optional()
      })).max(32).optional(),
      source_refs: z.array(z.object({
        type: z.string().min(1).max(80),
        ref: z.string().min(1).max(512),
        title: z.string().max(240).optional(),
        captured_at: z.number().int().optional()
      })).max(32).optional(),
      valid_until: z.number().int().nullable().optional(),
      confidence_score: z.number().min(0).max(1).nullable().optional(),
      utility_score: z.number().min(0).max(1).nullable().optional(),
      visibility: z.enum(["tenant", "project", "restricted"]).optional(),
      allowed_principals: z.array(z.string().min(1).max(128)).max(64).optional()
      , capture_origin: z.enum(["observed", "synthetic", "repair", "legacy"]).optional()
      , capture_route: z.enum(["realtime_hook", "initial_import", "manual", "repair", "legacy"]).optional()
      , capture_batch_id: z.string().max(128).nullable().optional()
      , verification: z.object({
        state: z.enum(["verified", "partial", "unverified", "rejected"]).optional(),
        verified_at: z.number().int().nullable().optional(),
        attestation_ref: z.string().max(512).nullable().optional()
      }).optional()
      , learning: z.record(z.string(), z.unknown()).nullable().optional()
      , quality_dimensions: z.record(z.string(), z.number().min(0).max(100)).nullable().optional()
    });

  const learningEventShape = {
      use_observation: z.record(z.string(), z.unknown()).optional(),
      schema_version: z.union([z.literal(1), z.literal(2)]),
      lesson_type: z.enum(["success", "decision", "failure"]),
      kind: z.enum(["decision", "constraint", "pitfall", "preference", "fact"]).optional(),
      trigger: z.string().max(1000).nullable().optional(),
      conclusion: z.string().max(1000).nullable().optional(),
      rationale: z.string().max(2000).nullable().optional(),
      reuse_rule: z.string().max(1000).nullable().optional(),
      outcome: z.string().max(1000).nullable().optional(),
      applicability: z.object({
        target_files: z.array(z.string().min(1).max(512)).max(16),
        components: z.array(z.string().min(1).max(128)).max(16)
      }).optional(),
      evidence_selectors: z.array(z.object({
        type: z.enum(["command", "file", "doc", "user_statement", "tool_result"]),
        ref: z.string().max(1000).optional(),
        digest: z.string().max(128).optional(),
        supports: z.array(z.string().max(128)).max(12).optional()
      })).max(16).optional(),
      gaps: z.array(z.string().min(1).max(500)).max(16).optional(),
      record_type: z.literal("learning_observation").optional(),
      capture_intent: z.enum(["verify", "review"]).optional(),
      procedure: z.string().max(2000).nullable().optional(),
      why_it_worked: z.string().max(2000).nullable().optional(),
      observed_outcome: z.string().max(1000).nullable().optional(),
      reuse_when: z.string().max(1000).nullable().optional(),
      decision_type: z.enum(["user_choice", "preference", "implementation", "governance"]).optional(),
      decision_key: z.string().max(160).nullable().optional(),
      question: z.string().max(1000).nullable().optional(),
      selected_value: z.string().max(1000).nullable().optional(),
      decision: z.string().max(1000).nullable().optional(),
      constraints: z.array(z.string().max(500)).max(16).optional(),
      alternatives: z.array(z.union([
        z.string().min(1).max(1000),
        z.object({
          alternative: z.string().max(1000),
          reason_rejected: z.string().max(1000).nullable().optional()
        })
      ])).max(16).optional(),
      symptom: z.string().max(1000).nullable().optional(),
      failed_approach: z.string().max(1500).nullable().optional(),
      root_cause: z.string().max(2000).nullable().optional(),
      correction: z.string().max(2000).nullable().optional(),
      verified_outcome: z.string().max(1000).nullable().optional(),
      avoidance_rule: z.string().max(1000).nullable().optional()
    };

  registerTool(tools.server,
      "orgbrain_memory_observe",
      learningEventShape,
      async (event) => {
        if (event.use_observation) return toContent(await receiveCloudUseObservation(tools.env, tools.props.tenantId,
          tools.props.principal, event.use_observation, tools.props.defaultRole));
        if (event.schema_version === 2 && !validateMemoryContractV2Event(event)) {
          throw new HttpError(400, "memory_contract_schema_invalid", "memory contract v2 observation does not match the shared schema");
        }
        return toContent(await (event.schema_version === 2
          ? observeMemoryContractV2Event(event, { sensitivePolicy: { mode: "deny", allowed_principals: [] } })
          : observeMemoryLearningEvent(event, { sensitivePolicy: { mode: "deny", allowed_principals: [] } })));
      }, "write"
    );

  registerTool(tools.server,
      "orgbrain_task_context_get",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional(),
        task_key: z.string().min(1).max(256),
        query: z.string().max(1000).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "read", payload.project_id);
        return toContent(await getTaskCommitmentContext(tools.env, { tenant_id: tenantId, ...payload }));
      }, "read"
    );

  const taskCommitmentInput = z.object({
      record_type: z.literal("task_commitment").optional(),
      schema_version: z.literal(1).optional(),
      project_id: z.string().max(128).nullable().optional(),
      task_key: z.string().min(1).max(256),
      decision_key: z.string().min(1).max(160),
      question_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/iu),
      question: z.string().min(1).max(1000),
      answer: z.object({
        option_id: z.string().max(160).nullable().optional(),
        label: z.string().min(1).max(500),
        raw: z.string().max(500).nullable().optional()
      }),
      authority: z.literal("explicit_user").optional(),
      confirmation_state: z.enum(["user_confirmed", "user_corrected"]).optional(),
      ask_policy: z.literal("reuse_until_superseded").optional(),
      evidence: z.object({
        type: z.literal("request_user_input_result"),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/iu)
      }),
      created_at: z.number().int().optional(),
      expires_at: z.number().int().nullable().optional()
    });

  registerTool(tools.server,
      "orgbrain_learning_batch_ingest",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().max(128).nullable().optional(),
        task_key: z.string().max(256).nullable().optional(),
        source: z.string().max(64).optional(),
        prompt_contract_id: z.string().max(128).optional(),
        prompt_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/iu).optional(),
        contract_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/iu).optional(),
        verifier_version: z.string().max(128).optional(),
        commitments: z.array(taskCommitmentInput).max(16).optional(),
        verified_items: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
        deterministically_verified_items: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
        review_candidates: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
        quarantine_candidates: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
        semantic_aliases: z.array(z.object({
          project_id: z.string().max(128).nullable().optional(),
          task_key: z.string().min(1).max(256),
          decision_key: z.string().min(1).max(160),
          question: z.string().min(1).max(1000),
          ai_certification: z.literal("ai_consensus_certified"),
          judge_consensus: z.record(z.string(), z.unknown())
        })).max(16).optional()
      },
      async ({ tenant_id, commitments, verified_items, deterministically_verified_items, review_candidates, quarantine_candidates, semantic_aliases, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", payload.project_id);
        if ((verified_items ?? []).length > 0) await tools.requirePermission(tenantId, "memory:attest", payload.project_id);
        return toContent(await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_learning_batch_ingest",
          "memory_learning_contract",
          () => ingestLearningContractBatch(tools.env, {
            tenant_id: tenantId,
            commitments,
            verified_items,
            deterministically_verified_items,
            review_candidates,
            quarantine_candidates,
            semantic_aliases,
            ...payload
          }, { tenantId, principal: tools.props.principal })
        ));
      }, "write"
    );

  registerTool(tools.server,
      "orgbrain_memory_extraction_enqueue",
      {
        tenant_id: z.string().optional(),
        project_id: z.string().min(1).max(128),
        provider: z.enum(["openai", "gemini", "anthropic"]),
        model: z.string().min(1).max(128),
        session_hash: z.string().min(1).max(128),
        turn_hash: z.string().min(1).max(128),
        packet: z.record(z.string(), z.unknown()),
        packet_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
        tier: z.literal("tier2").optional(),
        retention_class: z.enum(["standard", "restricted"]).optional(),
        schema_version: z.string().max(128).optional(),
        prompt_version: z.string().max(128).optional(),
        redaction_version: z.string().max(128).optional(),
        prefilter_version: z.string().max(128).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        if (!tools.props.clientInstallationId || tools.props.clientPurpose !== "capture") {
          throw new HttpError(403, "forbidden", "memory extraction enqueue requires the calling capture installation");
        }
        await tools.requirePermission(tenantId, "write", payload.project_id);
        return toContent(await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_extraction_enqueue",
          "memory_extraction_run",
          () => enqueueMemoryExtraction(tools.env, payload, {
            tenantId,
            principal: tools.props.principal,
            installationId: tools.props.clientInstallationId!
          })
        ));
      }, "write"
    );

  registerTool(tools.server,
      "orgbrain_memory_commit_verified",
      {
        tenant_id: z.string().optional(),
        bundle: z.record(z.string(), z.unknown())
      },
      async ({ tenant_id, bundle }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        const projectId = typeof bundle.project_id === "string" ? bundle.project_id : null;
        await tools.requirePermission(tenantId, "write", projectId);
        await tools.requirePermission(tenantId, "memory:attest", projectId);
        return toContent(await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memory_commit_verified",
          "verified_ingestion_manifest",
          () => ingestVerifiedKnowledgeBundle(tools.env, tenantId, bundle, tools.props.principal, {
            publishAuthorized: true,
            allowShadow: false
          })
        ));
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_memories_extract",
      {
        tenant_id: z.string().optional(),
        event_id: z.string().min(1).max(128),
        project_id: z.string().max(128).nullable().optional(),
        source: z.string().min(1).max(64),
        occurred_at: z.number().int(),
        text: z.string().min(1).max(100_000),
        source_references: z.array(z.object({
          type: z.string().min(1).max(64),
          ref: z.string().min(1).max(512),
          title: z.string().max(240).optional(),
          captured_at: z.number().int().optional()
        })).max(32).optional()
      },
      async ({ tenant_id, ...event }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", event.project_id);
        return toContent(await extractMemoryCandidates(tools.env, {
          ...event,
          tenant_id: tenantId,
          actor_type: "principal",
          actor_id: tools.props?.principal ?? "mcp"
        }));
      }, "write"
    );

  registerTool(tools.server,
      "orgbrain_conversation_memories_stage",
      {
        tenant_id: z.string().optional(),
        conversation: z.record(z.string(), z.unknown()),
        execute: z.boolean().optional(),
        expected_plan_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional()
      },
      async ({ tenant_id, conversation, execute, expected_plan_hash }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        const projectId = typeof conversation.project_id === "string" ? conversation.project_id : null;
        await tools.requirePermission(tenantId, "write", projectId);
        return toContent(await tools.auditedMutation(tenantId, "mcp.orgbrain_conversation_memories_stage", "memory_confirmation",
          () => stageConversationMemories(tools.env, tenantId, conversation, {
            principal: tools.props.principal, fallbackRole: tools.props.defaultRole,
            execute, expectedPlanHash: expected_plan_hash
          })));
      }, "write"
    );

  registerTool(tools.server, "orgbrain_conversation_memories_revise", {
      tenant_id: z.string().optional(), confirmation_token: z.string().min(1).max(64),
      expected_candidate_hash: z.string().regex(/^[a-f0-9]{64}$/u), expected_revision: z.number().int().min(1),
      conversation: z.record(z.string(), z.unknown()), execute: z.boolean().optional(),
      expected_plan_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional()
    }, async ({ tenant_id, confirmation_token, expected_candidate_hash, expected_revision, conversation, execute, expected_plan_hash }) => {
      const tenantId = normalizeTenant(tenant_id, tools.props);
      const projectId = await getMemoryConfirmationProject(tools.env,tenantId,confirmation_token,tools.props.principal);
      await tools.requirePermission(tenantId,"write",projectId);
      return toContent(await tools.auditedMutation(tenantId,"mcp.orgbrain_conversation_memories_revise","memory_confirmation", () =>
        stageConversationMemories(tools.env,tenantId,conversation,{ principal: tools.props.principal, fallbackRole: tools.props.defaultRole,
          execute, expectedPlanHash: expected_plan_hash, revisionOf: { confirmationToken: confirmation_token, expectedCandidateHash: expected_candidate_hash, expectedRevision: expected_revision } })));
    }, "write");

  registerTool(tools.server, "orgbrain_memories_confirmation_cancel", {
      tenant_id: z.string().optional(), confirmation_token: z.string().min(1).max(64),
      expected_candidate_hash: z.string().regex(/^[a-f0-9]{64}$/u), expected_revision: z.number().int().min(1), reason: z.string().min(1).max(500)
    }, async ({ tenant_id, ...input }) => {
      const tenantId = normalizeTenant(tenant_id,tools.props);
      const projectId = await getMemoryConfirmationProject(tools.env,tenantId,input.confirmation_token,tools.props.principal);
      await tools.requirePermission(tenantId,"write",projectId);
      return toContent(await tools.auditedMutation(tenantId,"mcp.orgbrain_memories_confirmation_cancel","memory_confirmation", () => cancelMemoryConfirmation(tools.env,tenantId,input,tools.props.principal,tools.props.defaultRole)));
    }, "write");

  registerTool(tools.server,
      "orgbrain_memories_propose",
      {
        tenant_id: z.string().optional(),
        source: z.string().optional(),
        actor_type: z.string().optional(),
        actor_id: z.string().optional(),
        review_context: z.object({
          candidate_id: z.string().min(1).max(128), candidate_hash: z.string().regex(/^[a-f0-9]{64}$/),
          source_references: z.array(z.record(z.string(), z.unknown())).max(8),
          conclusion: z.string().max(2000).optional(), reason_summary: z.string().max(2000).optional(), reuse_rule: z.string().max(2000).optional()
        }).optional(),
        item: z.object({
          external_key: z.string().max(256).optional(),
          content: z.string().min(1).max(20000),
          summary: z.string().max(1000).optional(),
          tags: z.array(z.string().min(1).max(64)).max(16).optional(),
          created_at: z.number().int().optional(),
          project_id: z.string().max(128).nullable().optional(),
          business_category_id: z.string().max(128).nullable().optional(),
          work_type: workTypeSchema.nullable().optional()
        }),
        entities: z.array(z.object({
          name: z.string().min(1).max(128),
          entity_type: z.enum(["person", "service", "project", "team", "org", "document", "unknown"]).optional(),
          role: z.enum(["subject", "author", "decision_maker", "reviewer", "mentioned"]).optional(),
          confidence_score: z.number().optional(),
          external_ref: z.string().max(256).nullable().optional()
        })).max(8).optional(),
        evidence: z.array(z.object({
          evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"]).optional(),
          evidence_ref: z.string().min(1).max(512),
          relation: z.enum(["supports", "contradicts", "context_for"]).optional(),
          note: z.string().max(500).nullable().optional(),
          weight_score: z.number().optional()
        })).max(8).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write", payload.item.project_id);
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_propose",
          "memory",
          () => proposeMemoryWithRationale(tools.env, { tenant_id: tenantId, ...payload, actor_type: "principal", actor_id: tools.props.principal })
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server,
      "orgbrain_memories_capture_rationale",
      {
        tenant_id: z.string().optional(),
        source: z.string().min(1).max(64).optional(),
        item: captureRationaleItemSchema.optional(),
        items: z.array(captureRationaleItemSchema).min(1).max(3).optional()
      },
      async ({ tenant_id, source, item, items }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        if (Boolean(item) === Boolean(items)) {
          throw new HttpError(400, "invalid_payload", "exactly one of item or items is required");
        }
        const captureItems = items ?? (item ? [item] : []);
        for (const projectId of new Set(captureItems.map((entry) => entry.project_id ?? null))) {
          await tools.requirePermission(tenantId, "write", projectId);
          if (captureItems.some((entry) => entry.project_id === projectId && entry.verification?.state === "verified")) {
            await tools.requirePermission(tenantId, "memory:attest", projectId);
          }
        }
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_capture_rationale",
          "memory",
          () => captureMemoryWithInferredRationale(tools.env, {
            tenant_id: tenantId,
            source: source?.trim() || "hook",
            actor_type: "principal",
            actor_id: tools.props.principal,
            ...(item ? { item } : { items })
          }, { canAttest: captureItems.some((entry) => entry.verification?.state === "verified") })
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_memories_confirm",
      {
        tenant_id: z.string().optional(),
        confirmation_token: z.string().min(1).max(64),
        expected_candidate_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
        expected_revision: z.number().int().min(1).optional(),
        approved: z.boolean(),
        corrected_content: z.string().min(1).max(20000).optional(),
        corrected_summary: z.string().min(1).max(1000).optional(),
        review_label: z.enum(["accepted", "corrected", "not_needed", "incorrect", "not_decided", "deferred", "unknown"]).optional(),
        review_answer: z.string().min(1).max(2000).optional(),
        conclusion: z.string().max(240).optional(),
        reason_summary: z.string().max(500).optional(),
        decision_type: z.enum(["adopt", "reject", "prioritize", "diagnose", "workaround", "policy"]).optional(),
        status: z.string().max(64).optional(),
        entities: z.array(z.object({
          name: z.string().min(1).max(128),
          entity_type: z.enum(["person", "service", "project", "team", "org", "document", "unknown"]).optional(),
          role: z.enum(["subject", "author", "decision_maker", "reviewer", "mentioned"]).optional(),
          confidence_score: z.number().optional(),
          external_ref: z.string().max(256).nullable().optional()
        })).max(8).optional(),
        evidence: z.array(z.object({
          evidence_type: z.enum(["memory", "task_event", "artifact", "doc", "file", "command", "thread", "external"]).optional(),
          evidence_ref: z.string().min(1).max(512),
          relation: z.enum(["supports", "contradicts", "context_for"]).optional(),
          note: z.string().max(500).nullable().optional(),
          weight_score: z.number().optional()
        })).max(8).optional()
      },
      async ({ tenant_id, ...payload }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        const projectId = await getMemoryConfirmationProject(tools.env, tenantId, payload.confirmation_token, tools.props.principal);
        await tools.requirePermission(tenantId, "write", projectId);
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_confirm",
          "memory",
          () => confirmProposedMemory(tools.env, { tenant_id: tenantId, ...payload }, tools.props.principal)
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server,
      "orgbrain_memories_confirmation_status",
      { tenant_id: z.string().optional(), confirmation_token: z.string().min(1).max(64) },
      async ({ tenant_id, confirmation_token }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        const projectId = await getMemoryConfirmationProject(tools.env, tenantId, confirmation_token, tools.props.principal);
        await tools.requirePermission(tenantId, "read", projectId);
        return toContent(await getMemoryConfirmationStatus(tools.env, { tenant_id: tenantId, confirmation_token }, tools.props.principal));
      }, "read"
    );

  registerTool(tools.server, 
      "orgbrain_memories_upsert",
      {
        target_tenant_id: z.literal("all").optional(),
        tenant_id: z.string().optional(),
        source: z.string().optional(),
        items: z
          .array(
            z.object({
              external_key: z.string().min(1).max(256),
              content: z.string().min(1).max(20000),
              summary: z.string().max(1000).optional(),
              tags: z.array(z.string().min(1).max(64)).max(16).optional(),
              created_at: z.number().int().optional(),
              project_id: z.string().max(128).nullable().optional(),
              business_category_id: z.string().max(128).nullable().optional(),
              work_type: workTypeSchema.nullable().optional()
            })
          )
          .min(1)
          .max(200)
      },
      async ({ tenant_id, target_tenant_id, source, items }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        for (const projectId of new Set(items.map((item) => item.project_id ?? null))) {
          await tools.requirePermission(tenantId, "write", projectId);
        }
        const payload = { tenant_id: tenantId, source: source?.trim() || "openclaw", items };
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_upsert",
          "memory",
          () => upsertMemories(tools.env,
            target_tenant_id ? allTenantPayload("memory", { ...payload, target_tenant_id }) : payload,
            { actorPrincipal: tools.props?.principal })
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_memories_refresh",
      {
        tenant_id: z.string().optional(),
        memory_id: z.string().min(1),
        confidence_delta: z.number().optional()
      },
      async ({ tenant_id, memory_id, confidence_delta }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write");
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_refresh",
          "memory",
          () => refreshMemoryByRequest(tools.env, {
            tenant_id: tenantId,
            memory_id,
            confidence_delta,
            actor_type: "principal",
            actor_id: tools.props?.principal ?? null
          }, { actorPrincipal: tools.props?.principal })
        );
        return toContent(result);
      }, "write"
    );

  registerTool(tools.server, 
      "orgbrain_memories_suppress",
      {
        tenant_id: z.string().optional(),
        memory_id: z.string().min(1),
        reason: z.string().min(1).max(500)
      },
      async ({ tenant_id, memory_id, reason }) => {
        const tenantId = normalizeTenant(tenant_id, tools.props);
        await tools.requirePermission(tenantId, "write");
        const result = await tools.auditedMutation(
          tenantId,
          "mcp.orgbrain_memories_suppress",
          "memory",
          () => suppressMemoryByRequest(tools.env, {
            tenant_id: tenantId,
            memory_id,
            reason,
            actor_type: "principal",
            actor_id: tools.props?.principal ?? null
          }, { actorPrincipal: tools.props?.principal })
        );
        return toContent(result);
      }, "write"
    );
}
