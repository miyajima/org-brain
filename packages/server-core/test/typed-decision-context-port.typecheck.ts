import { registerDecisionContextRoutes, type DecisionContextPort, type TypedDecisionContextPort, type RouteApp, type RouteAppEnv } from "../src/index.js";

declare const legacy: DecisionContextPort<RouteAppEnv>;
function registerLegacy(app: RouteApp<RouteAppEnv>) {
  registerDecisionContextRoutes(app, legacy);
}
function calls(port: TypedDecisionContextPort<RouteAppEnv>, env: RouteAppEnv["Bindings"]) {
  void port.putPortableImportChunk(env, "tenant", "import", 1, {});
  // @ts-expect-error The sequence is required before the body.
  void port.putPortableImportChunk(env, "tenant", "import", {});
  // @ts-expect-error Tenant ID and environment cannot be swapped.
  void port.getDomainRecallById("tenant", env, "id", "principal");
  void port.getDomainRecallById(env, "tenant", "id", "principal", true);
}
const invalidResult: Pick<TypedDecisionContextPort<RouteAppEnv>, "upsertKnowledgeResource"> = {
  // @ts-expect-error Routes require the created flag to choose the response status.
  upsertKnowledgeResource: async () => ({})
};
void registerLegacy;
void calls;
void invalidResult;
