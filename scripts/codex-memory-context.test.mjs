import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodexMemoryContext } from "../packages/orgbrain-cli/src/codex-memory-context.mjs";
import { MEMORY_CONTRACT_JUDGE_PROMPT_HASH } from "../packages/shared/src/memory-contract-judge.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { TaskCommitmentStore, guardCodexQuestion } from "../packages/orgbrain-cli/src/lib/task-commitment-store.mjs";

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
      env: {
        ...ctx.env,
        ORGBRAIN_ENABLE_CLOUD_MEMORY: "true",
        ORGBRAIN_LOCAL_CONTEXT_ENABLED: "true"
      }
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

test("Codex restores all explicit answers after compaction and blocks the same questions", async () => {
  const ctx = await fixture();
  try {
    const commitmentStore = new TaskCommitmentStore(ctx.store.dbPath);
    const questions = [
      {
        id: "agent_rollout",
        question: "どのAgentから共通契約を認証しますか？",
        options: [{ id: "codex_first", label: "Codex先行" }, { id: "all_agents", label: "全Agent同時" }]
      },
      {
        id: "review_policy",
        question: "品質判定に人間reviewerを必須にしますか？",
        options: [{ id: "ai_only", label: "AIのみ" }, { id: "human_required", label: "人間必須" }]
      },
      {
        id: "candidate_policy",
        question: "不完全な候補をどう扱いますか？",
        options: [{ id: "review_only", label: "review台帳のみ" }, { id: "active", label: "active化" }]
      }
    ];
    const postToolPayload = {
      hook_event_name: "PostToolUse",
      session_id: "continuity-session",
      cwd: ctx.workspace,
      project_id: "org-brain",
      tool_name: "request_user_input",
      tool_input: { questions },
      tool_result: {
        answers: {
          agent_rollout: "Codex先行",
          review_policy: "AIのみ",
          candidate_policy: "review台帳のみ"
        }
      }
    };
    const saved = await commitmentStore.ingestToolResult(postToolPayload, "default");
    assert.equal(saved.count, 3);
    const replayed = await commitmentStore.ingestToolResult(postToolPayload, "default");
    assert.equal(replayed.count, 3);
    assert.equal(replayed.commitments.every((item) => item.created === false && item.changed === false), true);

    const resumed = await buildCodexMemoryContext({
      hook_event_name: "PostCompact",
      session_id: "continuity-session",
      cwd: ctx.workspace,
      project_id: "org-brain"
    }, ctx);
    assert.equal(resumed.hookSpecificOutput.hookEventName, "PostCompact");
    assert.match(resumed.hookSpecificOutput.additionalContext, /decision_key=agent_rollout/u);
    assert.match(resumed.hookSpecificOutput.additionalContext, /decision_key=review_policy/u);
    assert.match(resumed.hookSpecificOutput.additionalContext, /decision_key=candidate_policy/u);
    assert.match(resumed.hookSpecificOutput.additionalContext, /Codex先行/u);
    assert.match(resumed.hookSpecificOutput.additionalContext, /AIのみ/u);
    assert.match(resumed.hookSpecificOutput.additionalContext, /review台帳のみ/u);

    for (const question of questions) {
      const guard = await guardCodexQuestion({
        ...postToolPayload,
        hook_event_name: "PreToolUse",
        tool_input: { questions: [question] }
      }, commitmentStore, "default");
      assert.equal(guard.allow, false);
      assert.equal(guard.reason, "task_commitment_already_answered");
    }
    const paraphrased = await guardCodexQuestion({
      ...postToolPayload,
      hook_event_name: "PreToolUse",
      tool_input: {
        questions: [{
          ...questions[0],
          question: "共通契約の認証を最初に行うAgentはどれですか？"
        }]
      }
    }, commitmentStore, "default");
    assert.equal(paraphrased.allow, false);
    assert.equal(paraphrased.reason, "task_commitment_already_answered");

    const aliasConsensus = {
      judgments: [
        { judge_name: "evidence_entailment", model_family: "family-a", verdict: "pass", prompt_hash: MEMORY_CONTRACT_JUDGE_PROMPT_HASH },
        { judge_name: "durability_atomicity", model_family: "family-b", verdict: "pass", prompt_hash: MEMORY_CONTRACT_JUDGE_PROMPT_HASH },
        { judge_name: "future_reuse_overgeneralization", model_family: "family-a", verdict: "pass", prompt_hash: MEMORY_CONTRACT_JUDGE_PROMPT_HASH }
      ]
    };
    const aliasSaved = await commitmentStore.saveSemanticAlias({
      tenantId: "default",
      projectId: "org-brain",
      taskKey: "codex:continuity-session",
      decisionKey: "agent_rollout",
      question: "Which agent authenticates the shared contract first?",
      judgeConsensus: aliasConsensus
    });
    assert.equal(aliasSaved.saved, true);
    const aliasGuard = await guardCodexQuestion({
      ...postToolPayload,
      hook_event_name: "PreToolUse",
      tool_input: {
        questions: [{
          id: "new_alias_id",
          question: "Which agent authenticates the shared contract first?",
          options: [{ id: "codex_first", label: "Codex先行" }, { id: "all_agents", label: "全Agent同時" }]
        }]
      }
    }, commitmentStore, "default");
    assert.equal(aliasGuard.allow, false);
    assert.equal(aliasGuard.reason, "ai_semantic_alias_already_answered");

    const activeCommitments = await commitmentStore.list({
      tenantId: "default",
      projectId: "org-brain",
      taskKey: "codex:continuity-session"
    });
    await commitmentStore.checkpoint({
      tenantId: "default",
      projectId: "org-brain",
      taskKey: "codex:continuity-session",
      payload: { commitments: activeCommitments }
    });
    const checkpoint = await commitmentStore.latestCheckpoint({
      tenantId: "default",
      projectId: "org-brain",
      taskKey: "codex:continuity-session"
    });
    assert.equal(checkpoint.payload.commitments.length, 3);

    const changed = await commitmentStore.ingestToolResult({
      ...postToolPayload,
      tool_result: {
        answers: {
          agent_rollout: "全Agent同時",
          review_policy: "AIのみ",
          candidate_policy: "review台帳のみ"
        }
      }
    }, "default");
    assert.equal(changed.commitments.find((item) => item.commitment.decision_key === "agent_rollout")?.changed, true);
    const afterChange = await commitmentStore.list({
      tenantId: "default",
      projectId: "org-brain",
      taskKey: "codex:continuity-session"
    });
    assert.equal(afterChange.filter((item) => item.decision_key === "agent_rollout").length, 1);
    assert.equal(afterChange.find((item) => item.decision_key === "agent_rollout")?.answer.label, "全Agent同時");

    const crossScope = await guardCodexQuestion({
      ...postToolPayload,
      hook_event_name: "PreToolUse",
      project_id: "other-project",
      tool_input: { questions: [questions[0]] }
    }, commitmentStore, "default");
    assert.equal(crossScope.allow, true);

    const crossTenant = await guardCodexQuestion({
      ...postToolPayload,
      hook_event_name: "PreToolUse",
      tool_input: { questions: [questions[0]] }
    }, commitmentStore, "other-tenant");
    assert.equal(crossTenant.allow, true);

    const missingTaskIdentity = await guardCodexQuestion({
      hook_event_name: "PreToolUse",
      cwd: ctx.workspace,
      project_id: "org-brain",
      tool_name: "request_user_input",
      tool_input: { questions: [questions[0]] }
    }, commitmentStore, "default");
    assert.equal(missingTaskIdentity.allow, true);
    assert.equal(missingTaskIdentity.reason, "task_identity_missing");
  } finally {
    await ctx.cleanup();
  }
});
