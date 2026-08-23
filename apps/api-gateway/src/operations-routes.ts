import {
  registerOperationsRoutes as registerSharedOperationsRoutes,
  type OperationsPort
} from "@org-brain/server-core";
import { listAuditEvents, parseAuditLimit, verifyAuditChain } from "./audit-service";
import { assertApiTenantAccess, getApiAuthContext, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import { backfillDecisionRetrievalUnits } from "./context-engine-service";
import { getOperationsStatus } from "./operations-service";
import { backfillV3RetrievalUnits, backfillV4RetrievalUnits, rebuildSemanticIndex } from "./retrieval-index-service";
import { cancelRetentionQueue, listRetentionQueue } from "./retention-queue-service";
import { applyRetentionPolicies, listRetentionPolicies, upsertRetentionPolicy } from "./retention-service";
import { replayFailedTask } from "./task-service";
import type { Hono } from "hono";

const operationsPort = {
  listAuditEvents,
  parseAuditLimit,
  verifyAuditChain,
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  backfillDecisionRetrievalUnits,
  getOperationsStatus,
  backfillV3RetrievalUnits,
  backfillV4RetrievalUnits,
  rebuildSemanticIndex,
  cancelRetentionQueue,
  listRetentionQueue,
  applyRetentionPolicies,
  listRetentionPolicies,
  upsertRetentionPolicy,
  replayFailedTask
} satisfies OperationsPort<ApiContextEnv>;

export function registerOperationsRoutes(app: Hono<ApiContextEnv>): void {
  registerSharedOperationsRoutes(app, operationsPort);
}
