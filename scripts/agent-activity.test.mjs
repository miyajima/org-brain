import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  agentActivityFromHook,
  normalizeAgentActivity,
  normalizeOtlpActivities,
  scanActivitySecurity,
  validateActivityRules
} from "../packages/orgbrain-cli/src/lib/agent-activity.mjs";
import { connectorInventory } from "../packages/orgbrain-cli/src/lib/connector-inventory.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import {
  installMemorySkill,
  previewMemorySkill
} from "../packages/orgbrain-cli/src/lib/memory-skill.mjs";

const execFileAsync = promisify(execFile);
const CLI = new URL("../packages/orgbrain-cli/src/local-memory.mjs", import.meta.url).pathname;

function runCliWithInput(argv, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code === 0) resolve(result);
      else reject(new Error(`CLI exited ${code}: ${result.stderr}`));
    });
    child.stdin.end(input);
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-activity-test-"));
  await chmod(directory, 0o700);
  return {
    directory,
    dbPath: join(directory, "memory.sqlite"),
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function memoryInput(overrides = {}) {
  return {
    tenant_id: "default",
    project_id: "orgbrain",
    kind: "decision",
    lifecycle_state: "active",
    scope_type: "project",
    scope_key: "orgbrain",
    content: "Use metadata-only activity evidence for diagnosis.",
    summary: "Keep activity evidence metadata-only",
    tags: ["activity", "privacy"],
    source: "test",
    external_key: `activity-test:${crypto.randomUUID()}`,
    rationale: "Raw prompts, commands, paths, and outputs are unnecessary for diagnosis.",
    reuse_rule: "When recording agent activity, persist metadata and hashes only.",
    evidence: [],
    source_references: [],
    ...overrides
  };
}

test("agent-activity/v1 normalizes hook input without storing content", () => {
  const prompt = "customer password is secret";
  const command = "rm -rf /tmp/example";
  const output = "token=super-secret";
  const absolutePath = "/Users/example/private.txt";
  const event = normalizeAgentActivity({
    tenant_id: "default",
    project_id: "orgbrain",
    harness_name: "codex",
    collection_method: "hook",
    fidelity: "observed",
    action: "tool.completed",
    session_id: "session-1",
    tool_call_id: "call-1",
    tool_name: "exec_command",
    prompt,
    command,
    output,
    file_path: absolutePath,
    token_usage: { input: 120, output: 30, cache_read: 40, cache_write: 5 },
    result: { ok: true }
  });

  assert.equal(event.schema_version, "agent-activity/v1");
  assert.equal(event.action, "tool.completed");
  assert.equal(event.category, "command");
  assert.equal(event.content, null);
  assert.deepEqual(event.tokens, { input: 120, output: 30, cache_read: 40, cache_write: 5 });
  const serialized = JSON.stringify(event);
  for (const secret of [prompt, command, output, absolutePath, "super-secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(event.metadata.command_hash, /^[a-f0-9]{64}$/u);
  assert.match(event.metadata.file_path_hash, /^[a-f0-9]{64}$/u);
  assert.equal(event.metadata.result_status, "success");
});

test("harness hook fixtures normalize tool, file, approval, MCP, and token events", () => {
  const fixtures = [
    ["codex-pre-tool", { tool_name: "exec_command", tool_input: { command: "git status" } }, "command.requested", "command"],
    ["claude-pre-tool", { tool_name: "apply_patch", tool_input: { path: "/tmp/a" } }, "file.requested", "file"],
    ["cursor-pre-tool", { tool_name: "request_user_input" }, "approval.requested", "approval"],
    ["opencode-pre-tool", { tool_name: "mcp__orgbrain__memory_search" }, "mcp.tool_requested", "mcp"],
    ["codex-post-tool", { tool_name: "exec_command", usage: { input_tokens: 4, output_tokens: 2 } }, "command.completed", "command"]
  ];
  for (const [hook, payload, action, category] of fixtures) {
    const event = agentActivityFromHook({ hook, payload: { ...payload, session_id: "fixture", tool_call_id: hook } });
    assert.equal(event.action, action);
    assert.equal(event.category, category);
    assert.equal(event.harness_name, hook.split("-", 1)[0]);
  }
  const tokenEvent = agentActivityFromHook({
    hook: "codex-post-tool",
    payload: { tool_name: "exec_command", session_id: "fixture", tool_call_id: "token", usage: { input_tokens: 4, output_tokens: 2 } }
  });
  assert.deepEqual(tokenEvent.tokens, { input: 4, output: 2, cache_read: null, cache_write: null });
  const opaqueWrapper = agentActivityFromHook({
    hook: "codex-pre-tool",
    payload: { tool_name: "exec", session_id: "fixture", tool_call_id: "wrapper", tool_input: { code: "tools.exec_command({})" } }
  });
  assert.equal(opaqueWrapper.metadata.coverage, "opaque");
});

test("OTLP input normalizes model and token metadata without retaining the log body", () => {
  const body = "private OTLP log body 9127";
  const [event] = normalizeOtlpActivities({
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
      scopeLogs: [{ logRecords: [{
        timeUnixNano: "1760000000000000000",
        traceId: "trace-1",
        spanId: "span-1",
        body: { stringValue: body },
        attributes: [
          { key: "orgbrain.action", value: { stringValue: "model.completed" } },
          { key: "gen_ai.request.model", value: { stringValue: "gpt-test" } },
          { key: "gen_ai.system", value: { stringValue: "provider-test" } },
          { key: "gen_ai.usage.input_tokens", value: { intValue: 12 } },
          { key: "gen_ai.usage.output_tokens", value: { intValue: 3 } }
        ]
      }] }]
    }]
  }, { tenant_id: "default", project_id: "orgbrain" });
  assert.equal(event.collection_method, "otlp");
  assert.equal(event.model, "gpt-test");
  assert.deepEqual(event.tokens, { input: 12, output: 3, cache_read: null, cache_write: null });
  assert.equal(JSON.stringify(event).includes(body), false);
  assert.match(event.metadata.output_hash, /^[a-f0-9]{64}$/u);
});

test("activity storage deduplicates stable IDs, sequences sessions, searches, and summarizes", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const base = {
      tenant_id: "default",
      project_id: "orgbrain",
      harness_name: "codex",
      collection_method: "hook",
      fidelity: "observed",
      session_id: "session-1",
      occurred_at: "2026-09-24T00:00:00.000Z",
      tool_call_id: "call-1",
      action: "mcp.tool_invoked",
      tool_name: "mcp__orgbrain__memory_search"
    };
    const first = await store.recordActivity(base);
    const duplicate = await store.recordActivity(base);
    const second = await store.recordActivity({
      ...base,
      occurred_at: "2026-09-24T00:00:01.000Z",
      tool_call_id: "call-2",
      action: "approval.requested",
      tool_name: "request_user_input"
    });

    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.deduplicated, true);
    await assert.rejects(
      store.recordActivity({ ...base, output: "conflicting replay" }),
      /activity_source_conflict/u
    );
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal((await store.getActivity("default", first.id)).action, "mcp.tool_invoked");
    assert.equal((await store.searchActivity({ tenant_id: "default", action: "approval.requested" })).length, 1);
    const summary = await store.summarizeActivity({ tenant_id: "default", project_id: "orgbrain" });
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.by_fidelity, { observed: 2 });
    assert.deepEqual(summary.by_action, { "approval.requested": 1, "mcp.tool_invoked": 1 });
    assert.deepEqual(summary.coverage, {
      observable: 2,
      opaque: 0,
      missing: null,
      missing_reason: "expected_event_denominator_required"
    });
  } finally {
    await ctx.cleanup();
  }
});

