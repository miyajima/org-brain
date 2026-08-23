import {
  registerDashboardAccessRoutes as registerSharedDashboardAccessRoutes,
  type DashboardAccessPort
} from "@org-brain/server-core";
import { getActivityDashboard } from "./activity-dashboard-service";
import { getAccessPolicy, getAccessPolicyShadowSummary, updateAccessPolicy } from "./access-policy-service";
import { assertApiTenantAccess, getApiAuthContext, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import { getKnowledgeGraph } from "./knowledge-graph-service";
import { getMemoryStrata, getMemoryStrataDetail } from "./memory-strata-service";
import { getMemoryAnalytics, getMemoryMap } from "./memory-dashboard-service";
import { getMemoryMapTrace } from "./memory-map-trace-service";
import {
  accessPolicyResourceType,
  assertDecisionConsoleEnabled,
  dashboardStrataDetailQuerySchema,
  isTenantAdmin,
  runDashboardView
} from "./route-support";
import type { Hono } from "hono";

const dashboardAccessPort = {
  getActivityDashboard,
  getAccessPolicy,
  getAccessPolicyShadowSummary,
  updateAccessPolicy,
  assertApiTenantAccess,
  getApiAuthContext,
  getApiPrincipal,
  jsonOk,
  tenantFromBody,
  getKnowledgeGraph,
  getMemoryStrata,
  getMemoryStrataDetail,
  getMemoryAnalytics,
  getMemoryMap,
  getMemoryMapTrace,
  accessPolicyResourceType,
  assertDecisionConsoleEnabled,
  dashboardStrataDetailQuerySchema,
  isTenantAdmin,
  runDashboardView
} satisfies DashboardAccessPort<ApiContextEnv>;

export function registerDashboardAccessRoutes(app: Hono<ApiContextEnv>): void {
  registerSharedDashboardAccessRoutes(app, dashboardAccessPort);
}
