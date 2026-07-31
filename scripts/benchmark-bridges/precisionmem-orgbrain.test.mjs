import assert from "node:assert/strict";
import test from "node:test";
import { createPrecisionMemOperations } from "./precisionmem-orgbrain.mjs";

test("PrecisionMem bridge keeps scorer labels out of capture and search", async () => {
  const captures = [];
  const searches = [];
  const store = {
    async capture(input) {
      captures.push(input);
    },
    async search(input) {
      searches.push(input);
      return [{
        score: { total: 0.9 },
        memory: { id: "belief-1", content: "Redis is the session store." }
      }];
    }
  };
  let resets = 0;
  const operations = createPrecisionMemOperations({
    store,
    reset: async () => {
      resets += 1;
    }
  });
  const reset = await operations.reset();
  assert.equal(reset.status, 200);
  assert.equal(resets, 1);

  const added = await operations.add({
    text: "redis Redis is the session store.",
    user_id: "user-a",
    metadata: { beliefId: "belief-1", scope: "domain:code" }
  });
  assert.equal(added.status, 200);

  const searched = await operations.search({
    query: "Redis session storage",
    user_id: "user-a",
    scope: "domain:code",
    limit: 20,
    shouldOnlyInclude: ["belief-1"],
    mustExclude: ["belief-2"]
  });
  assert.equal(searched.status, 200);
  assert.deepEqual(searched.body.results.map((item) => item.id), ["belief-1"]);
  assert.equal(captures.length, 1);
  assert.equal(searches.length, 1);
  assert.equal(captures[0].tenant_id, "user-a");
  assert.equal(captures[0].project_id, "domain:code");
  assert.equal(searches[0].tenant_id, "user-a");
  assert.equal(searches[0].project_id, "domain:code");
  assert.equal(searches[0].minimum_total_score, 0.065);
  assert.equal("shouldOnlyInclude" in searches[0], false);
  assert.equal("mustExclude" in searches[0], false);
  assert.equal(searched.body.results[0].score, 0.9);
});

test("PrecisionMem bridge maps superseded beliefs to suppressed lifecycle", async () => {
  const captures = [];
  const operations = createPrecisionMemOperations({
    store: {
      async capture(input) {
        captures.push(input);
      },
      async search() {
        return [];
      }
    }
  });
  const response = await operations.add({
    text: "SQLAlchemy was replaced.",
    user_id: "user-a",
    metadata: {
      beliefId: "belief-old",
      scope: "domain:code",
      superseded_by: "belief-current"
    }
  });
  assert.equal(response.status, 200);
  assert.equal(captures[0].lifecycle_state, "suppressed");

  await operations.add({
    text: "Should authentication support passkeys?",
    user_id: "user-a",
    metadata: {
      beliefId: "belief-question",
      scope: "domain:code",
      type: "open_question"
    }
  });
  assert.equal(captures[1].lifecycle_state, "suppressed");
});
