import {
  registerAssetAgentRoutes as registerSharedAssetAgentRoutes,
  type AssetAgentPort
} from "@org-brain/server-core";
import {
  createAgent,
  getAgent,
  listAgents,
  resolveAgentLoadoutContext,
  updateAgent,
  updateAgentLoadout
} from "./agent-loadout-service";
import {
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  type ApiContextEnv
} from "./auth";
import {
  availableSkillProviders,
  createSkillAsset,
  createSkillVersion,
  exportSkillAsset,
  generateSkillAsset,
  getSkillAsset,
  listSkillAssets,
  publishSkillAsset,
  retireSkillAsset
} from "./skill-asset-service";
import { authorizePermission } from "./rbac-service";
import {
  getVerifiedIngestionManifest,
  ingestVerifiedKnowledgeBundle,
  listVerifiedManifestsByCollector,
  registerCollectorKey,
  revokeCollectorKey
} from "./verified-ingestion-service";
import { assertDecisionConsoleEnabled, isTenantAdmin, requireIdempotencyKey } from "./route-support";
import type { Hono } from "hono";

const assetAgentPort = {
  createAgent,
  getAgent,
  listAgents,
  resolveAgentLoadoutContext,
  updateAgent,
  updateAgentLoadout,
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  availableSkillProviders,
  createSkillAsset,
  createSkillVersion,
  exportSkillAsset,
  generateSkillAsset,
  getSkillAsset,
  listSkillAssets,
  publishSkillAsset,
  retireSkillAsset,
  authorizePermission: (env, input) => authorizePermission(env, input),
  getVerifiedIngestionManifest,
  ingestVerifiedKnowledgeBundle,
  listVerifiedManifestsByCollector,
  registerCollectorKey,
  revokeCollectorKey,
  assertDecisionConsoleEnabled,
  isTenantAdmin,
  requireIdempotencyKey
} satisfies AssetAgentPort<ApiContextEnv>;

export function registerAssetAgentRoutes(app: Hono<ApiContextEnv>): void {
  registerSharedAssetAgentRoutes(app, assetAgentPort);
}
