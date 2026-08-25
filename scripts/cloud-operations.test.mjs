import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildManagedOAuthAccessApplication,
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
    hookHost: "hooks.example.test",
    accessPolicyId: "12345678-1234-1234-1234-123456789abc",
    hookAccessPolicyId: "87654321-4321-4321-4321-cba987654321"
  });
  assert.deepEqual(plan.resources.managed_oauth, {
    host: "mcp.example.test",
    endpoint: "https://mcp.example.test/mcp",
    hook_host: "hooks.example.test",
    hook_endpoint: "https://hooks.example.test/mcp",
    access_policy_id: "12345678-1234-1234-1234-123456789abc",
    hook_access_policy_id: "87654321-4321-4321-4321-cba987654321",
    access_application_domain: "mcp.example.test/oauth/authorize*",
    hook_access_application_domain: "hooks.example.test/*"
  });
  const gatewayDeploy = plan.steps.find((step) => step.id === "deploy_api_gateway");
  assert.deepEqual(gatewayDeploy.command.args.slice(-2), ["--route", "mcp.example.test/*"]);
  const edgeDeploy = plan.steps.find((step) => step.id === "deploy_mcp");
  assert.deepEqual(edgeDeploy.command.args.slice(-2), ["--route", "hooks.example.test/*"]);
  const accessApplications = buildManagedOAuthAccessApplication(plan.resources.managed_oauth);
  assert.equal(accessApplications.oauth.domain, "mcp.example.test/oauth/authorize*");
  assert.deepEqual(accessApplications.oauth.policies, ["12345678-1234-1234-1234-123456789abc"]);
  assert.equal(accessApplications.hook.domain, "hooks.example.test/*");
  assert.deepEqual(accessApplications.hook.policies, ["87654321-4321-4321-4321-cba987654321"]);
  assert.ok(plan.steps.some((step) => step.id === "ensure_mcp_access_application"));
  assert.ok(plan.steps.some((step) => step.id === "configure_mcp_oauth_runtime"));
  assert.throws(
    () => buildCloudProvisionPlan({ withManagedOAuth: true, mcpHost: "https://bad.test", hookHost: "hooks.example.test", accessPolicyId: "12345678-1234-1234-1234-123456789abc", hookAccessPolicyId: "87654321-4321-4321-4321-cba987654321" }),
    /managed DNS hostname/u
  );
  assert.throws(
    () => buildCloudProvisionPlan({ withManagedOAuth: true, mcpHost: "mcp.example.test", hookHost: "mcp.example.test", accessPolicyId: "12345678-1234-1234-1234-123456789abc", hookAccessPolicyId: "87654321-4321-4321-4321-cba987654321" }),
    /must differ/u
  );
});

test("managed OAuth execute stops before Cloudflare mutation when the resource runtime is unbound", async () => {
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  try {
    await assert.rejects(
      runCloudCommand("provision", {
        flags: new Set(["--with-managed-oauth", "--execute"]),
        get: (name, fallback) => ({
          "--root": process.cwd(),
          "--mcp-host": "mcp.example.test",
          "--hook-host": "hooks.example.test",
          "--access-policy-id": "12345678-1234-1234-1234-123456789abc",
          "--hook-access-policy-id": "87654321-4321-4321-4321-cba987654321"
        })[name] ?? fallback
      }),
      /requires an OAUTH_KV binding.*before any Cloudflare mutation/u
    );
  } finally {
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
    if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
  }
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

test("cf live doctor uses an interactive OAuth bearer for modern discovery, catalog, and read-only smoke", async () => {
  const seen = [];
  const checks = await diagnoseRemoteMcp("https://mcp.example.test", {
    oauthToken: "test-oauth-bearer",
    fetchImpl: async (url, init = {}) => {
      const target = String(url);
      if (target === "https://mcp.example.test/mcp" && init.method === "GET") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": "Bearer resource_metadata=\"https://mcp.example.test/.well-known/oauth-protected-resource\""
          }
        });
      }
      if (target === "https://mcp.example.test/.well-known/oauth-protected-resource") {
        return Response.json({ authorization_servers: ["https://auth.example.test"] });
      }
      if (target === "https://auth.example.test/.well-known/oauth-authorization-server") {
        return Response.json({
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token"
        });
      }
      if (target === "https://mcp.example.test/mcp" && init.method === "POST") {
        const body = JSON.parse(String(init.body));
        seen.push({ headers: new Headers(init.headers), body });
        if (body.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: body.id, result: { supportedVersions: ["2026-07-28"] } });
        if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [], isError: false } });
      }
      throw new Error(`unexpected request: ${target}`);
    }
  });
  assert.equal(checks.find((check) => check.id === "mcp-server-discover")?.ok, true);
  assert.equal(checks.find((check) => check.id === "mcp-tools-list")?.ok, true);
  assert.equal(checks.find((check) => check.id === "mcp-read-only-smoke")?.ok, true);
  assert.equal(seen.length, 3);
  for (const request of seen) {
    assert.equal(request.headers.get("authorization"), "Bearer test-oauth-bearer");
    assert.equal(request.headers.get("mcp-protocol-version"), "2026-07-28");
    assert.equal(request.body.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  }
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
