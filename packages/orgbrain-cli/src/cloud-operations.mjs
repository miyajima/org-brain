#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { remoteUrl } from "./connector-setup.mjs";

const D1_NAME = "open-brain";
const R2_BUCKET = "open-brain-bucket";
const QUEUES = [
  "org-bus",
  "org-bus-dlq",
  "cap-plan",
  "cap-plan-dlq",
  "orgbrain-retrieval-projection-v3",
  "orgbrain-retrieval-projection-v3-dlq"
];
const D1_CONFIGS = [
  "apps/api-gateway/wrangler.toml",
  "apps/org-router/wrangler.toml",
  "apps/cap-runner/wrangler.toml",
  "apps/orchestrator/wrangler.toml",
  "apps/retrieval-projector/wrangler.toml"
];

function command(cwd, ...args) {
  return { cwd, executable: "pnpm", args };
}

function managedOAuthInputs(options) {
  if (!options.withManagedOAuth) return null;
  const host = String(options.mcpHost ?? "").trim().toLowerCase();
  const accessPolicyId = String(options.accessPolicyId ?? "").trim();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host)) {
    throw new Error("--mcp-host must be a managed DNS hostname without a scheme or path");
  }
  if (!/^[a-f0-9-]{16,64}$/iu.test(accessPolicyId)) {
    throw new Error("--access-policy-id must identify an existing explicit Cloudflare Access policy");
  }
  return {
    host,
    endpoint: `https://${host}/mcp`,
    access_policy_id: accessPolicyId,
    access_application_domain: `${host}/mcp*`
  };
}

export function buildCloudProvisionPlan(options = {}) {
  const root = resolve(options.root || process.cwd());
  const managedOAuth = managedOAuthInputs(options);
  const wrangler = (...args) =>
    command("apps/api-gateway", "exec", "wrangler", ...args);
  const steps = [
    { id: "verify_identity", mutate: false, command: wrangler("whoami") },
    { id: "ensure_d1", mutate: true, command: wrangler("d1", "create", D1_NAME) },
    { id: "ensure_r2", mutate: true, command: wrangler("r2", "bucket", "create", R2_BUCKET) },
    ...QUEUES.map((name) => ({
      id: `ensure_queue_${name}`,
      mutate: true,
      command: wrangler("queues", "create", name)
    })),
    ...(options.withVectorize
      ? [{
          id: "ensure_vectorize",
          mutate: true,
          command: wrangler(
            "vectorize",
            "create",
            "orgbrain-memory-units-v3-1024",
            "--dimensions",
            "1024",
            "--metric",
            "cosine"
          )
        }, {
          id: "configure_vectorize_binding",
          mutate: true,
          local_action: "enable AI and MEMORY_VECTOR_INDEX_V3 bindings in apps/api-gateway/wrangler.toml"
        }]
      : []),
    {
      id: "apply_migrations",
      mutate: true,
      command: wrangler(
        "d1",
        "migrations",
        "apply",
        D1_NAME,
        "--remote",
        "--config",
        "wrangler.toml"
      )
    },
    {
      id: "deploy_cap_runner",
      mutate: true,
      command: command("apps/cap-runner", "exec", "wrangler", "deploy")
    },
    {
      id: "deploy_org_router",
      mutate: true,
      command: command("apps/org-router", "exec", "wrangler", "deploy")
    },
    {
      id: "deploy_retrieval_projector",
      mutate: true,
      command: command("apps/retrieval-projector", "exec", "wrangler", "deploy")
    },
    {
      id: "deploy_api_gateway",
      mutate: true,
      command: command("apps/api-gateway", "exec", "wrangler", "deploy")
    },
    {
      id: "deploy_mcp",
      mutate: true,
      command: managedOAuth
        ? command("apps/mcp", "exec", "wrangler", "deploy", "--route", `${managedOAuth.host}/*`)
        : command("apps/mcp", "exec", "wrangler", "deploy")
    },
    ...(managedOAuth ? [{
      id: "ensure_mcp_access_application",
      mutate: true,
      local_action: "create or update the self-hosted Access application with Managed OAuth and the supplied policy"
    }, {
      id: "configure_mcp_access_audience",
      mutate: true,
      local_action: "write the Access application audience to the API Gateway MCP_ACCESS_AUD secret"
    }] : []),
    {
      id: "build_console",
      mutate: false,
      command: command("apps/console", "build")
    },
    {
      id: "deploy_console",
      mutate: true,
      command: command("apps/console", "exec", "wrangler", "deploy")
    }
  ];
  return {
    version: 1,
    root,
    resources: {
      d1: D1_NAME,
      r2: R2_BUCKET,
      queues: QUEUES,
      vectorize: options.withVectorize ? "orgbrain-memory-units-v3-1024" : null,
      managed_oauth: managedOAuth
    },
    steps
  };
}

