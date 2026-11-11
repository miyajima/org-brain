import {
  registerDomainRoutes as registerSharedDomainRoutes,
  type DomainPort
} from "@org-brain/server-core";
import {
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  type ApiContextEnv
} from "./auth";
import { getDecisionBriefing, getDecisionMap, getDecisionTrace } from "./decision-console-service";
import {
  getDomainContext,
  createDecisionDomainLink,
  createManagedObject,
  createManagedObjectExternalRef,
  createManagedObjectRelation,
  createManagedObjectType,
  createMetricBinding,
  createMetricDefinition,
  createMetricDefinitionVersion,
  createMetricSnapshot,
  listDomainDashboards,
  listMetricSourceBindings,
  queryMetricSnapshots,
  queryMetrics,
  recordMetricPromotion,
  searchManagedObjects,
  setMetricTarget,
  upsertDomainDashboard
} from "./domain-metric-service";
import { installDomainPacks, listDomainPacks, planDomainPackInstallation, uninstallDomainPack } from "./domain-pack-service";
import { getDomainPackWorkspace } from "./domain-workspace-service";
import {
  completeKnowledgePackOnboarding,
  createKnowledgePackOnboarding,
  getKnowledgePackOnboarding,
  planKnowledgePackOnboarding,
  updateKnowledgePackOnboardingStep
} from "./knowledge-pack-onboarding-service";
import {
  cancelRetrospective,
  closeRetrospective,
  createImprovementAction,
  createRetrospective,
  createRetrospectiveSchedule,
  enqueueMetricImport,
  getMetricImportRun,
  getOrganizationDashboard,
  getRetrospective,
  getRetrospectiveResults,
  listImprovementActions,
  listMetricConnections,
  listRetrospectiveSchedules,
  listRetrospectives,
  putRetrospectiveResponse,
  recordKnowledgePackGoalSnapshot,
  updateImprovementAction,
  updateRetrospectiveSchedule,
  verifyImprovementAction
} from "./knowledge-measurement-service";
import { assertDecisionConsoleEnabled, isTenantAdmin, requireIdempotencyKey } from "./route-support";
import type { Env } from "./types";
import type { Hono } from "hono";
import { isKnowledgeLoopWritable } from "./knowledge-loop-feature";
import { featureMode, isFeatureEnabled } from "./feature-mode";

export function domainCapabilities(env: Env, tenantId: string, adminAllowed = false): Record<string, unknown> {
  const capabilities = {
    domain_packs: {
      mode: featureMode(env.DOMAIN_PACKS_MODE),
      enabled: isFeatureEnabled(env.DOMAIN_PACKS_MODE)
    },
    domain_metrics: {
      mode: featureMode(env.DOMAIN_METRICS_MODE),
      enabled: isFeatureEnabled(env.DOMAIN_METRICS_MODE)
    },
    domain_workspaces: {
      mode: featureMode(env.DOMAIN_WORKSPACES_MODE),
      enabled: isFeatureEnabled(env.DOMAIN_WORKSPACES_MODE)
    },
    knowledge_pack_onboarding: {
      mode: featureMode(env.KNOWLEDGE_PACK_ONBOARDING_MODE),
      enabled: isFeatureEnabled(env.KNOWLEDGE_PACK_ONBOARDING_MODE),
      writable: isKnowledgeLoopWritable(env, "KNOWLEDGE_PACK_ONBOARDING_MODE", tenantId)
    },
    organization_dashboard: { mode: featureMode(env.ORGANIZATION_DASHBOARD_MODE),
      enabled: isFeatureEnabled(env.ORGANIZATION_DASHBOARD_MODE), writable: isKnowledgeLoopWritable(env, "ORGANIZATION_DASHBOARD_MODE", tenantId) },
    metric_import: { mode: featureMode(env.METRIC_IMPORT_MODE),
      enabled: isFeatureEnabled(env.METRIC_IMPORT_MODE), writable: isKnowledgeLoopWritable(env, "METRIC_IMPORT_MODE", tenantId) },
    retrospective: { mode: featureMode(env.RETROSPECTIVE_MODE),
      enabled: isFeatureEnabled(env.RETROSPECTIVE_MODE), writable: isKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", tenantId) },
    improvement_actions: { mode: featureMode(env.IMPROVEMENT_ACTIONS_MODE),
      enabled: isFeatureEnabled(env.IMPROVEMENT_ACTIONS_MODE), writable: isKnowledgeLoopWritable(env, "IMPROVEMENT_ACTIONS_MODE", tenantId) },
    pack_builder: { enabled: false, href: null, edition: "enterprise" }
  };
  return Object.fromEntries(Object.entries(capabilities).map(([key, value]) => [key, {
    ...value,
    allowed_actions: "writable" in value && value.writable && adminAllowed ? ["create", "update", "manage"] : []
  }]));
}

const domainPort = {
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  domainCapabilities,
  getDecisionBriefing,
  getDecisionMap,
  getDecisionTrace,
  getDomainContext,
  createDecisionDomainLink,
  createManagedObject,
  createManagedObjectExternalRef,
  createManagedObjectRelation,
  createManagedObjectType,
  createMetricBinding,
  createMetricDefinition,
  createMetricDefinitionVersion,
  createMetricSnapshot,
  listDomainDashboards,
  listMetricSourceBindings,
  queryMetricSnapshots,
  queryMetrics,
  recordMetricPromotion,
  searchManagedObjects,
  setMetricTarget,
  upsertDomainDashboard,
  installDomainPacks,
  listDomainPacks,
  planDomainPackInstallation,
  uninstallDomainPack,
  getDomainPackWorkspace,
  createKnowledgePackOnboarding,
  getKnowledgePackOnboarding,
  updateKnowledgePackOnboardingStep,
  planKnowledgePackOnboarding,
  completeKnowledgePackOnboarding,
  getOrganizationDashboard,
  recordKnowledgePackGoalSnapshot,
  listMetricConnections,
  enqueueMetricImport,
  getMetricImportRun,
  createRetrospectiveSchedule,
  listRetrospectiveSchedules,
  updateRetrospectiveSchedule,
  createRetrospective,
  listRetrospectives,
  getRetrospective,
  putRetrospectiveResponse,
  closeRetrospective,
  cancelRetrospective,
  getRetrospectiveResults,
  createImprovementAction,
  listImprovementActions,
  updateImprovementAction,
  verifyImprovementAction,
  requireIdempotencyKey,
  assertDecisionConsoleEnabled,
  isTenantAdmin
} satisfies DomainPort<ApiContextEnv>;

export function registerDomainRoutes(app: Hono<ApiContextEnv>): void {
  registerSharedDomainRoutes(app, domainPort);
}
