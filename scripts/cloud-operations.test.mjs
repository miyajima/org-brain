import assert from "node:assert/strict";
import test from "node:test";
import { buildCloudProvisionPlan, runCloudCommand } from "./cloud-operations.mjs";

test("cloud provision defaults to an inspectable non-mutating plan", async () => {
  const plan = buildCloudProvisionPlan({ root: process.cwd(), withVectorize: true });
  assert.equal(plan.resources.d1, "open-brain");
  assert.deepEqual(plan.resources.queues, [
    "org-bus",
    "org-bus-dlq",
    "cap-plan",
    "cap-plan-dlq",
    "orgbrain-retrieval-projection-v3",
    "orgbrain-retrieval-projection-v3-dlq"
  ]);
  assert.equal(plan.resources.vectorize, "orgbrain-memory-units-v3-1024");
  assert.ok(plan.steps.some((step) => step.id === "apply_migrations"));
  assert.ok(plan.steps.some((step) => step.id === "configure_vectorize_binding" && step.local_action));
  assert.ok(plan.steps.some((step) => step.id === "synchronize_d1_bindings" && step.local_action));
  assert.deepEqual(
    plan.steps
      .filter((step) => step.id.startsWith("deploy_"))
      .map((step) => step.id),
    [
      "deploy_cap_runner",
      "deploy_org_router",
      "deploy_retrieval_projector",
      "deploy_api_gateway",
      "deploy_mcp",
      "deploy_console"
    ]
  );

  const result = await runCloudCommand("provision", {
    flags: new Set(),
    get: (name, fallback) => name === "--root" ? process.cwd() : fallback
  });
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
});

test("cloud doctor validates shared D1 bindings and migration sources locally", async () => {
  const result = await runCloudCommand("doctor", {
    flags: new Set(),
    get: (name, fallback) => name === "--root" ? process.cwd() : fallback
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(
    result.checks.find((check) => check.id === "d1-binding-consistency")?.ok,
    true
  );
  assert.equal(result.checks.find((check) => check.id === "migrations")?.ok, true);
});
