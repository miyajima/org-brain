import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodexMemoryContext } from "../packages/orgbrain-cli/src/codex-memory-context.mjs";
import { MEMORY_CONTRACT_JUDGE_PROMPT_HASH } from "../packages/shared/src/memory-contract-judge.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { installLocalDomainPack, upsertLocalDomainRecallUnit } from "../packages/orgbrain-cli/src/lib/local-domain-recall.mjs";
import { TaskCommitmentStore, guardCodexQuestion } from "../packages/orgbrain-cli/src/lib/task-commitment-store.mjs";
import {
  formatMemoryConfirmationContext,
  prepareMemoryConfirmationCandidates
} from "../packages/orgbrain-cli/src/lib/memory-confirmation-hints.mjs";

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
    work_type: "other",
    kind: "decision",
    content: "Use the Codex notify and prompt hooks with a short-lived Node CLI. Avoid a resident MCP server and do not call an LLM from either hook.",
    summary: "Use short-lived Codex hooks instead of resident MCP or extra LLM calls. Contact user@example.com.",
    tags: ["codex", "hooks"],
    source: "test",
    external_key: "codex-hook-design",
    confidence_score: 0.9,
    utility_score: 0.8
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
    assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /memory_id=/u);
    assert.match(result.hookSpecificOutput.additionalContext, /### 回答契約/u);
    assert.match(result.hookSpecificOutput.additionalContext, /結論を最初の2文以内/u);
    assert.ok(result.hookSpecificOutput.additionalContext.length < 2_000);
  } finally {
    await ctx.cleanup();
  }
});

test("Codex prompt hook provides complete use-tracking context when the workspace has no default work type", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.useHistory("configure", { mode: "c", collect: true, sync: false });
    const result = await buildCodexMemoryContext({
      hook_event_name: "UserPromptSubmit",
      session_id: "measured-context-session",
      cwd: ctx.workspace,
      prompt: "How should Codex integrate OrgBrain without resident MCP or extra LLM calls?"
    }, ctx);
    assert.match(result.hookSpecificOutput.additionalContext, /orgbrain_memory_observe/u);
    assert.match(result.hookSpecificOutput.additionalContext, /task_id=codex:measured-context-session/u);
    assert.match(result.hookSpecificOutput.additionalContext, /work_type=other/u);
  } finally {
    await ctx.cleanup();
  }
});

test("Codex prompt hook uses bounded transcript context and identity for a continuation prompt", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.useHistory("configure", { mode: "c", collect: true, sync: false });
    const transcriptPath = path.join(path.dirname(ctx.workspacesFile), "session.jsonl");
    const rows = [
      { type: "session_meta", payload: { id: "session-from-transcript" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex hooks should use a short-lived Node CLI without resident MCP or extra LLM calls." }] } },
      { type: "turn_context", payload: { turn_id: "turn-two", cwd: ctx.workspace } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "上記改善を実施して" }] } }
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const result = await buildCodexMemoryContext({
      hook_event_name: "UserPromptSubmit",
      cwd: ctx.workspace,
      prompt: "上記改善を実施して",
      transcript_path: transcriptPath,
      metadata: { turnId: "turn-two" }
    }, ctx);
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /short-lived Codex hooks/u);
    assert.match(context, /task_id=codex:transcript:[a-f0-9]{64}/u);
    assert.match(context, /Use tracking: receipt/u);
    assert.match(context, /materially informs a subsequent tool action/u);
    const db = ctx.store.open();
    const usage = db.prepare(
      "SELECT task_id, trace_id FROM memory_usage_events WHERE capability = 'hook_context' ORDER BY created_at DESC LIMIT 1"
    ).get();
    db.close();
    assert.match(usage.task_id, /^codex:transcript:[a-f0-9]{64}$/u);
    assert.equal(usage.trace_id, "turn-two");
  } finally {
    await ctx.cleanup();
  }
});

