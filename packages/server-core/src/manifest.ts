import type { ApiRouteManifestEntry } from "@org-brain/contracts";
import { Hono } from "hono";
import { registerAssetAgentRoutes } from "./asset-agent-routes.js";
import { registerCollaborationRoutes } from "./collaboration-routes.js";
import { registerDashboardAccessRoutes } from "./dashboard-access-routes.js";
import { registerDecisionContextRoutes } from "./decision-context-routes.js";
import { registerDomainRoutes } from "./domain-routes.js";
import { registerIdentityRoutes } from "./identity-routes.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import { registerOperationsRoutes } from "./operations-routes.js";
import type {
  AssetAgentPort,
  CollaborationPort,
  DashboardAccessPort,
  DecisionContextPort,
  DomainPort,
  IdentityPort,
  MemoryPort,
  OperationsPort,
  RouteAppEnv
} from "./ports.js";
import { capturedRouteDefinitions, resetCapturedRouteDefinitions } from "./route-contracts.js";
import { manifestEntry, type ApiRouteDefinition } from "./index.js";

type CollectionEnv = RouteAppEnv;

export const COMPATIBILITY_PROTOCOL_ROUTES: readonly ApiRouteManifestEntry[] = [
  { method: "POST", path: "/mcp", permission: "read", request_schema: "McpRequest", response_schema: "McpResponse", success_statuses: [200, 202], idempotent: false },
  { method: "GET", path: "/.well-known/oauth-protected-resource", permission: null, request_schema: null, response_schema: "OAuthProtectedResourceMetadata", success_statuses: [200], idempotent: true },
  { method: "GET", path: "/.well-known/oauth-protected-resource/mcp", permission: null, request_schema: null, response_schema: "OAuthProtectedResourceMetadata", success_statuses: [200], idempotent: true },
  { method: "GET", path: "/.well-known/oauth-authorization-server", permission: null, request_schema: null, response_schema: "OAuthAuthorizationServerMetadata", success_statuses: [200], idempotent: true },
  { method: "GET", path: "/oauth/authorize", permission: null, request_schema: "OAuthAuthorizationRequest", response_schema: null, success_statuses: [200, 302], idempotent: true },
  { method: "POST", path: "/oauth/authorize", permission: null, request_schema: "OAuthAuthorizationDecision", response_schema: null, success_statuses: [302], idempotent: false },
  { method: "POST", path: "/oauth/token", permission: null, request_schema: "OAuthTokenRequest", response_schema: "OAuthTokenResponse", success_statuses: [200], idempotent: false },
  { method: "POST", path: "/oauth/revoke", permission: null, request_schema: "OAuthRevocationRequest", response_schema: null, success_statuses: [200], idempotent: true },
  { method: "POST", path: "/oauth/register", permission: null, request_schema: "OAuthClientRegistrationRequest", response_schema: "OAuthClientRegistrationResponse", success_statuses: [201], idempotent: false }
];

export function collectSharedRouteDefinitions(): ApiRouteDefinition<unknown>[] {
  resetCapturedRouteDefinitions();
  const app = new Hono<CollectionEnv>();
  registerIdentityRoutes(app, {} as IdentityPort<CollectionEnv>);
  registerCollaborationRoutes(app, {} as CollaborationPort<CollectionEnv>);
  registerAssetAgentRoutes(app, {} as AssetAgentPort<CollectionEnv>);
  registerDashboardAccessRoutes(app, {} as DashboardAccessPort<CollectionEnv>);
  registerOperationsRoutes(app, {} as OperationsPort<CollectionEnv>);
  registerMemoryRoutes(app, {} as MemoryPort<CollectionEnv>);
  registerDecisionContextRoutes(app, {} as DecisionContextPort<CollectionEnv>);
  registerDomainRoutes(app, {} as DomainPort<CollectionEnv>);
  return capturedRouteDefinitions();
}

export function collectCompatibilityManifestEntries(): ApiRouteManifestEntry[] {
  return [
    ...collectSharedRouteDefinitions().map((definition) => manifestEntry(definition)),
    ...COMPATIBILITY_PROTOCOL_ROUTES
  ];
}
