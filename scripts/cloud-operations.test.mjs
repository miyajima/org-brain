import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildCloudProvisionPlan,
  diagnoseRemoteMcp,
  runCloudCommand
} from "../packages/orgbrain-cli/src/cloud-operations.mjs";

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

test("cf provision plans a dedicated MCP hostname and explicit Managed OAuth policy", () => {
  const plan = buildCloudProvisionPlan({
    root: process.cwd(),
    withManagedOAuth: true,
    mcpHost: "mcp.example.test",
    accessPolicyId: "12345678-1234-1234-1234-123456789abc"
  });
  assert.deepEqual(plan.resources.managed_oauth, {
    host: "mcp.example.test",
    endpoint: "https://mcp.example.test/mcp",
    access_policy_id: "12345678-1234-1234-1234-123456789abc",
    access_application_domain: "mcp.example.test/mcp*"
  });
  const deploy = plan.steps.find((step) => step.id === "deploy_mcp");
  assert.deepEqual(deploy.command.args.slice(-2), ["--route", "mcp.example.test/*"]);
  assert.ok(plan.steps.some((step) => step.id === "ensure_mcp_access_application"));
  assert.throws(
    () => buildCloudProvisionPlan({ withManagedOAuth: true, mcpHost: "https://bad.test", accessPolicyId: "12345678-1234-1234-1234-123456789abc" }),
    /managed DNS hostname/u
  );
});

test("cf live doctor validates OAuth resource and authorization discovery", async () => {
  const responses = new Map([
    ["https://mcp.example.test/mcp", new Response("unauthorized", {
      status: 401,
      headers: {
        "www-authenticate": "Bearer resource_metadata=\"https://mcp.example.test/.well-known/oauth-protected-resource\""
      }
    })],
    ["https://mcp.example.test/.well-known/oauth-protected-resource", new Response(JSON.stringify({
      resource: "https://mcp.example.test/mcp",
      authorization_servers: ["https://auth.example.test"]
    }), { status: 200, headers: { "content-type": "application/json" } })],
    ["https://auth.example.test/.well-known/oauth-authorization-server", new Response(JSON.stringify({
      issuer: "https://auth.example.test",
      authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token"
    }), { status: 200, headers: { "content-type": "application/json" } })]
  ]);
  const checks = await diagnoseRemoteMcp("https://mcp.example.test", {
    fetchImpl: async (url) => {
      const response = responses.get(String(url));
      if (!response) throw new Error(`unexpected URL: ${url}`);
      return response.clone();
    }
  });
  assert.equal(checks.find((check) => check.id === "mcp-managed-oauth-challenge")?.ok, true);
  assert.equal(checks.find((check) => check.id === "mcp-protected-resource-discovery")?.ok, true);
  assert.equal(checks.find((check) => check.id === "mcp-authorization-server-discovery")?.ok, true);
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
