import {
  registerDecisionContextRoutes as registerSharedDecisionContextRoutes,
  type DecisionContextPort
} from "@org-brain/server-core";
import {
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  type ApiContextEnv
} from "./auth";
import {
  confirmDecisionMemory,
  createDecisionMemory,
  enrichContext,
  getDecisionMemoryContext,
  getDecisionReviewQueue,
  preActionDecisionGate,
  reviseDecisionMemory,
  searchDecisionMemories
} from "./context-engine-service";
import {
  applyPortableImport,
  createPortableImport,
  getDomainRecall,
  getDomainRecallById,
  planPortableImport,
  putPortableImportChunk,
  recordDomainRecallFeedback
} from "./domain-recall-service";
import { getKnowledgeDoc, getKnowledgeDocContext, searchKnowledgeDocs, upsertKnowledgeDoc } from "./knowledge-docs-service";
import { assertPermission } from "./rbac-service";
import {
  addKnowledgeResourceLocation,
  backfillKnowledgeResources,
  captureKnowledgeResourceVersion,
  confirmDecisionResourceLinkProposal,
  createDecisionResourceLink,
  getDecisionResources,
  getResourceDecisions,
  listDecisionResourceLinkProposals,
  resolveKnowledgeResource,
  retireDecisionResourceLink,
  searchKnowledgeResources,
  upsertKnowledgeResource
} from "./resource-decision-service";
import { assertFeatureEnabled, isTenantAdmin, requireIdempotencyKey } from "./route-support";
import type { Env } from "./types";
import type { Hono } from "hono";

const portableArchiveMode = (env: Env): string => env.PORTABLE_ARCHIVE_MODE ?? "off";

const decisionContextPort = {
  portableArchiveMode,
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  confirmDecisionMemory,
  createDecisionMemory,
  enrichContext,
  getDecisionMemoryContext,
  getDecisionReviewQueue,
  preActionDecisionGate,
  reviseDecisionMemory,
  searchDecisionMemories,
  applyPortableImport,
  createPortableImport,
  getDomainRecall,
  getDomainRecallById,
  planPortableImport,
  putPortableImportChunk,
  recordDomainRecallFeedback,
  getKnowledgeDoc,
  getKnowledgeDocContext,
  searchKnowledgeDocs,
  upsertKnowledgeDoc,
  assertPermission: (env, input) => assertPermission(env, input),
  addKnowledgeResourceLocation,
  backfillKnowledgeResources,
  captureKnowledgeResourceVersion,
  confirmDecisionResourceLinkProposal,
  createDecisionResourceLink,
  getDecisionResources,
  getResourceDecisions,
  listDecisionResourceLinkProposals,
  resolveKnowledgeResource,
  retireDecisionResourceLink,
  searchKnowledgeResources,
  upsertKnowledgeResource,
  assertFeatureEnabled,
  isTenantAdmin,
  requireIdempotencyKey
} satisfies DecisionContextPort<ApiContextEnv>;

export function registerDecisionContextRoutes(app: Hono<ApiContextEnv>): void {
  registerSharedDecisionContextRoutes(app, decisionContextPort);
}
