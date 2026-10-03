import { HttpError, planConversationMemory, normalizeMemoryReviewContext, sha256, type OrgRole } from '@org-brain/shared';
import { assertPermission } from './rbac-service';
import { proposeMemoryWithRationale, getMemoryConfirmationStatus, getMemoryConfirmationProject, type ConfirmationRevision } from './rationale-service';
import type { Env } from './types';
import { screenMemoryReviewText } from './memory-screening-service';

// No transcript discovery, extraction provider or active-memory write. The
// authenticated caller supplies a bounded summary and remains the proposal owner.
export async function stageConversationMemories(env: Env, tenantId: string, input: unknown, options: {
  principal: string; fallbackRole?: OrgRole; execute?: boolean; expectedPlanHash?: string; allowedProjectId?: string | null; revisionOf?: ConfirmationRevision;
}) {
  let plan;
  try {
    plan = planConversationMemory(input);
    for (const candidate of plan.candidates) {
      const review = normalizeMemoryReviewContext(candidate.proposal.review_context)!;
      for (const [field, value] of Object.entries({ content: candidate.proposal.item.content,
        summary: candidate.proposal.item.summary, conclusion: review.conclusion,
        reason_summary: review.reason_summary, reuse_rule: review.reuse_rule })) {
        if (value != null) screenMemoryReviewText(value, field);
      }
    }
  } catch (error) {
    throw new HttpError(400, 'invalid_conversation', error instanceof Error ? error.message : 'Invalid conversation summary');
  }
  if (plan.tenant_id !== tenantId) throw new HttpError(403, 'conversation_tenant_mismatch', 'Conversation tenant must match the authenticated tenant');
  if (options.allowedProjectId && options.allowedProjectId !== plan.project_id) throw new HttpError(403, "conversation_project_mismatch", "Caller token is bound to another project");
  if (!options.principal) throw new HttpError(401, 'unauthorized', 'An authenticated proposal owner is required');
  await assertPermission(env, { tenantId, projectId: plan.project_id, principal: options.principal,
    permission: 'write', fallbackRole: options.fallbackRole });
  if (options.revisionOf) {
    if (plan.candidates.length !== 1) throw new HttpError(400, 'revision_single_candidate', 'Revise exactly one displayed candidate');
    const oldProject = await getMemoryConfirmationProject(env, tenantId, options.revisionOf.confirmationToken, options.principal);
    if (oldProject !== plan.project_id) throw new HttpError(403, 'confirmation_scope_mismatch', 'Revision must retain the proposal project');
  }
  if (options.execute !== undefined && typeof options.execute !== "boolean") throw new HttpError(400,"invalid_execute","Execute must be a boolean");
  if (!options.execute) return { ...plan, executed: false, pending_created: 0, receipts: [] };
  if (options.expectedPlanHash !== plan.plan_hash) throw new HttpError(409, 'conversation_plan_hash_mismatch', 'Preview hash must match the current conversation plan');
  const receipts = [];
  for (const candidate of plan.candidates) {
    // Stable, owner-scoped 26-character IDs retain existing review pagination.
    // The token is not authorization: tenant/project permission and owner checks
    // remain mandatory. Conflicts and expired proposals are never overwritten.
    const digest = await sha256(JSON.stringify([tenantId, plan.project_id, options.principal, candidate.candidate_hash]));
    const stableConfirmationId = `C${digest.slice(0, 25).toUpperCase()}`;
    const proposed = await proposeMemoryWithRationale(env, { ...candidate.proposal,
      actor_type: 'principal', actor_id: options.principal,
      item: { ...candidate.proposal.item, created_at: Date.parse(plan.occurred_at) }
    }, { stableConfirmationId, conversationProvenance: candidate.provenance, revisionOf: options.revisionOf });
    const status = await getMemoryConfirmationStatus(env, { tenant_id: tenantId,
      confirmation_token: proposed.confirmation_token }, options.principal);
    receipts.push({ id: candidate.id, candidate_hash: candidate.candidate_hash,
      confirmation_token: proposed.confirmation_token, revision: Number(status.revision ?? proposed.revision), confirmation_guard_required: status.confirmation_guard_required ?? proposed.confirmation_guard_required, created: proposed.proposal_created === true,
      status: status.saved === true ? 'saved' : status.status ?? (status.saved === false ? 'not_requested' : 'pending'),
      saved: status.saved ?? null, superseded_by: status.superseded_by ?? null, previous_confirmation_id: status.previous_confirmation_id ?? null });
  }
  return { ...plan, executed: true, pending_created: receipts.filter(receipt => receipt.created).length, receipts };
}
