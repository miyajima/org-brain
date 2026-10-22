import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleLocalMcpRequest } from "../packages/orgbrain-cli/src/local-mcp.mjs";
import { collectVerifiedLearningEventsFromRows } from "../packages/orgbrain-cli/src/lib/memory-learning-transcript.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";

function successObservation() {
  return {
    record_type: "learning_observation",
    schema_version: 2,
    lesson_type: "success",
    capture_intent: "verify",
    trigger: "The bounded verification completed",
    applicability: { target_files: ["contract.mjs"], components: ["local MCP"] },
    evidence_selectors: [
      { type: "file", ref: "contract.mjs", supports: ["procedure"] },
      { type: "command", ref: "node --test scripts/memory-observe-routing.test.mjs", supports: ["observed_outcome"] }
    ],
    gaps: [],
    procedure: "Run MEMORY_CONTRACT_V2_SCHEMA_VERSION contract verification",
    why_it_worked: "The supported adapter preserved the contract input",
    observed_outcome: "The test completed successfully",
    reuse_when: "A local MCP caller supplies transport tenant routing"
  };
}

function textResult(response) {
  return JSON.parse(response.content.find((item) => item.type === "text").text);
}

async function observe(store, input) {
  const response = await handleLocalMcpRequest(store, {
    method: "tools/call",
    params: { name: "orgbrain_memory_observe", arguments: input }
  });
  return textResult(response);
}

function transcriptRows(input, output, turnId = "turn-routing") {
  return [
    { type: "turn_context", turn_id: turnId },
    { type: "function_call", call_id: "verify", name: "exec_command", arguments: JSON.stringify({ cmd: "node --test scripts/memory-observe-routing.test.mjs" }) },
    { type: "function_call_output", call_id: "verify", output: { exit_code: 0, output: "test evidence" } },
    { type: "function_call", call_id: "observe", name: "orgbrain_memory_observe", arguments: JSON.stringify(input) },
    { type: "function_call_output", call_id: "observe", output: JSON.stringify(output) }
  ];
}

function incompleteTranscriptRows(input, turnId) {
  return [
    { type: "turn_context", turn_id: turnId },
    { type: "function_call", call_id: "observe", name: "orgbrain_memory_observe", arguments: JSON.stringify(input) }
  ];
}

async function createFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orgbrain-memory-observe-routing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspaceRoot = path.join(directory, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(path.join(workspaceRoot, "contract.mjs"), "export const MEMORY_CONTRACT_V2_SCHEMA_VERSION = 2;\n");
  execFileSync("git", ["init", "-q"], { cwd: workspaceRoot });
  execFileSync("git", ["add", "contract.mjs"], { cwd: workspaceRoot });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: workspaceRoot });
  const store = await new LocalMemoryStore(path.join(directory, "memory.sqlite"), { denseEmbeddingProvider: null }).init();
  return { store, workspaceRoot };
}

test("local MCP treats tenant_id as transport metadata while keeping other v2 fields strict", async (t) => {
  const { store } = await createFixture(t);
  const base = successObservation();
  const withoutTenant = await observe(store, base);
  const withTenant = await observe(store, { ...base, tenant_id: "tenant-routing" });
  const withUnknownField = await observe(store, { ...base, tenant_id: "tenant-routing", future_override: true });

  assert.equal(withoutTenant.accepted, true);
  assert.equal(withTenant.accepted, true);
  assert.equal(withTenant.event_hash, withoutTenant.event_hash);
  assert.equal(withUnknownField.accepted, false);
  assert.ok(withUnknownField.reason_codes.includes("unknown_field"));
});

test("tenant-routed transcript observations verify equivalently and explicit gaps remain held", async (t) => {
  const { store, workspaceRoot } = await createFixture(t);
  const base = successObservation();
  const tenantInput = { ...base, tenant_id: "tenant-routing" };
  const tenantOutput = await observe(store, tenantInput);
  const noTenantOutput = await observe(store, base);

  const tenantTranscript = await collectVerifiedLearningEventsFromRows(
    transcriptRows(tenantInput, tenantOutput), { turnId: "turn-routing", tenantId: "tenant-routing", workspaceRoot }
  );
  const noTenantTranscript = await collectVerifiedLearningEventsFromRows(
    transcriptRows(base, noTenantOutput), { turnId: "turn-routing", workspaceRoot }
  );
  assert.equal(tenantTranscript.events.length, 1);
  assert.equal(tenantTranscript.events[0].verification.verification_state, "verified");
  assert.equal(tenantTranscript.events[0].event_hash, noTenantTranscript.events[0].event_hash);

  for (const [expectedTenantId, reasonCode] of [
    ["other-tenant", "observe_tenant_scope_mismatch"],
    [undefined, "observe_tenant_scope_unavailable"]
  ]) {
    const outOfScope = await collectVerifiedLearningEventsFromRows(
      transcriptRows(tenantInput, tenantOutput, `turn-${reasonCode}`),
      { turnId: `turn-${reasonCode}`, tenantId: expectedTenantId, workspaceRoot }
    );
    assert.equal(outOfScope.events.length, 0);
    assert.ok(outOfScope.reviews.some((item) => item.reason_codes.includes(reasonCode)));
  }

  const incompleteSameTenant = await collectVerifiedLearningEventsFromRows(
    incompleteTranscriptRows(tenantInput, "turn-incomplete"),
    { turnId: "turn-incomplete", tenantId: "tenant-routing", workspaceRoot }
  );
  assert.equal(incompleteSameTenant.events.length, 0);
  assert.equal(incompleteSameTenant.reviews.length, 1);
  assert.ok(incompleteSameTenant.reviews[0].learning);
  assert.ok(!("tenant_id" in incompleteSameTenant.reviews[0].learning));
  assert.ok(!incompleteSameTenant.reviews[0].reason_codes.includes("unknown_field"));

  const incompleteMismatch = await collectVerifiedLearningEventsFromRows(
    incompleteTranscriptRows(tenantInput, "turn-incomplete-mismatch"),
    { turnId: "turn-incomplete-mismatch", tenantId: "other-tenant", workspaceRoot }
  );
  assert.equal(incompleteMismatch.events.length, 0);
  assert.ok(incompleteMismatch.reviews.some((item) => item.reason_codes.includes("observe_tenant_scope_mismatch")));

  const incompleteWithoutExpectedTenant = await collectVerifiedLearningEventsFromRows(
    incompleteTranscriptRows(tenantInput, "turn-incomplete-no-expected-tenant"),
    { turnId: "turn-incomplete-no-expected-tenant", workspaceRoot }
  );
  assert.equal(incompleteWithoutExpectedTenant.events.length, 0);
  assert.ok(incompleteWithoutExpectedTenant.reviews.some((item) => item.reason_codes.includes("observe_tenant_scope_unavailable")));

  const reviewInput = {
    record_type: "learning_observation",
    schema_version: 2,
    lesson_type: "success",
    capture_intent: "review",
    tenant_id: "tenant-routing",
    gaps: ["Independent verification is missing"]
  };
  const reviewOutput = await observe(store, reviewInput);
  const held = await collectVerifiedLearningEventsFromRows(
    transcriptRows(reviewInput, reviewOutput, "turn-review"), { turnId: "turn-review", tenantId: "tenant-routing", workspaceRoot }
  );
  assert.equal(reviewOutput.accepted, true);
  assert.ok(!(reviewOutput.reason_codes ?? []).includes("unknown_field"));
  assert.equal(held.events.length, 0);
  assert.ok(held.reviews.some((item) => item.reason_codes.includes("gaps_present")));
});
