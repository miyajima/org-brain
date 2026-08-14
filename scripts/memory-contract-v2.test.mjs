import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MEMORY_CONTRACT_V2_PROMPT_ID, MEMORY_CONTRACT_V2_VERIFIER_VERSION } from "../packages/shared/src/memory-contract-v2-runtime.mjs";
import { MEMORY_CONTRACT_V2_CONTRACT_HASH, MEMORY_CONTRACT_V2_PROMPT_HASH } from "../packages/shared/src/memory-contract-v2-contract.mjs";
import { MEMORY_CONTRACT_JUDGE_PROMPT_HASH } from "../packages/shared/src/memory-contract-judge.mjs";
import { handleLocalMcpRequest } from "../packages/orgbrain-cli/src/local-mcp.mjs";
import { buildMcpLearningBatchRequest } from "../packages/orgbrain-cli/src/hook-memory-bridge.mjs";
import { extractTaskCommitments, requestUserInputEvidenceDigest, TaskCommitmentStore } from "../packages/orgbrain-cli/src/lib/task-commitment-store.mjs";
import { verifyLearningEvent } from "../packages/orgbrain-cli/src/lib/memory-learning-transcript.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

function textResult(response) {
  return JSON.parse(response.content.find((item) => item.type === "text").text);
}

test("local MCP exposes the v2 contract, task context, and review-only batch path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orgbrain-contract-v2-"));
  try {
    const store = await new LocalMemoryStore(path.join(directory, "memory.sqlite")).init();
    const listed = await handleLocalMcpRequest(store, { method: "tools/list", params: {} });
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("orgbrain_task_context_get"));
    assert.ok(names.includes("orgbrain_learning_batch_ingest"));

    const observed = await handleLocalMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "orgbrain_memory_observe",
        arguments: {
          record_type: "learning_observation",
          schema_version: 2,
          lesson_type: "decision",
          capture_intent: "verify",
          trigger: "explicit user choice",
          applicability: { target_files: ["docs/MEMORY_CONTRACT_V2.md"], components: ["hooks"] },
          decision_type: "user_choice",
          decision_key: "agent_rollout",
          question: "どのAgentから認証しますか？",
          selected_value: "Codex先行",
          rationale: null,
          constraints: [],
          alternatives: [],
          evidence_selectors: [{ type: "user_statement", ref: "Codex先行", supports: ["selected_value"] }],
          gaps: []
        }
      }
    });
    assert.equal(textResult(observed).accepted, true);

    const promptHash = MEMORY_CONTRACT_V2_PROMPT_HASH;
    const batch = await handleLocalMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "orgbrain_learning_batch_ingest",
        arguments: {
          tenant_id: "default",
          project_id: "org-brain",
          task_key: "codex:contract-test",
          prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
          prompt_hash: promptHash,
          contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
          verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
          review_candidates: [{
            external_key: "review:contract-test",
            observation: { lesson_type: "success", gaps: ["missing outcome"] },
            reason_codes: ["gaps_present"]
          }]
        }
      }
    });
    assert.equal(textResult(batch).review_inserted, 1);
    assert.equal((await store.search({ tenant_id: "default", project_id: "org-brain", query: "missing outcome", limit: 10 })).length, 0);
    const outbox = await new TaskCommitmentStore(store.dbPath).saveLearningOutbox({
      tenantId: "default",
      payload: { id: "learning:retry-1", params: { name: "orgbrain_learning_batch_ingest" } }
    });
    assert.equal(outbox.saved, true);

    const context = await handleLocalMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "orgbrain_task_context_get",
        arguments: { tenant_id: "default", project_id: "org-brain", task_key: "codex:contract-test" }
      }
    });
    assert.deepEqual(textResult(context).commitments, []);

    const pendingBatch = await handleLocalMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "orgbrain_learning_batch_ingest",
        arguments: {
          tenant_id: "default",
          project_id: "org-brain",
          task_key: "codex:contract-test",
          prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
          prompt_hash: promptHash,
          contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
          verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
          deterministically_verified_items: [{
            external_key: "learning:deterministic-only",
            learning: {
              schema_version: 2,
              lesson_type: "success",
              capture_intent: "verify",
              procedure: "Run the verified command",
              why_it_worked: "The command used the supported runtime",
              observed_outcome: "The command exited successfully",
              reuse_when: "Use for this project runtime"
            },
            verification: { state: "verified" },
            evidence: [{ type: "command", ref: "rtk node --version" }]
          }]
        }
      }
    });
    assert.equal(textResult(pendingBatch).verified_inserted, 0);
    assert.equal(textResult(pendingBatch).review_inserted, 1);
    const candidateId = textResult(pendingBatch).review_candidates[0].id;
    const judgeConsensus = {
      judgments: [
        { judge_name: "evidence_entailment", model_family: "family-a", verdict: "pass", prompt_hash: MEMORY_CONTRACT_JUDGE_PROMPT_HASH },
        { judge_name: "durability_atomicity", model_family: "family-b", verdict: "pass", prompt_hash: MEMORY_CONTRACT_JUDGE_PROMPT_HASH },
        { judge_name: "future_reuse_overgeneralization", model_family: "family-a", verdict: "pass", prompt_hash: MEMORY_CONTRACT_JUDGE_PROMPT_HASH }
      ]
    };
    const promotedBatch = await handleLocalMcpRequest(store, {
      method: "tools/call",
      params: {
        name: "orgbrain_learning_batch_ingest",
        arguments: {
          tenant_id: "default",
          project_id: "org-brain",
          task_key: "codex:contract-test",
          contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
          prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
          prompt_hash: promptHash,
          verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
          verified_items: [{
            candidate_id: candidateId,
            external_key: "learning:deterministic-only",
            content: "The verified command completed successfully.",
            summary: "Verified command success",
            kind: "fact",
            created_at: Date.now(),
            evidence: [{ type: "command", ref: "rtk node --version" }],
            verification: { state: "verified", verified_at: Date.now(), attestation_ref: "test:command" },
            capture_origin: "observed",
            ai_certification: "ai_consensus_certified",
            judge_consensus: judgeConsensus,
            learning: {
              schema_version: 2,
              lesson_type: "success",
              capture_intent: "verify",
              procedure: "Run the verified command",
              why_it_worked: "The command used the supported runtime",
              observed_outcome: "The command exited successfully",
              reuse_when: "Use for this project runtime",
              contract_metadata: { candidate_id: candidateId }
            }
          }]
        }
      }
    });
    assert.equal(textResult(promotedBatch).verified_inserted, 1);
    assert.equal((await store.search({ tenant_id: "default", project_id: "org-brain", query: "verified command success", limit: 10 })).length, 1);
    const rejected = await handleLocalMcpRequest(store, {
        method: "tools/call",
        params: {
          name: "orgbrain_learning_batch_ingest",
          arguments: {
            tenant_id: "default",
            prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
            prompt_hash: promptHash,
            contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
            verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
            verified_items: [{ verification: { state: "verified" }, evidence: [{ type: "command", ref: "x" }] }]
          }
        }
      });
    assert.equal(rejected.isError, true);
    assert.match(textResult(rejected).error, /ai_consensus_certified judges/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task commitments are never persisted without a task identity", () => {
  const commitments = extractTaskCommitments({
    tool_name: "request_user_input",
    cwd: "/tmp/org-brain",
    tool_input: {
      questions: [{ id: "rollout", question: "どの方式ですか？", options: [{ id: "a", label: "A" }] }]
    },
    tool_result: { answers: { rollout: "A" } }
  });
  assert.deepEqual(commitments, []);
});

