import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { buildCloudProvisionPlan, runCloudCommand } from "../packages/orgbrain-cli/src/cloud-operations.mjs";

const execFileAsync = promisify(execFile);

test("cf provision defaults to an inspectable non-mutating plan", async () => {
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
  assert.equal(plan.steps.some((step) => step.id === "synchronize_d1_bindings"), false);
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

test("cf doctor validates shared D1 bindings and migration sources locally", async () => {
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

test("cf CLI dispatches the Cloudflare doctor command", async () => {
  const cli = fileURLToPath(new URL("../packages/orgbrain-cli/src/local-memory.mjs", import.meta.url));
  const result = await execFileAsync(process.execPath, [
    cli,
    "cf",
    "doctor",
    "--root",
    process.cwd()
  ], { cwd: process.cwd() });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true, JSON.stringify(payload, null, 2));
});
