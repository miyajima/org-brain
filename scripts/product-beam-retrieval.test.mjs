import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBeamChat,
  runBeamRetrieval,
  seedBeamChat
} from "./product-beam-retrieval.mjs";

test("normalizeBeamChat flattens nested evidence labels and retains unscored abstention", () => {
  const normalized = normalizeBeamChat(
    JSON.stringify([{
      batch_number: 1,
      turns: [[
        { id: 10, role: "user", content: "The API is slow." },
        { id: 11, role: "assistant", content: "Add caching." }
      ]]
    }]),
    JSON.stringify({
      knowledge_update: [{
        question: "What changed?",
        source_chat_ids: {
          original_info: [10],
          updated_info: [[11]]
        }
      }],
      abstention: [{ question: "Unknown?" }]
    }),
    "7",
    "100K"
  );
  assert.equal(normalized.turns.length, 1);
  assert.deepEqual(normalized.turns[0].message_ids, ["10", "11"]);
  assert.deepEqual(normalized.questions[0].expected_message_ids, ["10", "11"]);
  assert.equal(normalized.questions[0].scorable, true);
  assert.equal(normalized.questions[1].scorable, false);
  assert.deepEqual(normalized.excluded_questions_by_category, { abstention: 1 });
});

test("BEAM runtime keeps scorer labels out of capture and search", async () => {
  const captures = [];
  let searchInput;
  const store = {
    async capture(input) {
      captures.push(input);
    },
    async search(input) {
      searchInput = input;
      return [{
        memory: {
          source_references: [{ type: "beam-message", ref: "10" }]
        }
      }];
    }
  };
  await seedBeamChat({
    tenant_id: "tenant-a",
    turns: [{
      source_id: "turn-1",
      message_ids: ["10"],
      content: "user: The API is slow."
    }]
  }, { store });
  const result = await runBeamRetrieval({
    tenant_id: "tenant-a",
    question: "What was slow?"
  }, { store, topK: 5 });
  assert.deepEqual(result.message_ids, ["10"]);
  assert.equal(searchInput.query, "What was slow?");
  assert.equal(searchInput.search_mode, "hybrid_v3");
  for (const payload of [...captures, searchInput]) {
    assert.equal("evaluation_id" in payload, false);
    assert.equal("expected_message_ids" in payload, false);
    assert.equal("source_chat_ids" in payload, false);
  }
});

test("normalizeBeamChat supports 10M plan-grouped batches", () => {
  const normalized = normalizeBeamChat(
    JSON.stringify([
      {
        "plan-1": [{
          batch_number: 1,
          turns: [[
            { id: 10, role: "user", content: "Grouped question" },
            { id: 11, role: "assistant", content: "Grouped answer" }
          ]]
        }]
      }
    ]),
    JSON.stringify({
      information_extraction: [{
        question: "What was answered?",
        source_chat_ids: [11]
      }]
    }),
    "1",
    "10M"
  );
  assert.equal(normalized.turns.length, 1);
  assert.deepEqual(normalized.turns[0].message_ids, ["10", "11"]);
});
