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
import { assertDecisionConsoleEnabled, isTenantAdmin } from "./route-support";
import type { Env } from "./types";
import type { Hono } from "hono";

function domainCapabilities(env: Env): Record<string, unknown> {
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
  assertDecisionConsoleEnabled,
  isTenantAdmin
} satisfies DomainPort<ApiContextEnv>;

export function registerDomainRoutes(app: Hono<ApiContextEnv>): void {
  registerSharedDomainRoutes(app, domainPort);
}
