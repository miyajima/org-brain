import { registerDomainRoutes, registerOperationsRoutes, registerCollaborationRoutes, registerAssetAgentRoutes, registerDashboardAccessRoutes, type DomainPort, type OperationsPort, type CollaborationPort, type AssetAgentPort, type DashboardAccessPort, type RouteApp, type RouteAppEnv, type TypedOperationsPort, type TypedCollaborationPort, type TypedAssetAgentPort, type TypedDashboardAccessPort, type TypedDomainPort } from "../src/index.js";

declare const legacy: DomainPort<RouteAppEnv>;
declare const oldOps: OperationsPort<RouteAppEnv>;
declare const oldCollaboration: CollaborationPort<RouteAppEnv>;
declare const oldAssets: AssetAgentPort<RouteAppEnv>;
declare const oldDashboard: DashboardAccessPort<RouteAppEnv>;
function registerLegacy(app: RouteApp<RouteAppEnv>) {
  registerDomainRoutes(app, legacy);
  registerOperationsRoutes(app, oldOps);
  registerCollaborationRoutes(app, oldCollaboration);
  registerAssetAgentRoutes(app, oldAssets);
  registerDashboardAccessRoutes(app, oldDashboard);
}
function calls(env: RouteAppEnv["Bindings"], ops: TypedOperationsPort<RouteAppEnv>, collaboration: TypedCollaborationPort<RouteAppEnv>, assets: TypedAssetAgentPort<RouteAppEnv>, dashboard: TypedDashboardAccessPort<RouteAppEnv>, domain: TypedDomainPort<RouteAppEnv>) {
  void ops.verifyAuditChain(env, "tenant");
  // @ts-expect-error A tenant is required.
  void ops.verifyAuditChain(env);
  void collaboration.getTask(env, "tenant", "task");
  // @ts-expect-error The task ID is required.
  void collaboration.getTask(env, "tenant");
  void assets.getAgent(env, { tenantId: "tenant", agentId: "agent", principal: "user" });
  // @ts-expect-error Agent ID is required.
  void assets.getAgent(env, { tenantId: "tenant", principal: "user" });
  void dashboard.getKnowledgeGraph(env, "tenant");
  // @ts-expect-error The environment and tenant cannot be swapped.
  void dashboard.getKnowledgeGraph("tenant", env);
  void domain.createMetricBinding(env, "tenant", "user", "definition", {});
  // @ts-expect-error Definition ID is a string.
  void domain.createMetricBinding(env, "tenant", "user", {}, "definition");
}
void registerLegacy;
void calls;
