import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexMinimalHooksPlan,
  connectorPlan,
  installCodexMinimalHooks,
  runConnectorCommand
} from "../packages/orgbrain-cli/src/connector-setup.mjs";

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

test("connector setup is non-mutating unless execute is explicit", async () => {
  const result = await runConnectorCommand("setup", ["codex"], {
    flags: new Set(),
    get: (_name, fallback) => fallback
  });
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.plan.transport, "stdio");
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
  assert.equal(result.plan.maintenance.schedule, "daily");
  assert.equal(result.plan.maintenance.llm_calls, 0);
  assert.equal(result.plan.maintenance.cloud_writes, 0);
  assert.ok(result.plan.maintenance.program_arguments.includes("--apply"));
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
  assert.deepEqual(mappings.workspaces[workspace], {
    tenant_id: null,
    project_id: "example",
    business_category_id: null,
    default_work_type: null,
    sensitive_memory: { mode: "deny", allowed_principals: [] },
    memory_learning_mode: "off"
  });
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
