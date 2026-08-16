import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateClientInstallation,
  cloudHooksPlan,
  codexMinimalHooksPlan,
  connectorPlan,
  cursorSupportsUserHooks,
  installCloudHooks,
  installCodexMinimalHooks,
  hookSetupApprovalSummary,
  mergeClaudeHooks,
  mergeCursorHooks,
  preflightCloudHooks,
  requireHookSetupApproval,
  remoteMcpPlan,
  runConnectorCommand
} from "../packages/orgbrain-cli/src/connector-setup.mjs";

test("activation binds the enrollment code to the selected client type", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      ok: true,
      data: { id: "install-codex", tenant_id: "default", client_type: "codex" }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.doesNotReject(activateClientInstallation({
      url: "https://mcp.example.test/mcp",
      clientId: "client-id",
      clientSecret: "client-secret",
      enrollmentCode: "obi_once",
      clientType: "codex"
    }));
    assert.deepEqual(requestBody, { enrollment_code: "obi_once", client_type: "codex" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("connector plans use one local stdio MemoryStore server across supported agents", () => {
  const codex = connectorPlan("codex");
  assert.deepEqual(codex.args, ["mcp", "add", "orgbrain", "--", "orgbrain", "mcp"]);

  const claude = connectorPlan("claude", { scope: "project" });
  assert.deepEqual(claude.args, [
    "mcp",
    "add",
    "orgbrain",
    "--scope",
    "project",
    "--",
    "orgbrain",
    "mcp"
  ]);

  const opencode = connectorPlan("opencode");
  assert.equal(opencode.executable, "opencode2");
  assert.ok(opencode.args.includes("--global"));

  const openclaw = connectorPlan("openclaw", { command: "/opt/orgbrain" });
  assert.deepEqual(openclaw.config_merge.mcp.servers.orgbrain, {
    transport: "stdio",
    command: "/opt/orgbrain",
    args: ["mcp"]
  });
});

test("remote MCP plans use OAuth-capable client-native HTTP registration", () => {
  const codex = remoteMcpPlan("codex", {
    url: "https://mcp.example.test/mcp",
    tenantId: "team-a"
  });
  assert.deepEqual(codex.args, [
    "mcp", "add", "orgbrain", "--url", "https://mcp.example.test/mcp?tenant_id=team-a"
  ]);
  assert.deepEqual(codex.post_install.args, ["mcp", "login", "orgbrain"]);

  const claude = remoteMcpPlan("claude", { url: "https://mcp.example.test/mcp" });
  assert.deepEqual(claude.args, [
    "mcp", "add", "--transport", "http", "--scope", "user", "orgbrain",
    "https://mcp.example.test/mcp?tenant_id=default"
  ]);

  const cursor = remoteMcpPlan("cursor", { url: "https://mcp.example.test/mcp" });
  assert.equal(cursor.executable, "cursor");
  assert.match(cursor.args[1], /"url":"https:\/\/mcp\.example\.test\/mcp\?tenant_id=default"/u);
});

test("cloud hook dry-run never reads or displays setup secrets", async () => {
  const result = await runConnectorCommand("setup", ["claude"], {
    flags: new Set(),
    get: (name, fallback) => name === "--mode"
      ? "cloud-hooks"
      : name === "--url"
        ? "https://mcp.example.test/mcp"
        : fallback
  });
  assert.equal(result.dry_run, true);
  assert.equal(result.plan.llm_calls, 0);
  assert.equal(result.plan.hook_approval_required, true);
  assert.equal(result.plan.approval_flag, "--approve-hooks");
  assert.deepEqual(result.plan.hook_events, ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
  assert.deepEqual(result.plan.credentials_required, [
    "ORGBRAIN_SETUP_ACCESS_CLIENT_ID",
    "ORGBRAIN_SETUP_ACCESS_CLIENT_SECRET",
    "ORGBRAIN_SETUP_ENROLLMENT_CODE"
  ]);
  assert.doesNotMatch(JSON.stringify(result), /client-secret/u);
});

test("Claude cloud hooks use one private installation credential and preserve existing settings", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "orgbrain-cloud-hooks-"));
  const workspace = path.join(home, "workspace");
  const claudeDir = path.join(home, ".claude");
  await mkdir(workspace, { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, "settings.json"), JSON.stringify({
    permissions: { allow: ["Read"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-stop" }] }] }
  }));
  const plan = cloudHooksPlan("claude", {
    home,
    workspace,
    projectId: "example",
    tenantId: "default",
    installationId: "install-1",
    url: "https://mcp.example.test/mcp"
  });
  await installCloudHooks(plan, {
    url: "https://mcp.example.test/mcp",
    clientId: "client-id",
    clientSecret: "client-secret"
  });
  const settings = JSON.parse(await readFile(plan.files.hooks, "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Read"] });
  assert.ok(settings.hooks.Stop.flatMap((group) => group.hooks).some((hook) => hook.command === "existing-stop"));
  assert.equal(settings.hooks.Stop.flatMap((group) => group.hooks).filter((hook) => /hook claude-stop/u.test(hook.command)).length, 1);
  assert.ok(settings.hooks.SessionStart);
  assert.ok(settings.hooks.SessionEnd);
  const credentials = await readFile(plan.files.env, "utf8");
  assert.match(credentials, /ORGBRAIN_CLIENT_INSTALLATION_ID=install-1/u);
  assert.match(credentials, /ORGBRAIN_MCP_CLIENT_SECRET=client-secret/u);
  assert.equal((await stat(plan.files.env)).mode & 0o777, 0o600);
  assert.equal((await stat(plan.files.outbox)).mode & 0o777, 0o600);
});

test("cloud hook plans target supported lifecycle events", () => {
  const codex = cloudHooksPlan("codex", {
    home: "/tmp/orgbrain-codex-home",
    workspace: "/tmp/example",
    installationId: "install-codex",
    url: "https://mcp.example.test/mcp"
  });
  assert.deepEqual(Object.keys(codex.handlers), [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "Stop"
  ]);
  assert.equal(codex.handlers.PreToolUse.matcher, "request_user_input");
  assert.equal(codex.handlers.UserPromptSubmit.additionalContextLimit, 8_192);

  const plan = cloudHooksPlan("cursor", {
    home: "/tmp/orgbrain-cursor-home",
    workspace: "/tmp/example",
    installationId: "install-cursor",
    url: "https://mcp.example.test/mcp"
  });
  assert.equal(plan.files.hooks, "/tmp/orgbrain-cursor-home/.cursor/hooks.json");
  assert.deepEqual(Object.keys(plan.handlers), [
    "sessionStart", "beforeSubmitPrompt", "stop", "sessionEnd"
  ]);
  assert.equal(plan.handlers.stop.failClosed, false);
  assert.equal(cursorSupportsUserHooks("1.7.0\narm64\n"), true);
  assert.equal(cursorSupportsUserHooks("1.6.99\narm64\n"), false);
  assert.equal(cursorSupportsUserHooks("unknown"), false);
});

test("hook setup requires explicit approval and reports the exact mutation scope", async () => {
  const plan = codexMinimalHooksPlan({
    home: "/tmp/orgbrain-approval-home",
    workspace: "/tmp/example-repo",
    projectId: "example"
  });
  const summary = hookSetupApprovalSummary(plan);
  assert.equal(summary.hooks_file, "/tmp/orgbrain-approval-home/.codex/hooks.json");
  assert.ok(summary.events.includes("UserPromptSubmit"));
  assert.equal(summary.preserves_existing_hooks, true);

  const output = { write() {} };
  await assert.rejects(
    requireHookSetupApproval(plan, { answer: "no", output }),
    /explicit user approval was not granted/u
  );
  const interactive = await requireHookSetupApproval(plan, { answer: "yes", output });
  assert.equal(interactive.method, "interactive");
  const flagged = await requireHookSetupApproval(plan, { approved: true, output });
  assert.equal(flagged.method, "approve-hooks-flag");
});

test("Claude and Cursor cloud hook merges preserve settings and stay idempotent", () => {
  const claudeHandlers = cloudHooksPlan("claude", {
    home: "/tmp/orgbrain-claude-home",
    workspace: "/tmp/example",
    installationId: "install-claude"
  }).handlers;
  const existingClaude = JSON.stringify({
    permissions: { allow: ["Read"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-stop" }] }] }
  });
  const onceClaude = mergeClaudeHooks(existingClaude, claudeHandlers);
  const twiceClaude = JSON.parse(mergeClaudeHooks(onceClaude, claudeHandlers));
  assert.deepEqual(twiceClaude.permissions, { allow: ["Read"] });
  assert.equal(
    twiceClaude.hooks.Stop.flatMap((group) => group.hooks)
      .filter((hook) => /hook claude-stop/u.test(hook.command)).length,
    1
  );
  assert.ok(twiceClaude.hooks.Stop.flatMap((group) => group.hooks)
    .some((hook) => hook.command === "existing-stop"));

  const cursorHandlers = cloudHooksPlan("cursor", {
    home: "/tmp/orgbrain-cursor-home",
    workspace: "/tmp/example",
    installationId: "install-cursor"
  }).handlers;
  const existingCursor = JSON.stringify({
    version: 1,
    custom: true,
    hooks: { stop: [{ command: "existing-cursor-stop" }] }
  });
  const onceCursor = mergeCursorHooks(existingCursor, cursorHandlers);
  const twiceCursor = JSON.parse(mergeCursorHooks(onceCursor, cursorHandlers));
  assert.equal(twiceCursor.custom, true);
  assert.equal(twiceCursor.hooks.stop.filter((hook) => /hook cursor-stop/u.test(hook.command)).length, 1);
  assert.ok(twiceCursor.hooks.stop.some((hook) => hook.command === "existing-cursor-stop"));
});

test("cloud hook preflight validates local settings without writing installation files", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "orgbrain-cloud-preflight-"));
  const workspace = path.join(home, "workspace");
  const claudeDir = path.join(home, ".claude");
  await mkdir(workspace, { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, "settings.json"), "not-json");
  const plan = cloudHooksPlan("claude", {
    home,
    workspace,
    installationId: "preflight"
  });

  await assert.rejects(preflightCloudHooks(plan), /Unexpected token|JSON/u);
  await assert.rejects(stat(plan.files.env), { code: "ENOENT" });
});

test("connector setup is non-mutating unless execute is explicit", async () => {
  const result = await runConnectorCommand("setup", ["codex"], {
    flags: new Set(),
    get: (_name, fallback) => fallback
  });
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.plan.transport, "stdio");
});

