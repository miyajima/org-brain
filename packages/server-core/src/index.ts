import {
  API_MANIFEST_VERSION,
  apiManifestSchema,
  type ApiManifest,
  type ApiRouteManifestEntry,
  type OrgPermission,
  type PrincipalContext
} from "@org-brain/contracts";

export * from "./ports.js";
export * from "./errors.js";
export * from "./route-contracts.js";
export * from "./manifest.js";
export * from "./identity-routes.js";
export * from "./collaboration-routes.js";
export * from "./asset-agent-routes.js";
export * from "./dashboard-access-routes.js";
export * from "./operations-routes.js";
export * from "./memory-routes.js";
export * from "./decision-context-routes.js";
export * from "./domain-routes.js";

export type RouteGroup =
  | "identity"
  | "collaboration"
  | "asset-agent"
  | "dashboard-access"
  | "operations"
  | "memory"
  | "decision-context"
  | "domain"
  | "mcp"
  | "oauth";

export interface SharedRequestContext {
  request: Request;
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  auth: PrincipalContext;
  requestId: string | null;
  idempotencyKey: string | null;
}

export interface SharedRouteResult {
  status: number;
  body?: unknown;
  headers?: HeadersInit;
}

export type SharedRouteHandler<TPorts> = (
  context: SharedRequestContext,
  ports: TPorts
) => Promise<SharedRouteResult>;

export interface ApiRouteDefinition<TPorts = unknown> extends ApiRouteManifestEntry {
  group: RouteGroup;
  handler: SharedRouteHandler<TPorts>;
}

export interface RouteRegistrar<TPorts> {
  register(definition: ApiRouteDefinition<TPorts>, ports: TPorts): void;
}

export function registerRouteDefinitions<TPorts>(
  registrar: RouteRegistrar<TPorts>,
  definitions: readonly ApiRouteDefinition<TPorts>[],
  ports: TPorts
): void {
  for (const definition of definitions) registrar.register(definition, ports);
}

export function manifestEntry(definition: ApiRouteDefinition<unknown>): ApiRouteManifestEntry {
  const { group: _group, handler: _handler, ...entry } = definition;
  return entry;
}

export function permissionForOrgBrainRequest(method: string, path: string): OrgPermission {
  if (path.startsWith("/v1/auth/")) return method === "GET" ? "read" : "write";
  if (path.startsWith("/v1/mcp-client-installations")) return "read";
  if (
    path === "/v1/organization" ||
    path.startsWith("/v1/users") ||
    path.startsWith("/v1/role-assignments") ||
    path.startsWith("/v1/groups") ||
    path.startsWith("/v1/scoped-tokens") ||
    path.startsWith("/v1/retention-policies") ||
    path.startsWith("/v1/retention-queue") ||
    path.startsWith("/v1/ops/") ||
    path.startsWith("/v1/retrieval-index") ||
    path.startsWith("/v1/retrieval-ranking-profiles") ||
    path.startsWith("/v1/retrieval-generations") ||
    path.startsWith("/v1/retrieval-generation-assignments") ||
    (path.startsWith("/v1/domain-packs/installations") && method !== "GET") ||
    path.startsWith("/v1/portable-imports") ||
    path.endsWith("/promotion") ||
    path === "/v1/resources/backfill" ||
    path.startsWith("/v1/memory-collectors/keys")
  ) return "admin";
  if (path.startsWith("/v1/business-categories")) return method === "GET" ? "read" : "admin";
  if (path.startsWith("/v1/resource-shares")) return method === "GET" ? "read" : "share";
  if (path.startsWith("/v1/access-policies")) return method === "GET" ? "read" : "share";
  if (path.startsWith("/v1/audit-events")) return "export";
  if (
    path.endsWith("/search") ||
    path.endsWith("/profile") ||
    path.endsWith("/context") ||
    path.endsWith("/context-preview") ||
    path.endsWith("/review-queue") ||
    path.startsWith("/v1/context/") ||
    path === "/api/context/enrich"
  ) return "read";
  if (method === "DELETE") return "delete";
  if (path.includes("/export")) return "export";
  if (method === "GET") return "read";
  return "write";
}

export function createApiManifest(input: {
  ossRef: string;
  generatedAt: string;
  routes: ApiRouteManifestEntry[];
}): ApiManifest {
  const unique = new Set<string>();
  for (const route of input.routes) {
    const key = `${route.method} ${route.path}`;
    if (unique.has(key)) throw new Error(`duplicate_api_route:${key}`);
    unique.add(key);
  }
  return apiManifestSchema.parse({
    contract_version: API_MANIFEST_VERSION,
    oss_ref: input.ossRef,
    generated_at: input.generatedAt,
    routes: [...input.routes].sort((left, right) =>
      left.path.localeCompare(right.path) || left.method.localeCompare(right.method))
  });
}

export function diffApiManifests(expected: ApiManifest, actual: ApiManifest) {
  const key = (route: ApiRouteManifestEntry) => `${route.method} ${route.path}`;
  const expectedMap = new Map(expected.routes.map((route) => [key(route), route]));
  const actualMap = new Map(actual.routes.map((route) => [key(route), route]));
  const missing = [...expectedMap.keys()].filter((item) => !actualMap.has(item));
  const extra = [...actualMap.keys()].filter((item) => !expectedMap.has(item));
  const changed = [...expectedMap.keys()].filter((item) => {
    const actualRoute = actualMap.get(item);
    return actualRoute && JSON.stringify(expectedMap.get(item)) !== JSON.stringify(actualRoute);
  });
  return { missing, extra, changed, equal: missing.length === 0 && extra.length === 0 && changed.length === 0 };
}