test("Codex prompt hook injects a business-readable Recall contract and visible provenance rule", async () => {
  const ctx = await fixture();
  try {
    const manifest = JSON.parse(await readFile(new URL("../domain-packs/first-party/build-engineering/manifest.json", import.meta.url), "utf8"));
    await installLocalDomainPack(ctx.store, "default", manifest);
    await upsertLocalDomainRecallUnit(ctx.store, "default", {
      id: "unit-build-hook", project_id: "org-brain", pack_id: manifest.pack_id,
      object_type_key: "repository", object_id: "checkout-web", intent_aliases: ["CI改善", "test削除"],
      scope: { repository: "checkout-web", pipeline: "ci-main" }, relation: "primary",
      decision: {
        source_type: "decision_memory", id: "DEC-BUILD-HOOK", statement: "runnerを2台増やしintegration testを4 shardへ分割する",
        rationale: "遅延の61%がrunner待ち", confirmation_state: "confirmed", valid_from: null, valid_until: null,
        rejected_alternatives: [{ statement: "testを削除", reason: "品質ガードを失う" }], constraints: [], success_conditions: []
      },
      metrics: [{ metric_key: "build_duration_p95", role: "outcome", value: 9.7, unit: "minutes", state: "measured", observed_at: Date.now(), expires_at: Date.now() + 60_000 }],
      evidence: [{ id: "ci-report-hook", title: "CI 7日間レポート", source: "GitHub Actions", resource_kind: "report", verification_state: "verified", observed_at: Date.now(), body: "never inject" }],
      workflow: "ci-bottleneck-diagnosis", follow_up: null, evidence_verified: true, metric_fresh: true
    });
    const result = await buildCodexMemoryContext({
      hook_event_name: "UserPromptSubmit", session_id: "recall-session", cwd: ctx.workspace,
      prompt: "checkout-webのCI改善でtest削除を検討している"
    }, {
      ...ctx,
      env: { ...ctx.env, DOMAIN_RECALL_MODE: "on", DOMAIN_RECALL_HOOK_MODE: "personal" }
    });
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /OrgBrainの記憶（回答用コンテキスト）/u);
    assert.match(context, /Decision: runnerを2台増やしintegration testを4 shardへ分割する/u);
    assert.match(context, /採用しなかった案[\s\S]*testを削除 — 品質ガードを失う/u);
    assert.match(context, /参照した記憶:/u);
    assert.match(context, /### 回答契約/u);
    assert.match(context, /結論を最初の2文以内/u);
    assert.match(context, /内部のmemory ID/u);
    assert.match(context, /orgbrain_domain_recall_feedback/u);
    assert.doesNotMatch(context, /recall_id=|candidate_id=/u);
    assert.doesNotMatch(context, /DEC-BUILD-HOOK|\/domain-recalls\//u);
    assert.doesNotMatch(context, /object_match|scope_match|Feedback: useful|build_duration_p95/u);
    assert.ok(context.length < 8_192);
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

test("Codex prompt hook explains eager gap capture without authorizing secret storage", async () => {
  const ctx = await fixture();
  try {
    await writeFile(ctx.workspacesFile, JSON.stringify({
      version: 3,
      workspaces: {
        [ctx.workspace]: {
          tenant_id: "default",
          project_id: "org-brain",
          memory_learning_mode: "eager"
        }
      }
    }));
    const result = await buildCodexMemoryContext({
      hook_event_name: "UserPromptSubmit",
      session_id: "eager-context",
      cwd: ctx.workspace,
      prompt: "Install TypeSafe AI and configure OpenRouter"
    }, ctx);
    const context = result.hookSpecificOutput.additionalContext;
    assert.equal(result.systemMessage, "OrgBrain: 関連記憶なし");
    assert.doesNotMatch(context, /OrgBrain: 関連記憶なし/u);
    assert.match(context, /OrgBrain eager learning is enabled/u);
    assert.match(context, /treat that as an internal status/u);
    assert.match(context, /do not narrate the miss/u);
    assert.doesNotMatch(context, /briefly tell the user/u);
    assert.match(context, /Never include API keys, tokens, passwords/u);
    assert.match(context, /do not perform an interactive memory write/u);
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

test("Codex prompt hook makes every configured remote-context failure observable", async () => {
  const ctx = await fixture();
  const payload = {
    hook_event_name: "UserPromptSubmit",
    session_id: "remote-context-failure",
    cwd: ctx.workspace,
    prompt: "Continue the current implementation using confirmed decisions"
  };
  const baseEnv = {
    ...ctx.env,
    ORGBRAIN_ENABLE_CLOUD_MEMORY: "true",
    ORGBRAIN_LOCAL_CONTEXT_ENABLED: "true",
    ORGBRAIN_MCP_URL: "https://hooks.example.test/mcp"
  };
  try {
    const incomplete = await buildCodexMemoryContext(payload, { ...ctx, env: baseEnv });
    assert.match(incomplete.hookSpecificOutput.additionalContext, /configuration_incomplete/u);

    const completeEnv = {
      ...baseEnv,
      ORGBRAIN_MCP_CLIENT_ID: "test-id",
      ORGBRAIN_MCP_CLIENT_SECRET: "test-secret",
      ORGBRAIN_CLIENT_INSTALLATION_ID: "test-installation"
    };
    const network = await buildCodexMemoryContext(payload, {
      ...ctx,
      env: completeEnv,
      fetchImpl: async () => { throw new Error("private detail must not leak"); }
    });
    assert.match(network.hookSpecificOutput.additionalContext, /network_or_timeout/u);
    assert.doesNotMatch(network.hookSpecificOutput.additionalContext, /private detail/u);

    const unavailable = await buildCodexMemoryContext(payload, {
      ...ctx,
      env: completeEnv,
      fetchImpl: async () => new Response("hidden upstream body", { status: 503 })
    });
    assert.match(unavailable.hookSpecificOutput.additionalContext, /http_503/u);
    assert.doesNotMatch(unavailable.hookSpecificOutput.additionalContext, /hidden upstream body/u);

    const malformed = await buildCodexMemoryContext(payload, {
      ...ctx,
      env: completeEnv,
      fetchImpl: async () => Response.json({ jsonrpc: "2.0", result: {} })
    });
    assert.match(malformed.hookSpecificOutput.additionalContext, /invalid_response/u);
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

test("memory confirmation candidates require complete durable evidence and exclude explicit user choices", () => {
  const complete = {
    external_key: "review:success",
    project_id: "org-brain",
    verification: { state: "verified" },
    observation: {
      schema_version: 2,
      lesson_type: "success",
      capture_intent: "verify",
      procedure: "Run the scoped migration",
      why_it_worked: "The command used api_key=secret-value with the supported schema",
      observed_outcome: "All rows migrated",
      reuse_when: "The same schema version is deployed",
      evidence_selectors: [{ type: "command", ref: "migration --check" }],
      gaps: []
    }
  };
  const explicitChoice = {
    external_key: "review:choice",
    verification: { state: "verified" },
    observation: {
      schema_version: 2,
      lesson_type: "decision",
      decision_type: "user_choice",
      selected_value: "Codex first",
      rationale: "The user selected it",
      evidence_selectors: [{ type: "user_statement", ref: "Codex first" }],
      gaps: []
    }
  };
  const inferredDecision = {
    external_key: "review:inferred-decision",
    project_id: "org-brain",
    verification: {
      verification_state: "partial",
      evidence: [{ type: "file", ref: "config.json" }, { type: "command", ref: "config check" }],
      reason_codes: ["decision_confirmation_evidence_required", "review_intent"]
    },
    observation: {
      schema_version: 2,
      lesson_type: "decision",
      capture_intent: "review",
      decision_type: "implementation",
      selected_value: "Use the bounded queue",
      rationale: "It prevents repeated prompts",
      evidence_selectors: [{ type: "file", ref: "config.json" }, { type: "command", ref: "config check" }],
      gaps: []
    }
  };
  const incompleteFailure = {
    external_key: "review:failure",
    verification: { state: "verified" },
    observation: {
      schema_version: 2,
      lesson_type: "failure",
      symptom: "The build failed",
      root_cause: "Unknown",
      correction: "Retry",
      verified_outcome: "Passed",
      avoidance_rule: "Retry later",
      evidence_selectors: [{ type: "command", ref: "build" }],
      gaps: []
    }
  };
  const candidates = prepareMemoryConfirmationCandidates([complete, explicitChoice, inferredDecision, incompleteFailure]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].category, "success");
  assert.equal(candidates[1].category, "decision");
  assert.match(candidates[0].reason, /\[REDACTED_SECRET\]/u);
  assert.doesNotMatch(JSON.stringify(candidates[0]), /secret-value/u);

  const bounded = prepareMemoryConfirmationCandidates(Array.from({ length: 4 }, (_, index) => ({
    ...complete,
    external_key: `review:bounded:${index}`,
    observation: {
      ...complete.observation,
      procedure: `${index}:${"p".repeat(500)}`,
      why_it_worked: "r".repeat(500),
      observed_outcome: "o".repeat(500),
      reuse_when: "u".repeat(500)
    }
  })));
  assert.equal(bounded.length, 3);
  const context = formatMemoryConfirmationContext(bounded.map((candidate, index) => ({
    ...candidate,
    id: `memory-confirmation:${String(index).repeat(40)}`,
    tenant_id: "default"
  })));
  assert.ok(Buffer.byteLength(context, "utf8") < 7_168);
});

test("Codex delivers durable memory confirmations once per session and records the answer without a task commitment", async () => {
  const ctx = await fixture();
  try {
    const mapping = JSON.parse(await readFile(ctx.workspacesFile, "utf8"));
    mapping.workspaces[ctx.workspace].memory_learning_mode = "on";
    await writeFile(ctx.workspacesFile, JSON.stringify(mapping));
    const commitmentStore = new TaskCommitmentStore(ctx.store.dbPath);
    const [candidate] = prepareMemoryConfirmationCandidates([{
      external_key: "review:failure:one",
      project_id: "org-brain",
      verification: { state: "verified" },
      observation: {
        schema_version: 2,
        lesson_type: "failure",
        capture_intent: "verify",
        symptom: "The release check failed",
        failed_approach: "Used an outdated manifest",
        root_cause: "The manifest digest did not match the deployed image",
        correction: "Updated the manifest to the deployed digest",
        verified_outcome: "The release check passed",
        avoidance_rule: "Read back the deployed digest before final inspection",
        evidence_selectors: [{ type: "command", ref: "release-check" }],
        gaps: []
      }
    }]);
    await commitmentStore.queueMemoryConfirmations({
      tenantId: "default",
      projectId: "org-brain",
      taskKey: "codex:memory-confirm-session",
      candidates: [candidate]
    });

    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "memory-confirm-session",
      cwd: ctx.workspace,
      project_id: "org-brain",
      prompt: "Continue with the release documentation"
    };
    const first = await buildCodexMemoryContext(payload, { ...ctx, commitmentStore });
    const context = first.hookSpecificOutput.additionalContext;
    assert.match(context, /OrgBrain memory confirmation/u);
    assert.match(context, /OrgBrainに保存する内容/u);
    assert.match(context, /どのカテゴリとして保存しますか/u);
    assert.match(context, /Do not use a question tool/u);
    assert.match(context, /orgbrain_memories_propose/u);
    assert.match(context, /orgbrain_memories_confirm/u);

    const questions = JSON.parse(context.match(/^questions=(.+)$/mu)[1]);
    const saved = await commitmentStore.ingestToolResult({
      ...payload,
      hook_event_name: "PostToolUse",
      tool_name: "request_user_input",
      tool_input: { questions },
      tool_result: { answers: { [questions[0].id]: "1" } }
    }, "default");
    assert.equal(saved.count, 0);
    assert.deepEqual(saved.memory_confirmations.map((item) => item.state), ["accepted"]);

    const second = await buildCodexMemoryContext(payload, { ...ctx, commitmentStore });
    assert.doesNotMatch(second?.hookSpecificOutput?.additionalContext ?? "", /OrgBrain memory confirmation/u);
  } finally {
    await ctx.cleanup();
  }
});

test("memory confirmation answers distinguish corrections from skips", async () => {
  const ctx = await fixture();
  try {
    const mapping = JSON.parse(await readFile(ctx.workspacesFile, "utf8"));
    mapping.workspaces[ctx.workspace].memory_learning_mode = "on";
    await writeFile(ctx.workspacesFile, JSON.stringify(mapping));
    const commitmentStore = new TaskCommitmentStore(ctx.store.dbPath);
    const candidates = prepareMemoryConfirmationCandidates(["alpha", "beta"].map((name) => ({
      external_key: `review:${name}`,
      project_id: "org-brain",
      verification: { state: "verified" },
      observation: {
        schema_version: 2,
        lesson_type: "success",
        capture_intent: "verify",
        procedure: `Run verifier ${name}`,
        why_it_worked: `Verifier ${name} checks the scoped artifact`,
        observed_outcome: `Verifier ${name} passed`,
        reuse_when: `Before release ${name}`,
        evidence_selectors: [{ type: "command", ref: `verify ${name}` }],
        gaps: []
      }
    })));
    await commitmentStore.queueMemoryConfirmations({
      tenantId: "default",
      projectId: "org-brain",
      taskKey: "codex:answer-kinds",
      candidates
    });
    const delivered = await commitmentStore.takeMemoryConfirmationBatch({
      tenantId: "default",
      projectId: "org-brain",
      taskKey: "codex:answer-kinds",
      deliverySessionKey: "codex:answer-kinds"
    });
    const context = formatMemoryConfirmationContext(delivered);
    const questions = JSON.parse(context.match(/^questions=(.+)$/mu)[1]);
    const result = await commitmentStore.ingestToolResult({
      session_id: "answer-kinds",
      project_id: "org-brain",
      tool_name: "request_user_input",
      tool_input: { questions },
      tool_result: {
        answers: {
          [questions[0].id]: "修正: 手順を修正版の検証コマンドに変更する",
          [questions[1].id]: "今回は保存しない"
        }
      }
    }, "default");
    assert.equal(result.count, 0);
    assert.deepEqual(result.memory_confirmations.map((item) => item.state).sort(), ["corrected", "rejected"]);
  } finally {
    await ctx.cleanup();
  }
});