test("hook-writing execute is blocked when the user has not approved it", async () => {
  await assert.rejects(
    runConnectorCommand("setup", ["codex"], {
      flags: new Set(["--execute"]),
      get: (name, fallback) => name === "--mode" ? "minimal-hooks" : fallback
    }, {
      hookApproval: { input: { isTTY: false }, output: { write() {} } }
    }),
    /requires user approval/u
  );
});

test("minimal Codex hook plan uses local commands without MCP, a daemon, or LLM calls", () => {
  const plan = codexMinimalHooksPlan({
    home: "/tmp/orgbrain-home",
    workspace: "/tmp/example-repo",
    projectId: "example"
  });

  assert.equal(plan.mode, "minimal-hooks");
  assert.equal(plan.local_only, true);
  assert.equal(plan.llm_calls, 0);
  assert.equal(plan.resident_process, false);
  assert.equal(plan.workspace.project_id, "example");
  assert.match(plan.handlers.UserPromptSubmit.command, /hook codex-context/u);
  assert.match(plan.handlers.Stop.command, /hook codex-stop/u);
  assert.doesNotMatch(plan.handlers.UserPromptSubmit.command, /\bmcp\b/u);
});

test("minimal hook plan can pin a stable hook runtime path", () => {
  const plan = codexMinimalHooksPlan({
    home: "/tmp/orgbrain-home",
    workspace: "/tmp/example-repo",
    cliPath: "/opt/orgbrain/local-memory.mjs"
  });
  assert.match(plan.handlers.UserPromptSubmit.command, /\/opt\/orgbrain\/local-memory\.mjs/u);
});