test("activity database never persists prompt, command, path, or output bodies", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const secrets = [
      "private prompt fixture 7349",
      "private command fixture 7350",
      "/private/absolute/path/fixture-7351",
      "private output fixture 7352"
    ];
    await store.recordActivity({
      tenant_id: "default",
      project_id: "orgbrain",
      harness_name: "codex",
      collection_method: "hook",
      fidelity: "observed",
      action: "command.completed",
      session_id: "privacy-session",
      tool_call_id: "privacy-call",
      prompt: secrets[0],
      command: secrets[1],
      file_path: secrets[2],
      output: secrets[3]
    });
    for (const name of await readdir(ctx.directory)) {
      const bytes = await readFile(join(ctx.directory, name));
      for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `${name} contains raw content`);
    }
    const verification = await store.verify();
    assert.equal(verification.activity_event_count, 1);
    assert.equal(verification.activity_content_count, 0);
  } finally {
    await ctx.cleanup();
  }
});

test("activity CLI ingests and exposes a read-only timeline and summary", async () => {
  const ctx = await fixture();
  try {
    const payload = JSON.stringify({
      tenant_id: "default",
      project_id: "orgbrain",
      action: "mcp.tool_invoked",
      session_id: "cli-session",
      tool_call_id: "cli-call",
      tool_name: "mcp__orgbrain__memory_search"
    });
    const ingest = JSON.parse((await execFileAsync(process.execPath, [
      CLI, "activity", "ingest", "codex", payload, "--db", ctx.dbPath
    ])).stdout);
    assert.equal(ingest.content, null);

    const timeline = JSON.parse((await execFileAsync(process.execPath, [
      CLI, "activity", "timeline", "--session-id", "cli-session", "--db", ctx.dbPath
    ])).stdout);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].id, ingest.id);

    const summary = JSON.parse((await execFileAsync(process.execPath, [
      CLI, "activity", "summary", "--project-id", "orgbrain", "--db", ctx.dbPath
    ])).stdout);
    assert.equal(summary.total, 1);
    assert.equal(summary.by_category.mcp, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("Codex tool hooks record activity in the configured local database", async () => {
  const ctx = await fixture();
  try {
    const payload = {
      cwd: ctx.directory,
      project_id: "orgbrain",
      session_id: "hook-session",
      tool_call_id: "hook-call",
      tool_name: "mcp__orgbrain__memory_search",
      tool_input: { query: "private prompt text" }
    };
    await runCliWithInput(["hook", "codex-pre-tool"], JSON.stringify(payload), {
      ORGBRAIN_LOCAL_DB: ctx.dbPath,
      ORGBRAIN_MEMORY_COMMITMENTS_MODE: "off"
    });
    const store = new LocalMemoryStore(ctx.dbPath);
    const events = await store.searchActivity({ tenant_id: "default", session_id: "hook-session" });
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "mcp.tool_requested");
    assert.equal(JSON.stringify(events).includes("private prompt text"), false);
  } finally {
    await ctx.cleanup();
  }
});

test("memories accept only same-scope agent activity source references", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const event = await store.recordActivity({
      tenant_id: "default",
      project_id: "orgbrain",
      harness_name: "codex",
      collection_method: "hook",
      fidelity: "observed",
      session_id: "session-2",
      occurred_at: "2026-09-24T00:00:00.000Z",
      action: "file.modified",
      file_path: "/tmp/example.txt"
    });
    const capture = await store.capture(memoryInput({
      source_references: [{ type: "agent_activity", ref: `agent-activity:${event.id}` }]
    }));
    const memory = await store.get("default", capture.memory_id);
    assert.equal(memory.source_references[0].event_id, event.id);
    assert.equal(memory.source_references[0].fidelity, "observed");

    await assert.rejects(
      store.capture(memoryInput({
        external_key: "activity-test:missing",
        source_references: [{ type: "agent_activity", ref: "agent-activity:missing" }]
      })),
      /agent_activity_not_found/u
    );
    await assert.rejects(
      store.capture(memoryInput({
        project_id: "another-project",
        scope_key: "another-project",
        external_key: "activity-test:cross-project",
        source_references: [{ type: "agent_activity", ref: `agent-activity:${event.id}` }]
      })),
      /agent_activity_scope_mismatch/u
    );
  } finally {
    await ctx.cleanup();
  }
});

