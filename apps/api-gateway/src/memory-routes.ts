import { memoryUseOperation } from "./memory-use-service";
import {
  registerMemoryRoutes as registerSharedMemoryRoutes,
  type MemoryPort
} from "@org-brain/server-core";
import { createBusinessCategory, listBusinessCategories, updateBusinessCategory } from "./business-category-service";
import {
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  type ApiContextEnv
} from "./auth";
import { searchDecisionMemories } from "./context-engine-service";
import {
  memoryImpactReport,
  createMemoryFailurePattern,
  listMemoryFailurePatterns,
  recordMemoryEffect,
  recordMemoryUsage,
  recordMemoryUsageFromRequest,
  updateMemoryFailurePattern,
  updateMemoryUsageStates
} from "./memory-effect-service";
import { extractMemoryCandidates } from "./memory-extraction-service";
import { getMemoryImpactExecution, getMemoryImpactSummary, reportMemoryImpact, startMemoryImpact } from "./memory-impact-service";
import { getPrincipalOwnerMapping, listPrincipalOwnerMappings, upsertOwnPrincipalOwnerMapping, upsertPrincipalOwnerMapping } from "./memory-ownership-service";
import { listMemoryIntegrityIssues, proposeMemoryRelation, reportMemoryFeedback, reviewMemoryFeedback, reviewMemoryRelation } from "./memory-integrity-service";
import { getMemoryAgingPlan } from "./memory-aging-service";
import {
  getMemoryQualityAudit,
  getMemoryQualityAuditDetail,
  getMemoryQualityRun,
  listMemoryQualityRuns
} from "./memory-quality-service";
import {
  captureMemories,
  deleteMemoryById,
  getMemoryDetails,
  getMemoryProfile,
  listMemories,
  listMemoriesCursorPage,
  listMemoriesPage,
  refreshMemoryByRequest,
  restoreMemoryByRequest,
  reviseMemoryByRequest,
  retrieveMemoryContext,
  searchMemories,
  suppressMemoryByRequest,
  trashMemoryByRequest,
  upsertMemories
} from "./memory-service";
import {
  captureMemoryWithInferredRationale,
  captureRequestClaimsVerified,
  confirmProposedMemory,
  cancelMemoryConfirmation,
  getMemoryConfirmationProject,
  getMemoryConfirmationStatus,
  listMemoryConfirmationReviews,
  proposeMemoryWithRationale
} from "./rationale-service";
import { stageConversationMemories } from "./conversation-memory-service";
import { HttpError } from "@org-brain/shared";
import { assertPermission } from "./rbac-service";
import {
  assignRetrievalGeneration,
  backfillRetrievalGeneration,
  createRetrievalGeneration,
  createRetrievalRankingProfile,
  resolveRetrievalGenerationAssignment,
  transitionRetrievalGeneration
} from "./retrieval-generation-service";
import { assertRetrievalOperator, isTenantAdmin, withPrincipalActor } from "./route-support";
import type { Hono } from "hono";

const memoryPort = {
  memoryUseOperation,
  createBusinessCategory,
  listBusinessCategories,
  updateBusinessCategory,
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  searchDecisionMemories,
  memoryImpactReport,
  createMemoryFailurePattern,
  listMemoryFailurePatterns,
  recordMemoryEffect,
  recordMemoryUsage,
  recordMemoryUsageFromRequest,
  updateMemoryFailurePattern,
  updateMemoryUsageStates,
  extractMemoryCandidates,
  getMemoryImpactExecution,
  getMemoryImpactSummary,
  reportMemoryImpact,
  startMemoryImpact,
  getPrincipalOwnerMapping,
  listPrincipalOwnerMappings,
  upsertOwnPrincipalOwnerMapping,
  upsertPrincipalOwnerMapping,
  getMemoryQualityRun,
  getMemoryQualityAudit,
  getMemoryQualityAuditDetail,
  listMemoryQualityRuns,
  reportMemoryFeedback,
  reviewMemoryFeedback,
  proposeMemoryRelation,
  reviewMemoryRelation,
  listMemoryIntegrityIssues,
  getMemoryAgingPlan,
  captureMemories,
  deleteMemoryById,
  getMemoryDetails,
  getMemoryProfile,
  listMemories,
  listMemoriesCursorPage,
  listMemoriesPage,
  refreshMemoryByRequest,
  restoreMemoryByRequest,
  reviseMemoryByRequest,
  retrieveMemoryContext,
  searchMemories,
  suppressMemoryByRequest,
  trashMemoryByRequest,
  upsertMemories,
  captureMemoryWithInferredRationale,
  captureRequestClaimsVerified,
  confirmProposedMemory,
  cancelMemoryConfirmation,
  stageConversationMemories,
  guardMemoryConfirmation: async (env, tenantId, token, auth, permission) => {
    if (typeof token !== "string" || !token || token.length>64) throw new HttpError(400,"invalid_confirmation_token","A confirmation token is required");
    const projectId = await getMemoryConfirmationProject(env,tenantId,token,auth.principal);
    if (auth.projectId && auth.projectId !== projectId) throw new HttpError(403,"confirmation_project_mismatch","Token is bound to another project");
    await assertPermission(env,{tenantId,projectId,principal:auth.principal,permission,fallbackRole:auth.defaultRole});
  },
  getMemoryConfirmationStatus,
  listMemoryConfirmationReviews,
  proposeMemoryWithRationale,
  assertPermission: (env, input) => assertPermission(env, input),
  assignRetrievalGeneration,
  backfillRetrievalGeneration,
  createRetrievalGeneration,
  createRetrievalRankingProfile,
  resolveRetrievalGenerationAssignment,
  transitionRetrievalGeneration,
  assertRetrievalOperator,
  isTenantAdmin,
  withPrincipalActor
} satisfies MemoryPort<ApiContextEnv>;

export function registerMemoryRoutes(app: Hono<ApiContextEnv>): void {
  registerSharedMemoryRoutes(app, memoryPort);
}
