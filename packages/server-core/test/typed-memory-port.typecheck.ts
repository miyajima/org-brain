import { registerMemoryRoutes, type MemoryPort, type RouteApp, type RouteAppEnv, type TypedMemoryPort, type TypedMemoryReadOperations, type TypedMemoryWriteOperations, type TypedMemoryConfirmationOperations, type TypedMemoryUsageOperations, type TypedMemoryRetrievalOperations } from "../src/index.js";

// The public legacy adapter remains accepted by existing registrations.
declare const legacy: MemoryPort<RouteAppEnv>;
const compatible: MemoryPort<RouteAppEnv> = legacy;
void compatible;
function registerLegacy(app: RouteApp<RouteAppEnv>) {
  registerMemoryRoutes(app, legacy);
}
void registerLegacy;

function memoryCalls(port: TypedMemoryReadOperations<RouteAppEnv>, env: RouteAppEnv["Bindings"]) {
  void port.getMemoryDetails(env, "tenant", "memory");
  void port.searchDecisionMemories(env, {}, { principal: "user" });
  // @ts-expect-error The environment and tenant ID must not be swapped.
  void port.getMemoryDetails("tenant", env, "memory");
  // @ts-expect-error A memory ID is required.
  void port.getMemoryDetails(env, "tenant");
  // @ts-expect-error The options object cannot occupy the ID position.
  void port.getMemoryDetails(env, "tenant", {});
}
void memoryCalls;

function otherCalls(usage: TypedMemoryUsageOperations<RouteAppEnv>, retrieval: TypedMemoryRetrievalOperations<RouteAppEnv>, env: RouteAppEnv["Bindings"]) {
  void usage.memoryUseOperation(env, "tenant", {}, "user", "record");
  // @ts-expect-error The operation name is required.
  void usage.memoryUseOperation(env, "tenant", {}, "user");
  void retrieval.backfillRetrievalGeneration(env, "tenant", "generation", {});
  // @ts-expect-error Generation ID is a string.
  void retrieval.backfillRetrievalGeneration(env, "tenant", {}, "generation");
}
void otherCalls;

function lifecycleCalls(write: TypedMemoryWriteOperations<RouteAppEnv>, confirmation: TypedMemoryConfirmationOperations<RouteAppEnv>, env: RouteAppEnv["Bindings"]) {
  void write.deleteMemoryById(env, "tenant", "id");
  // @ts-expect-error The memory ID is required.
  void write.deleteMemoryById(env, "tenant");
  void confirmation.captureRequestClaimsVerified({});
  // @ts-expect-error This synchronous operation takes one argument.
  void confirmation.captureRequestClaimsVerified({}, {});
}
void lifecycleCalls;

function strictRouteCalls(port: TypedMemoryPort<RouteAppEnv>, env: RouteAppEnv["Bindings"]) {
  void port.getMemoryDetails(env, "tenant", "memory");
  // @ts-expect-error Strict registrations reject a missing memory ID.
  void port.getMemoryDetails(env, "tenant");
}
void strictRouteCalls;