test("Codex learning batches carry the exact shared prompt and verifier identity", () => {
  const request = buildMcpLearningBatchRequest("default", "codex", {
    projectId: "org-brain",
    taskKey: "codex:hash-test",
    reviewCandidates: [{ external_key: "review:hash-test" }]
  });
  const args = request.params.arguments;
  const expectedHash = MEMORY_CONTRACT_V2_PROMPT_HASH;
  assert.equal(args.prompt_contract_id, MEMORY_CONTRACT_V2_PROMPT_ID);
  assert.equal(args.prompt_hash, expectedHash);
  assert.equal(args.contract_hash, MEMORY_CONTRACT_V2_CONTRACT_HASH);
  assert.equal(args.verifier_version, MEMORY_CONTRACT_V2_VERIFIER_VERSION);
  assert.equal(args.review_candidates[0].prompt_hash, expectedHash);
  const certified = buildMcpLearningBatchRequest("default", "codex", {
    aiCertifiedRecords: [{
      external_key: "learning:certified",
      content: "verified",
      candidate_id: "learning-candidate:1",
      learning: { schema_version: 2, contract_metadata: {} },
      ai_certification: "ai_consensus_certified",
      judge_consensus: { judgments: [] }
    }]
  });
  assert.equal(certified.params.arguments.verified_items[0].candidate_id, "learning-candidate:1");
  assert.equal(certified.params.arguments.verified_items[0].learning.contract_metadata.candidate_id, "learning-candidate:1");
});

