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

function domainCapabilities(env: Env, tenantId: string): Record<string, unknown> {
  return {
    domain_packs: {
      mode: env.DOMAIN_PACKS_MODE ?? "off",
      enabled: env.DOMAIN_PACKS_MODE !== undefined && env.DOMAIN_PACKS_MODE !== "off"
    },
    domain_metrics: {
      mode: env.DOMAIN_METRICS_MODE ?? "off",
      enabled: env.DOMAIN_METRICS_MODE !== undefined && env.DOMAIN_METRICS_MODE !== "off"
    },
    domain_workspaces: {
      mode: env.DOMAIN_WORKSPACES_MODE ?? "off",
      enabled: env.DOMAIN_WORKSPACES_MODE !== undefined && env.DOMAIN_WORKSPACES_MODE !== "off"
    },
    knowledge_pack_onboarding: {
      mode: env.KNOWLEDGE_PACK_ONBOARDING_MODE ?? "off",
      enabled: env.KNOWLEDGE_PACK_ONBOARDING_MODE !== undefined && env.KNOWLEDGE_PACK_ONBOARDING_MODE !== "off",
      writable: isKnowledgeLoopWritable(env, "KNOWLEDGE_PACK_ONBOARDING_MODE", tenantId)
    },
    organization_dashboard: { mode: env.ORGANIZATION_DASHBOARD_MODE ?? "off", enabled: env.ORGANIZATION_DASHBOARD_MODE !== undefined && env.ORGANIZATION_DASHBOARD_MODE !== "off", writable: isKnowledgeLoopWritable(env, "ORGANIZATION_DASHBOARD_MODE", tenantId) },
    metric_import: { mode: env.METRIC_IMPORT_MODE ?? "off", enabled: env.METRIC_IMPORT_MODE !== undefined && env.METRIC_IMPORT_MODE !== "off", writable: isKnowledgeLoopWritable(env, "METRIC_IMPORT_MODE", tenantId) },
    retrospective: { mode: env.RETROSPECTIVE_MODE ?? "off", enabled: env.RETROSPECTIVE_MODE !== undefined && env.RETROSPECTIVE_MODE !== "off", writable: isKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", tenantId) },
    improvement_actions: { mode: env.IMPROVEMENT_ACTIONS_MODE ?? "off", enabled: env.IMPROVEMENT_ACTIONS_MODE !== undefined && env.IMPROVEMENT_ACTIONS_MODE !== "off", writable: isKnowledgeLoopWritable(env, "IMPROVEMENT_ACTIONS_MODE", tenantId) },
    pack_builder: { enabled: false, href: null, edition: "enterprise" }
  };
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