test("minimal Codex setup can include a reviewable daily personal maintenance plan", async () => {
  const result = await runConnectorCommand("setup", ["codex"], {
    flags: new Set(),
    get: (name, fallback) => name === "--mode"
      ? "minimal-hooks"
      : name === "--maintenance"
        ? "daily"
        : fallback
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.plan.hook_approval_required, true);
  assert.equal(result.plan.approval_flag, "--approve-hooks");
  assert.equal(result.plan.maintenance.schedule, "daily");
  assert.equal(result.plan.maintenance.llm_calls, 0);
  assert.equal(result.plan.maintenance.cloud_writes, 0);
  assert.equal(result.plan.maintenance.autonomous, true);
  assert.ok(result.plan.maintenance.program_arguments.includes("autonomy"));
  assert.ok(result.plan.maintenance.program_arguments.includes("--state-dir"));
  assert.ok(result.plan.maintenance.program_arguments.includes("--apply"));
});

test("minimal Codex setup can omit background maintenance", async () => {
  const result = await runConnectorCommand("setup", ["codex"], {
    flags: new Set(),
    get: (name, fallback) => name === "--mode"
      ? "minimal-hooks"
      : name === "--maintenance"
        ? "off"
        : fallback
  });
  assert.equal(result.dry_run, true);
  assert.equal(result.plan.maintenance, undefined);
});

test("minimal Codex hook installer preserves existing hooks and is idempotent", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "orgbrain-minimal-hooks-"));
  const workspace = path.join(home, "workspace");
  const codexDir = path.join(home, ".codex");
  await mkdir(workspace, { recursive: true });
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    path.join(codexDir, "hooks.json"),
    `${JSON.stringify({
      description: "existing",
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "existing-prompt-hook" }] }],
        Stop: [{ hooks: [{ type: "command", command: "existing-stop-hook" }] }]
      }
    }, null, 2)}\n`
  );

  const plan = codexMinimalHooksPlan({ home, workspace, projectId: "example" });
  await installCodexMinimalHooks(plan);
  await installCodexMinimalHooks(plan);

  const hooks = JSON.parse(await readFile(plan.files.hooks, "utf8"));
  const promptCommands = hooks.hooks.UserPromptSubmit.flatMap((group) => group.hooks).map((hook) => hook.command);
  const stopCommands = hooks.hooks.Stop.flatMap((group) => group.hooks).map((hook) => hook.command);
  assert.equal(promptCommands.filter((command) => command.includes("hook codex-context")).length, 1);
  assert.equal(stopCommands.filter((command) => command.includes("hook codex-stop")).length, 1);
  assert.ok(promptCommands.includes("existing-prompt-hook"));
  assert.ok(stopCommands.includes("existing-stop-hook"));

  const env = await readFile(plan.files.env, "utf8");
  assert.match(env, /ORGBRAIN_ENABLE_CLOUD_MEMORY=false/u);
  assert.match(env, /ORGBRAIN_ENABLE_ORG_SHARING=false/u);
  assert.match(env, /ORGBRAIN_LOCAL_HOOK_CAPTURE=true/u);
  assert.match(env, /ORGBRAIN_MEMORY_CAPTURE_V2_MODE=off/u);
  const mappings = JSON.parse(await readFile(plan.files.workspaces, "utf8"));
  assert.equal(mappings.version, 3);
  assert.equal(mappings.workspaces[workspace].tenant_id, null);
  assert.equal(mappings.workspaces[workspace].project_id, "example");
  assert.equal(mappings.workspaces[workspace].autonomy.mode, "shadow");
  assert.equal(mappings.workspaces[workspace].autonomy.target_mode, "autonomous");
  assert.equal((await stat(plan.files.env)).mode & 0o777, 0o600);
  assert.equal((await stat(plan.files.hooks)).mode & 0o777, 0o600);
  assert.equal((await stat(plan.files.workspaces)).mode & 0o777, 0o600);
  assert.equal((await stat(plan.files.errors)).mode & 0o777, 0o600);
  assert.equal((await stat(plan.files.db)).mode & 0o777, 0o600);
});