test("v2 decision evidence matches the exact request_user_input result digest", async () => {
  const input = {
    questions: [{
      id: "agent_rollout",
      question: "どのAgentから認証しますか？",
      options: [{ id: "codex_first", label: "Codex先行" }]
    }]
  };
  const result = { answers: { agent_rollout: "Codex先行" } };
  const event = {
    record_type: "learning_observation",
    schema_version: 2,
    lesson_type: "decision",
    capture_intent: "verify",
    trigger: "explicit answer",
    applicability: { target_files: ["docs/MEMORY_CONTRACT_V2.md"], components: ["hooks"] },
    evidence_selectors: [{ type: "tool_result", digest: requestUserInputEvidenceDigest(input, result), supports: ["selected_value"] }],
    gaps: [],
    kind: "decision",
    conclusion: "Codex先行",
    rationale: null,
    reuse_rule: "Reuse this task commitment",
    outcome: "Codex先行",
    decision_type: "user_choice",
    decision_key: "agent_rollout",
    question: "どのAgentから認証しますか？",
    selected_value: "Codex先行",
    decision: null,
    constraints: [],
    alternatives: []
  };
  const verification = await verifyLearningEvent(event, {
    rows: [{
      type: "mcp_tool_call_end",
      invocation: { tool: "request_user_input", arguments: input },
      result: { Ok: result }
    }],
    userText: "",
    toolResults: "not used",
    workspaceRoot: process.cwd()
  });
  assert.equal(verification.verification_state, "verified");
  assert.deepEqual(verification.reason_codes, []);
});

test("v2 command evidence uses the normalized command hash rather than a substring", async () => {
  const baseEvent = {
    record_type: "learning_observation",
    schema_version: 2,
    lesson_type: "decision",
    capture_intent: "verify",
    trigger: "explicit answer",
    applicability: { target_files: ["docs/MEMORY_CONTRACT_V2.md"], components: ["hooks"] },
    evidence_selectors: [
      { type: "command", ref: "rtk node --version", supports: ["decision"] },
      { type: "user_statement", ref: "Codex先行", supports: ["selected_value"] }
    ],
    gaps: [],
    decision_type: "user_choice",
    decision_key: "agent_rollout",
    question: "どのAgentから認証しますか？",
    selected_value: "Codex先行",
    rationale: null,
    constraints: [],
    alternatives: []
  };
  const mismatched = await verifyLearningEvent(baseEvent, {
    rows: [
      { type: "custom_tool_call", name: "exec_command", call_id: "1", arguments: JSON.stringify({ cmd: "rtk node --version --extra" }) },
      { type: "custom_tool_call_output", call_id: "1", output: "Process exited with code 0" }
    ],
    userText: "Codex先行",
    workspaceRoot: process.cwd()
  });
  assert.notEqual(mismatched.verification_state, "verified");
  assert.ok(mismatched.reason_codes.includes("command_not_observed"));

  const exact = await verifyLearningEvent(baseEvent, {
    rows: [
      { type: "custom_tool_call", name: "exec_command", call_id: "1", arguments: JSON.stringify({ cmd: "rtk node --version" }) },
      { type: "custom_tool_call_output", call_id: "1", output: "Process exited with code 0" }
    ],
    userText: "Codex先行",
    workspaceRoot: process.cwd()
  });
  assert.equal(exact.verification_state, "verified");
});
