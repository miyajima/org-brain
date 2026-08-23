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
import { getMemoryQualityRun, listMemoryQualityRuns } from "./memory-quality-service";
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
  proposeMemoryWithRationale
} from "./rationale-service";
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
  listMemoryQualityRuns,
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