function run(commandSpec, root, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandSpec.executable, commandSpec.args, {
      cwd: resolve(root, commandSpec.cwd),
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: resolve(root, ".wrangler", "logs")
      },
      stdio: options.capture
        ? ["ignore", "pipe", "pipe"]
        : options.input !== undefined
          ? ["pipe", "inherit", "inherit"]
          : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (options.input !== undefined) {
      child.stdin?.end(String(options.input));
    }
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${commandSpec.executable} ${commandSpec.args.join(" ")} exited ${code}\n${stderr}`));
    });
  });
}

async function cloudflareApi(path, init = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required for Access provisioning");
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    const detail = Array.isArray(payload?.errors)
      ? payload.errors.map((item) => item?.message).filter(Boolean).join("; ")
      : `HTTP ${response.status}`;
    throw new Error(`Cloudflare API request failed: ${detail || `HTTP ${response.status}`}`);
  }
  return payload.result;
}

async function ensureManagedOAuth(root, config) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required for Access provisioning");
  const applications = await cloudflareApi(`/accounts/${accountId}/access/apps`);
  const existing = Array.isArray(applications)
    ? applications.find((item) => item?.domain === config.access_application_domain)
    : null;
  const body = {
    name: "OrgBrain Remote MCP",
    type: "self_hosted",
    domain: config.access_application_domain,
    session_duration: "24h",
    policies: [config.access_policy_id],
    oauth_configuration: { enabled: true }
  };
  const application = existing
    ? await cloudflareApi(`/accounts/${accountId}/access/apps/${existing.id}`, {
        method: "PUT",
        body: JSON.stringify(body)
      })
    : await cloudflareApi(`/accounts/${accountId}/access/apps`, {
        method: "POST",
        body: JSON.stringify(body)
      });
  if (!application?.aud) throw new Error("Cloudflare Access application did not return an audience");
  await run(
    command("apps/api-gateway", "exec", "wrangler", "secret", "put", "MCP_ACCESS_AUD"),
    root,
    { input: `${application.aud}\n` }
  );
  return { id: application.id, aud: application.aud, domain: application.domain };
}

function resourceMetadataUrl(header) {
  return header?.match(/resource_metadata="([^"]+)"/iu)?.[1] ?? null;
}

function authorizationMetadataUrl(issuer) {
  const url = new URL(issuer);
  if (url.pathname.includes("/.well-known/")) return url.toString();
  const issuerPath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  url.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  return url.toString();
}

export async function diagnoseRemoteMcp(rawUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = remoteUrl(rawUrl, null);
  const checks = [];
  let unauthenticated;
  try {
    unauthenticated = await fetchImpl(endpoint, { method: "GET", redirect: "manual" });
    checks.push({ id: "mcp-endpoint", ok: true, value: `${endpoint} (HTTP ${unauthenticated.status})` });
  } catch (error) {
    return [{
      id: "mcp-endpoint",
      ok: false,
      value: error instanceof Error ? error.message : String(error)
    }];
  }
  const authenticate = unauthenticated.headers.get("www-authenticate");
  const metadataUrl = resourceMetadataUrl(authenticate);
  checks.push({
    id: "mcp-managed-oauth-challenge",
    ok: unauthenticated.status === 401 && Boolean(metadataUrl),
    value: unauthenticated.status === 401
      ? metadataUrl ?? "WWW-Authenticate is missing resource_metadata"
      : `expected HTTP 401, received ${unauthenticated.status}`
  });
  let resourceMetadata = null;
  if (metadataUrl) {
    try {
      const response = await fetchImpl(metadataUrl, { headers: { accept: "application/json" } });
      resourceMetadata = await response.json();
      checks.push({
        id: "mcp-protected-resource-discovery",
        ok: response.ok && Array.isArray(resourceMetadata?.authorization_servers) && resourceMetadata.authorization_servers.length > 0,
        value: metadataUrl
      });
    } catch (error) {
      checks.push({
        id: "mcp-protected-resource-discovery",
        ok: false,
        value: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const issuer = resourceMetadata?.authorization_servers?.[0];
  if (issuer) {
    const url = authorizationMetadataUrl(issuer);
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json" } });
      const metadata = await response.json();
      checks.push({
        id: "mcp-authorization-server-discovery",
        ok: response.ok && Boolean(metadata?.authorization_endpoint) && Boolean(metadata?.token_endpoint),
        value: url
      });
    } catch (error) {
      checks.push({
        id: "mcp-authorization-server-discovery",
        ok: false,
        value: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const clientId = process.env.ORGBRAIN_MCP_CLIENT_ID?.trim();
  const clientSecret = process.env.ORGBRAIN_MCP_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) {
    const statusUrl = new URL(endpoint);
    statusUrl.pathname = `${statusUrl.pathname.replace(/\/+$/u, "")}/client-installations/status`;
    const response = await fetchImpl(statusUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "cf-access-client-id": clientId,
        "cf-access-client-secret": clientSecret
      }
    });
    checks.push({
      id: "mcp-service-token",
      ok: response.status !== 401 && response.status !== 403,
      value: `HTTP ${response.status}`
    });
    const deniedUrl = new URL(endpoint);
    deniedUrl.searchParams.set("tenant_id", "orgbrain-doctor-forbidden-tenant");
    const denied = await fetchImpl(deniedUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "cf-access-client-id": clientId,
        "cf-access-client-secret": clientSecret
      }
    });
    checks.push({ id: "mcp-tenant-denial", ok: denied.status === 403, value: `HTTP ${denied.status}` });
    const tools = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "cf-access-client-id": clientId,
        "cf-access-client-secret": clientSecret
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "orgbrain-doctor", method: "tools/list", params: {} })
    });
    const toolsBody = await tools.text();
    checks.push({
      id: "mcp-tool-call",
      ok: tools.ok && /(?:"tools"|event:\s*message)/u.test(toolsBody),
      value: `HTTP ${tools.status}`
    });
  } else {
    checks.push({
      id: "mcp-service-token",
      ok: false,
      severity: "warning",
      value: "not exercised; ORGBRAIN_MCP_CLIENT_ID/SECRET are unset"
    });
    checks.push({
      id: "mcp-tenant-denial",
      ok: false,
      severity: "warning",
      value: "not exercised without a service-token installation"
    });
    checks.push({
      id: "mcp-tool-call",
      ok: false,
      severity: "warning",
      value: "not exercised without a service-token installation"
    });
  }
  checks.push({
    id: "mcp-codex-user-oauth",
    ok: false,
    severity: "warning",
    value: "run `codex mcp login orgbrain`, then verify the server with `codex mcp list`"
  });
  checks.push({
    id: "mcp-expired-oauth-recovery",
    ok: false,
    severity: "warning",
    value: "requires an interactive client credential expiry/relogin exercise"
  });
  return checks;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function databaseIdFromConfig(text) {
  return text.match(/\bdatabase_id\s*=\s*"([^"]+)"/u)?.[1] ?? null;
}

function databaseIdFromList(value) {
  const rows = Array.isArray(value) ? value : value?.result;
  if (!Array.isArray(rows)) return null;
  const match = rows.find((row) => row?.name === D1_NAME || row?.database_name === D1_NAME);
  return match?.uuid ?? match?.id ?? null;
}

async function inspectLocalConfig(root) {
  const checks = [];
  const databaseNames = [];
  const configText = new Map();
  for (const relative of D1_CONFIGS) {
    const path = resolve(root, relative);
    const present = await exists(path);
    checks.push({ id: `config:${relative}`, ok: present, value: present ? "present" : "missing" });
    if (present) {
      const text = await readFile(path, "utf8");
      configText.set(relative, text);
      const databaseName = text.match(/\bdatabase_name\s*=\s*"([^"]+)"/u)?.[1] ?? null;
      const embeddedId = databaseIdFromConfig(text);
      checks.push({
        id: `d1-binding:${relative}`,
        ok: databaseName === D1_NAME && embeddedId === null,
        value: embeddedId ? "tracked database_id is forbidden" : databaseName ?? "missing"
      });
      if (databaseName) databaseNames.push(databaseName);
    }
  }
  checks.push({
    id: "d1-binding-consistency",
    ok: databaseNames.length === D1_CONFIGS.length && new Set(databaseNames).size === 1,
    value: [...new Set(databaseNames)]
  });
  const migrationsPath = resolve(root, "migrations");
  const migrationsPresent = await exists(migrationsPath);
  const migrationFiles = migrationsPresent
    ? (await readdir(migrationsPath)).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()
    : [];
  const migrationNumbers = migrationFiles.map((name) => Number(name.slice(0, 4)));
  // Wrangler assigns its own ledger IDs when multiple additive files share a
  // filename prefix. Validate the ordered number set rather than rejecting
  // intentional same-prefix migrations.
  const uniqueMigrationNumbers = [...new Set(migrationNumbers)];
  const migrationsContiguous =
    uniqueMigrationNumbers.length > 0 &&
    uniqueMigrationNumbers.every((number, index) => number === index + 1);
  checks.push({
    id: "migrations",
    ok:
      migrationsPresent &&
      migrationsContiguous &&
      (migrationNumbers.at(-1) ?? 0) >= 17,
    value: migrationsPresent ? migrationFiles.at(-1) ?? "empty" : "missing"
  });
  const apiConfig = configText.get("apps/api-gateway/wrangler.toml") ?? "";
  const routerConfig = configText.get("apps/org-router/wrangler.toml") ?? "";
  const runnerConfig = configText.get("apps/cap-runner/wrangler.toml") ?? "";
  const projectorConfig = configText.get("apps/retrieval-projector/wrangler.toml") ?? "";
  checks.push({
    id: "mcp-auth-rollout-mode",
    ok: /MCP_AUTH_MODE\s*=\s*"(?:dual|access)"/u.test(apiConfig),
    value: /MCP_AUTH_MODE\s*=\s*"access"/u.test(apiConfig) ? "access" : /MCP_AUTH_MODE\s*=\s*"dual"/u.test(apiConfig) ? "dual (one-release migration)" : "missing"
  });
  checks.push({
    id: "queue-topology",
    ok:
      /queue\s*=\s*"org-bus"/u.test(apiConfig) &&
      /queue\s*=\s*"org-bus"/u.test(routerConfig) &&
      /queue\s*=\s*"cap-plan"/u.test(routerConfig) &&
      /queue\s*=\s*"cap-plan"/u.test(runnerConfig),
    value: "org-bus -> org-router -> cap-plan -> cap-runner"
  });
  checks.push({
    id: "retrieval-projection-queue",
    ok:
      /queue\s*=\s*"orgbrain-retrieval-projection-v3"/u.test(apiConfig) &&
      /queue\s*=\s*"orgbrain-retrieval-projection-v3"/u.test(projectorConfig) &&
      /dead_letter_queue\s*=\s*"orgbrain-retrieval-projection-v3-dlq"/u.test(projectorConfig),
    value: "api-gateway -> retrieval-projector -> v3 Vectorize"
  });
  checks.push({
    id: "dead-letter-queues",
    ok:
      /dead_letter_queue\s*=\s*"org-bus-dlq"/u.test(routerConfig) &&
      /dead_letter_queue\s*=\s*"cap-plan-dlq"/u.test(runnerConfig),
    value: ["org-bus-dlq", "cap-plan-dlq"]
  });
  checks.push({
    id: "shared-r2-binding",
    ok:
      /bucket_name\s*=\s*"open-brain-bucket"/u.test(apiConfig) &&
      /bucket_name\s*=\s*"open-brain-bucket"/u.test(runnerConfig),
    value: R2_BUCKET
  });
  const canonicalUrl = process.env.ORGBRAIN_API_URL?.trim();
  const aliasUrl = process.env.ORGBRAIN_API_BASE?.trim();
  checks.push({
    id: "canonical-api-url",
    ok: Boolean(canonicalUrl || aliasUrl),
    severity: "warning",
    value: canonicalUrl
      ? "ORGBRAIN_API_URL"
      : aliasUrl
        ? "ORGBRAIN_API_BASE compatibility alias"
        : "unset"
  });
  return checks;
}

async function resolveProvisionedD1Id(root) {
  const list = await run(
    command("apps/api-gateway", "exec", "wrangler", "d1", "list", "--json"),
    root,
    { capture: true }
  );
  let id;
  try {
    id = databaseIdFromList(JSON.parse(list.stdout));
  } catch {
    throw new Error("wrangler d1 list did not return valid JSON");
  }
  if (!id) throw new Error(`D1 database "${D1_NAME}" was not found after provisioning`);
  return id;
}

async function enableVectorizeBindings(root) {
  const path = resolve(root, "apps/api-gateway/wrangler.toml");
  const current = await readFile(path, "utf8");
  const updated = current
    .replace(/^# \[ai\]$/mu, "[ai]")
    .replace(/^# binding = "AI"$/mu, 'binding = "AI"')
    .replace(/^# \[\[vectorize\]\]$/mu, "[[vectorize]]")
    .replace(/^# binding = "MEMORY_VECTOR_INDEX"$/mu, 'binding = "MEMORY_VECTOR_INDEX"')
    .replace(
      /^# index_name = "orgbrain-memory-384-cosine"$/mu,
      'index_name = "orgbrain-memory-384-cosine"'
    );
  if (!updated.includes("[ai]") || !updated.includes('binding = "MEMORY_VECTOR_INDEX"')) {
    throw new Error("apps/api-gateway/wrangler.toml does not contain the expected optional Vectorize binding block");
  }
  if (updated !== current) await writeFile(path, updated, "utf8");
}

async function resourceExists(commandSpec, root) {
  try {
    await run(commandSpec, root, { capture: true });
    return true;
  } catch {
    return false;
  }
}

async function executeProvision(plan, options = {}) {
  if (!process.env.CLOUDFLARE_API_TOKEN?.trim() || !process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required with --execute");
  }
  const root = plan.root;
  await run(plan.steps[0].command, root);
  let managedOAuth = null;

  const d1Exists = await resourceExists(
    command("apps/api-gateway", "exec", "wrangler", "d1", "info", D1_NAME, "--json"),
    root
  );
  if (!d1Exists) await run(plan.steps.find((step) => step.id === "ensure_d1").command, root);
  const d1Id = await resolveProvisionedD1Id(root);

  const r2Exists = await resourceExists(
    command("apps/api-gateway", "exec", "wrangler", "r2", "bucket", "info", R2_BUCKET),
    root
  );
  if (!r2Exists) await run(plan.steps.find((step) => step.id === "ensure_r2").command, root);

  for (const queue of QUEUES) {
    const queueExists = await resourceExists(
      command("apps/api-gateway", "exec", "wrangler", "queues", "info", queue),
      root
    );
    if (!queueExists) {
      await run(plan.steps.find((step) => step.id === `ensure_queue_${queue}`).command, root);
    }
  }

  if (options.withVectorize) {
    const vectorExists = await resourceExists(
      command("apps/api-gateway", "exec", "wrangler", "vectorize", "get", "orgbrain-memory-384-cosine"),
      root
    );
    if (!vectorExists) {
      await run(plan.steps.find((step) => step.id === "ensure_vectorize").command, root);
    }
    await enableVectorizeBindings(root);
  }

  if (options.withManagedOAuth) {
    managedOAuth = await ensureManagedOAuth(root, plan.resources.managed_oauth);
  }

  for (const step of plan.steps) {
    if (
      step.id === "verify_identity" ||
      step.id.startsWith("ensure_") ||
      step.local_action
    ) continue;
    await run(step.command, root);
  }
  return { ok: true, d1_database_id: d1Id, resources: plan.resources, managed_oauth: managedOAuth };
}

export async function runCloudCommand(action, args) {
  const root = resolve(args.get("--root", process.cwd()));
  if (action === "doctor") {
    const checks = await inspectLocalConfig(root);
    if (args.flags.has("--live")) {
      try {
        await run(command("apps/api-gateway", "exec", "wrangler", "whoami"), root, { capture: true });
        checks.push({ id: "cloudflare-authentication", ok: true, value: "verified" });
      } catch (error) {
        checks.push({
          id: "cloudflare-authentication",
          ok: false,
          value: error instanceof Error ? error.message : String(error)
        });
      }
      const mcpUrl = args.get("--mcp-url", process.env.ORGBRAIN_MCP_URL);
      if (mcpUrl) {
        checks.push(...await diagnoseRemoteMcp(mcpUrl));
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
        const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
        if (accountId && token) {
          try {
            const endpoint = remoteUrl(mcpUrl, null);
            const expectedDomain = `${new URL(endpoint).host}/mcp*`;
            const applications = await cloudflareApi(`/accounts/${accountId}/access/apps`);
            const application = Array.isArray(applications) ? applications.find((item) => item?.domain === expectedDomain) : null;
            checks.push({ id: "mcp-access-application", ok: Boolean(application), value: application?.id ?? expectedDomain });
            checks.push({ id: "mcp-access-managed-oauth", ok: application?.oauth_configuration?.enabled === true, value: application?.oauth_configuration?.enabled === true ? "enabled" : "disabled or missing" });
            checks.push({ id: "mcp-access-policy", ok: Array.isArray(application?.policies) && application.policies.length > 0, value: `${application?.policies?.length ?? 0} policies` });
          } catch (error) {
            checks.push({ id: "mcp-access-application", ok: false, value: error instanceof Error ? error.message : String(error) });
          }
          try {
            const secrets = await run(command("apps/api-gateway", "exec", "wrangler", "secret", "list", "--json"), root, { capture: true });
            const names = JSON.parse(secrets.stdout).map((item) => item.name);
            checks.push({ id: "mcp-access-audience-secret", ok: names.includes("MCP_ACCESS_AUD"), value: names.includes("MCP_ACCESS_AUD") ? "configured" : "missing" });
            checks.push({ id: "mcp-access-team-domain", ok: names.includes("ACCESS_TEAM_DOMAIN"), value: names.includes("ACCESS_TEAM_DOMAIN") ? "configured" : "missing" });
          } catch (error) {
            checks.push({ id: "mcp-worker-auth-settings", ok: false, value: error instanceof Error ? error.message : String(error) });
          }
        } else {
          checks.push({ id: "mcp-access-application", ok: false, severity: "warning", value: "not inspected; Cloudflare account/token are unset" });
          checks.push({ id: "mcp-worker-auth-settings", ok: false, severity: "warning", value: "not inspected; Cloudflare account/token are unset" });
        }
      }
      else checks.push({
        id: "mcp-endpoint",
        ok: false,
        value: "--mcp-url or ORGBRAIN_MCP_URL is required with --live"
      });
    }
    const errors = checks.filter((check) => !check.ok && check.severity !== "warning");
    return { ok: errors.length === 0, root, checks };
  }
  if (action === "provision") {
    const withVectorize = args.flags.has("--with-vectorize");
    const withManagedOAuth = args.flags.has("--with-managed-oauth");
    const plan = buildCloudProvisionPlan({
      root,
      withVectorize,
      withManagedOAuth,
      mcpHost: args.get("--mcp-host", null),
      accessPolicyId: args.get("--access-policy-id", null)
    });
    if (!args.flags.has("--execute")) return { ok: true, dry_run: true, plan };
    return executeProvision(plan, { withVectorize, withManagedOAuth });
  }
  throw new Error(`unknown cf command: ${action || "(missing)"}`);
}

async function main() {
  const raw = process.argv.slice(2);
  const positional = raw.filter((item) => !item.startsWith("--"));
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) continue;
    const [name, inline] = item.split("=", 2);
    if (["--live", "--execute", "--with-vectorize", "--with-managed-oauth"].includes(name)) flags.add(name);
    else values.set(name, inline ?? raw[++index]);
  }
  const result = await runCloudCommand(positional[0], {
    flags,
    get: (name, fallback) => values.get(name) ?? fallback
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("cloud-operations.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
