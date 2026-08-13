import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodexMemoryContext } from "../packages/orgbrain-cli/src/codex-memory-context.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orgbrain-codex-context-"));
  await chmod(directory, 0o700);
  const workspace = path.join(directory, "project");
  const workspacesFile = path.join(directory, "workspaces.json");
  await writeFile(workspacesFile, JSON.stringify({
    version: 1,
    workspaces: { [workspace]: { tenant_id: null, project_id: "org-brain" } }
  }));
  const store = new LocalMemoryStore(path.join(directory, "memory.sqlite"));
  await store.capture({
    tenant_id: "default",
    project_id: "org-brain",
    kind: "decision",
    content: "Use the Codex notify and prompt hooks with a short-lived Node CLI. Avoid a resident MCP server and do not call an LLM from either hook.",
    summary: "Use short-lived Codex hooks instead of resident MCP or extra LLM calls. Contact user@example.com.",
    tags: ["codex", "hooks"],
    source: "test",
    external_key: "codex-hook-design"
  });
  return {
    workspace,
    workspacesFile,
    store,
    env: {
      ORGBRAIN_WORKSPACES_FILE: workspacesFile,
      ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
      ORGBRAIN_ENABLE_ORG_SHARING: "false"
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

test("Codex prompt hook injects only a bounded local summary for a relevant prompt", async () => {
  const ctx = await fixture();
  try {
    const result = await buildCodexMemoryContext({
      hook_event_name: "UserPromptSubmit",
      cwd: ctx.workspace,
      prompt: "How should Codex integrate OrgBrain without resident MCP or extra LLM calls?"
    }, ctx);
    assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(result.hookSpecificOutput.additionalContext, /short-lived Codex hooks/u);
    assert.match(result.hookSpecificOutput.additionalContext, /\[REDACTED_EMAIL\]/u);
    assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /user@example\.com/u);
    assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /Use the Codex notify and prompt hooks/u);
    assert.ok(result.hookSpecificOutput.additionalContext.length < 1_000);
  } finally {
    await ctx.cleanup();
  }
});

test("Codex prompt hook injects the hidden observe contract for continuation turns in learning mode", async () => {
  const ctx = await fixture();
  try {
    await writeFile(ctx.workspacesFile, JSON.stringify({
      version: 3,
      workspaces: {
        [ctx.workspace]: {
          tenant_id: "default",
          project_id: "org-brain",
          memory_learning_mode: "shadow"
        }
      }
    }));
    const result = await buildCodexMemoryContext({
      hook_event_name: "UserPromptSubmit",
      cwd: ctx.workspace,
      prompt: "continue"
    }, {
      ...ctx,
      env: { ...ctx.env, ORGBRAIN_ENABLE_CLOUD_MEMORY: "true" }
    });
    assert.match(result.hookSpecificOutput.additionalContext, /orgbrain_memory_observe/u);
    assert.match(result.hookSpecificOutput.additionalContext, /at most three times/u);
    assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /memory_id=/u);
  } finally {
    await ctx.cleanup();
  }
});

test("Codex prompt hook returns no context for acknowledgements, unrelated prompts, or cloud mode", async () => {
  const ctx = await fixture();
  try {
    assert.equal(await buildCodexMemoryContext({ hook_event_name: "UserPromptSubmit", cwd: ctx.workspace, prompt: "ありがとう" }, ctx), null);
    assert.equal(await buildCodexMemoryContext({ hook_event_name: "UserPromptSubmit", cwd: ctx.workspace, prompt: "What is the weather forecast for the mountain tomorrow?" }, ctx), null);
    assert.equal(await buildCodexMemoryContext({ hook_event_name: "UserPromptSubmit", cwd: ctx.workspace, prompt: "How should Codex integrate OrgBrain?" }, {
      ...ctx,
      env: { ...ctx.env, ORGBRAIN_ENABLE_CLOUD_MEMORY: "true" }
    }), null);
  } finally {
    await ctx.cleanup();
  }
});
