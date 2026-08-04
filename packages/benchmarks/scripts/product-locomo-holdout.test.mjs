import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLocomo, runLocomoRetrieval } from "./product-locomo-holdout.mjs";

test("normalizeLocomo maps dialog evidence to its containing session", () => {
  const rows = normalizeLocomo(JSON.stringify([{
    sample_id: "sample-a",
    conversation: {
      session_1_date_time: "1:00 pm on 1 January, 2025",
      session_1: [{ speaker: "A", text: "I adopted a cat.", dia_id: "D1:1" }],
      session_2_date_time: "2:00 pm on 2 January, 2025",
      session_2: [{ speaker: "B", text: "Nice.", dia_id: "D2:1" }]
    },
    qa: [{
      question: "What pet was adopted?",
      category: 1,
      evidence: ["D1:1", "D1:2"]
    }]
  }]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].expected_session_ids, ["session_1"]);
  assert.match(rows[0].sessions[0].content, /Session date:/u);
});

test("runLocomoRetrieval does not pass evaluation labels into capture or search", async () => {
  const captured = [];
  let searchInput;
  const store = {
    async capture(input) {
      captured.push(input);
    },
    async retrieveContext(input) {
      searchInput = input;
      return {
        results: [{
          memory: {
            source_references: [{ type: "session", ref: "session_1" }]
          }
        }],
        evidence_bundle: { estimated_tokens: 10 }
      };
    }
  };
  const result = await runLocomoRetrieval({
    tenant_id: "tenant-a",
    question: "What pet was adopted?",
    sessions: [{ source_id: "session_1", content: "A: I adopted a cat." }]
  }, { store, topK: 5 });
  assert.deepEqual(result.source_ids, ["session_1"]);
  assert.equal(captured.length, 1);
  assert.equal(searchInput.query, "What pet was adopted?");
  for (const payload of [...captured, searchInput]) {
    assert.equal("evaluation_id" in payload, false);
    assert.equal("expected_session_ids" in payload, false);
    assert.equal("evidence" in payload && Array.isArray(payload.evidence) && payload.evidence.length > 0, false);
  }
});
