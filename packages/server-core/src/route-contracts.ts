import type { ApiRouteManifestEntry } from "@org-brain/contracts";
import { permissionForOrgBrainRequest, type ApiRouteDefinition, type RouteGroup } from "./index.js";
import type { RouteApp, RouteAppEnv } from "./ports.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

const SUCCESS_STATUS_OVERRIDES: Readonly<Record<string, number>> = {
  "POST /v1/memory-collectors/keys": 201,
  "POST /v1/memory-ingestions/verified": 202,
  "POST /v1/skills/generate": 202,
  "POST /v1/skills": 201,
  "POST /v1/skills/:id/versions": 201,
  "POST /v1/agents": 201,
  "POST /v1/groups": 201,
  "POST /v1/tasks": 201,
  "POST /v1/decision-memories": 201,
  "POST /v1/domain-recalls/:id/feedback": 201,
  "POST /v1/portable-imports": 201,
  "POST /v1/domain-packs/installations": 201,
  "POST /v1/metric-definitions": 201,
  "POST /v1/metric-definitions/:id/versions": 201,
  "POST /v1/metric-definitions/:id/bindings": 201,
  "POST /v1/metric-snapshots": 201,
  "POST /v1/domain-dashboards": 201,
  "POST /v1/managed-object-types": 201,
  "POST /v1/managed-objects": 201,
  "POST /v1/managed-object-relations": 201,
  "POST /v1/managed-object-external-refs": 201,
  "POST /v1/decision-domain-links": 201,
  "POST /v1/auth/email/request-code": 202,
  "POST /v1/users": 201,
  "PUT /v1/role-assignments": 201,
  "POST /v1/scoped-tokens": 201,
  "POST /v1/mcp-client-installations": 201,
  "POST /v1/memory-impact-executions": 201,
  "POST /v1/memory-impact-executions/:externalRunId/report": 201,
  "POST /v1/business-categories": 201,
  "POST /v1/memory-effects": 201,
  "POST /v1/memory-usages": 201,
  "POST /v1/memory-failure-patterns": 201,
  "POST /v1/retrieval-ranking-profiles": 201,
  "POST /v1/retrieval-generations": 201,
  "POST /v1/memories/upsert": 201,
  "POST /v1/memories/capture": 201,
  "POST /v1/memories/propose": 201,
  "POST /v1/memories/capture-rationale": 201,
  "POST /v1/ops/tasks/:id/replay": 201
};

const IDEMPOTENCY_KEY_ROUTES = new Set([
  "POST /v1/resources",
  "POST /v1/resources/backfill",
  "POST /v1/resources/:id/locations",
  "POST /v1/resources/:id/refresh",
  "POST /v1/decision-resource-links",
  "POST /v1/decision-resource-links/:id/confirm",
  "POST /v1/decision-resource-links/:id/retire",
  "POST /v1/skills/generate",
  "POST /v1/memory-impact-executions",
  "POST /v1/memory-impact-executions/:externalRunId/report"
]);

function schemaName(method: string, path: string, suffix: "Request" | "Response"): string {
  const stem = path.split(/[^A-Za-z0-9]+/u).filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
  return `${method[0]!.toUpperCase()}${method.slice(1).toLowerCase()}${stem}${suffix}`;
}

const routeDefinitions = new Map<string, ApiRouteDefinition<unknown>>();

function routeEntry(method: string, path: string): ApiRouteManifestEntry {
  const normalizedMethod = method.toUpperCase() as ApiRouteManifestEntry["method"];
  const key = `${normalizedMethod} ${path}`;
  return {
    method: normalizedMethod,
    path,
    permission: permissionForOrgBrainRequest(normalizedMethod, path),
    request_schema: schemaName(normalizedMethod, path, "Request"),
    response_schema: schemaName(normalizedMethod, path, "Response"),
    success_statuses: [SUCCESS_STATUS_OVERRIDES[key] ?? 200],
    idempotent: ["GET", "PUT", "DELETE", "HEAD", "OPTIONS"].includes(normalizedMethod) || IDEMPOTENCY_KEY_ROUTES.has(key)
  };
}

export function resetCapturedRouteDefinitions(): void {
  routeDefinitions.clear();
}

export function capturedRouteDefinitions(): ApiRouteDefinition<unknown>[] {
  return [...routeDefinitions.values()].sort((left, right) =>
    left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
}

export function withRouteContracts<TEnv extends RouteAppEnv>(
  app: RouteApp<TEnv>,
  group: Exclude<RouteGroup, "mcp" | "oauth">
): RouteApp<TEnv> {
  return new Proxy(app, {
    get(target, property, receiver) {
      if (typeof property !== "string" || !HTTP_METHODS.has(property)) {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const path = args[0];
        if (typeof path !== "string" || !path.startsWith("/")) {
          throw new Error(`invalid_shared_route_path:${String(path)}`);
        }
        const entry = routeEntry(property, path);
        const key = `${entry.method} ${entry.path}`;
        const previous = routeDefinitions.get(key);
        if (previous && previous.group !== group) throw new Error(`duplicate_shared_route:${key}`);
        const handler = args.at(-1);
        routeDefinitions.set(key, {
          ...entry,
          group,
          handler: handler as ApiRouteDefinition<unknown>["handler"]
        });
        const registrar = Reflect.get(target, property, target) as (...input: unknown[]) => unknown;
        return registrar.apply(target, args);
      };
    }
  }) as RouteApp<TEnv>;
}