test("minimal Codex hook installer refuses to overwrite cloud mode without force", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "orgbrain-minimal-hooks-conflict-"));
  const envFile = path.join(home, ".config", "org-brain", "hooks.env");
  await mkdir(path.dirname(envFile), { recursive: true });
  await writeFile(envFile, "ORGBRAIN_ENABLE_CLOUD_MEMORY=true\n", { mode: 0o600 });
  await chmod(envFile, 0o600);
  const plan = codexMinimalHooksPlan({ home, workspace: path.join(home, "workspace") });

  await assert.rejects(
    installCodexMinimalHooks(plan),
    /ORGBRAIN_ENABLE_CLOUD_MEMORY is already true/u
  );
});

test("forced local-only setup removes active cloud credentials while keeping a backup", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "orgbrain-minimal-hooks-sanitize-"));
  const envFile = path.join(home, ".config", "org-brain", "hooks.env");
  await mkdir(path.dirname(envFile), { recursive: true });
  await writeFile(envFile, [
    "ORGBRAIN_ENABLE_CLOUD_MEMORY=true",
    "ORGBRAIN_MCP_URL=https://mcp.example.test/mcp",
    "ORGBRAIN_MCP_CLIENT_ID=client-id",
    "ORGBRAIN_MCP_CLIENT_SECRET=client-secret"
  ].join("\n") + "\n", { mode: 0o600 });
  const plan = codexMinimalHooksPlan({ home, workspace: path.join(home, "workspace") });
  const installed = await installCodexMinimalHooks(plan, { force: true });
  const active = await readFile(plan.files.env, "utf8");
  assert.doesNotMatch(active, /ORGBRAIN_MCP_|client-secret/u);
  assert.match(active, /ORGBRAIN_ENABLE_CLOUD_MEMORY=false/u);
  const backup = installed.backups.find((item) => item.startsWith(plan.files.env));
  assert.ok(backup);
  assert.match(await readFile(backup, "utf8"), /ORGBRAIN_MCP_CLIENT_SECRET=client-secret/u);
});