test("connector inventory distinguishes installed, configured, managed, and observed", async () => {
  const ctx = await fixture();
  try {
    const codex = join(ctx.directory, ".codex");
    await mkdir(codex, { recursive: true });
    await writeFile(join(codex, "hooks.json"), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: "orgbrain hook codex-pre-tool" }] }] }
    }));
    const store = new LocalMemoryStore(ctx.dbPath);
    await store.recordActivity({
      tenant_id: "default",
      project_id: "orgbrain",
      harness_name: "codex",
      collection_method: "hook",
      fidelity: "observed",
      session_id: "observed-session",
      occurred_at: new Date().toISOString(),
      action: "session.started"
    });
    const inventory = await connectorInventory({
      store,
      homeDir: ctx.directory,
      tenantId: "default",
      projectId: "orgbrain",
      executableLookup: async (name) => name === "codex"
    });
    const codexItem = inventory.connectors.find((item) => item.name === "codex");
    assert.deepEqual(
      { installed: codexItem.installed, configured: codexItem.configured, managed: codexItem.managed, observed: codexItem.observed },
      { installed: true, configured: true, managed: true, observed: true }
    );
    assert.ok(inventory.connectors.every((item) => !JSON.stringify(item).includes(ctx.directory)));
    const systemInventory = await connectorInventory({
      store,
      homeDir: ctx.directory,
      tenantId: "default",
      projectId: "orgbrain",
      runtimeScope: "system",
      executableLookup: async () => true
    });
    assert.ok(systemInventory.warnings.some((warning) => warning.code === "user_system_mode_mismatch"));
  } finally {
    await ctx.cleanup();
  }
});

