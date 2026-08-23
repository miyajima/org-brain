import assert from "node:assert/strict";
import test from "node:test";
import { AI_AUDIT_SCENARIOS, runLocalAiEvidenceAudit } from "./ai-evidence-audit.mjs";

test("AI evidence audit covers the required twelve scenarios three times", async () => {
  assert.equal(AI_AUDIT_SCENARIOS.length, 12);
  const result = await runLocalAiEvidenceAudit();
  assert.equal(result.summary.all_applicable_passed, true);
  assert.equal(result.scenarios.every((scenario) => scenario.runs.length === 3), true);
  assert.equal(result.scenarios.find((scenario) => scenario.id === "permission_boundary")
    .runs.every((run) => run.memory_ids.length === 0), true);
});