test("activity security rules validate fixtures and detect dangerous metadata", () => {
  const validation = validateActivityRules();
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.ok(validation.fixture_total >= 20);
  assert.ok(validation.fixture_accuracy >= 0.95);
  assert.ok(validation.rules.every((rule) => ["experimental", "stable"].includes(rule.maturity)));
  const invalid = validateActivityRules([{ ...validation.rules[0], severity: "unknown" }]);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes("dangerous_recursive_delete:invalid_severity"));

  const dangerous = normalizeAgentActivity({
    tenant_id: "default",
    project_id: "orgbrain",
    harness_name: "codex",
    collection_method: "hook",
    fidelity: "observed",
    action: "command.executed",
    command: "rm -rf /tmp/example",
    session_id: "session-danger"
  });
  const benign = normalizeAgentActivity({
    tenant_id: "default",
    project_id: "orgbrain",
    harness_name: "codex",
    collection_method: "hook",
    fidelity: "observed",
    action: "command.executed",
    command: "git status --short",
    session_id: "session-safe"
  });
  assert.ok(scanActivitySecurity([dangerous]).some((finding) => finding.rule_id === "dangerous_recursive_delete"));
  assert.equal(scanActivitySecurity([benign]).length, 0);
});

test("memory skill preview requires approval and install never overwrites by default", async () => {
  const ctx = await fixture();
  try {
    const store = new LocalMemoryStore(ctx.dbPath);
    const unapprovedCapture = await store.capture(memoryInput({ external_key: "activity-test:unapproved" }));
    await assert.rejects(
      previewMemorySkill(store, { tenantId: "default", memoryId: unapprovedCapture.memory_id, projectRoot: ctx.directory }),
      /memory_not_approved/u
    );

    const approvedCapture = await store.capture(memoryInput({
      external_key: "activity-test:approved",
      evidence: [{ confirmation_state: "user_confirmed", evidence_ref: "test:approval" }]
    }));
    const preview = await previewMemorySkill(store, {
      tenantId: "default",
      memoryId: approvedCapture.memory_id,
      projectRoot: ctx.directory
    });
    assert.equal(preview.approved, true);
    assert.equal(preview.overwrites_existing, false);
    assert.match(preview.content, /Keep activity evidence metadata-only/u);
    assert.doesNotMatch(preview.path, /\.codex\/skills/u);

    const installed = await installMemorySkill(store, {
      tenantId: "default",
      memoryId: approvedCapture.memory_id,
      projectRoot: ctx.directory
    });
    assert.equal(installed.installed, true);
    assert.equal(await readFile(installed.path, "utf8"), preview.content);
    await assert.rejects(
      installMemorySkill(store, {
        tenantId: "default",
        memoryId: approvedCapture.memory_id,
        projectRoot: ctx.directory
      }),
      /skill_already_exists/u
    );
  } finally {
    await ctx.cleanup();
  }
});
