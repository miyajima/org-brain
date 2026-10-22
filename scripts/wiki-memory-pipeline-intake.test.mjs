import test from "node:test";
import assert from "node:assert/strict";
import { callWikiTool } from "../packages/orgbrain-cli/src/lib/wiki-mcp.mjs";

function wikiFixture({ mutation = {}, readback = {}, enqueueResult = { queued: true, id: "queue-1" }, wakeError = null, wakeResult = { started: true, pid: 4321 } } = {}) {
  const requests = [];
  const enqueued = [];
  const events = [];
  const wakeCalls = [];
  let envLoads = 0;
  const wiki = {
    async request(input) {
      requests.push(input);
      events.push(input.op === "read" ? "readback" : "mutation");
      if (input.op === "read") {
        if (readback instanceof Error) throw readback;
        return readback;
      }
      if (mutation instanceof Error) throw mutation;
      return mutation;
    },
  };
  const enqueueSource = async (store, input) => {
    events.push("enqueue");
    enqueued.push({ store, input });
    return enqueueResult;
  };
  const loadEnvFallbacks = async () => {
    envLoads += 1;
    events.push("env");
    return { OPENROUTER_API_KEY: "test-worker-key" };
  };
  const wakeMemoryPipeline = async (store, options) => {
    events.push("wake");
    wakeCalls.push({ store, options });
    if (wakeError) throw wakeError;
    return wakeResult;
  };
  return { wiki, requests, enqueued, enqueueSource, loadEnvFallbacks, wakeMemoryPipeline, events, wakeCalls, get envLoads() { return envLoads; } };
}

test("Wiki intake reads the exact mutated page and uses its stored project when input omits it", async () => {
  const store = {};
  const pageId = "page-1";
  const hash = "a".repeat(64);
  const fixture = wikiFixture({
    mutation: { page_id: pageId, hash },
    readback: { page_id: pageId, hash, tenant_id: "stored-tenant", project_id: "stored-project", content: "bounded" },
  });

  const result = await callWikiTool(
    store,
    "orgbrain_wiki_put",
    { path: "note.md", content: "page text" },
    fixture,
  );

  assert.deepEqual(fixture.requests[1], {
    op: "read",
    wiki_id: "personal",
    page_id: pageId,
    max_chars: 128,
  });
  assert.equal(fixture.enqueued.length, 1);
  assert.equal(fixture.enqueued[0].store, store);
  assert.deepEqual(fixture.enqueued[0].input, {
    tenantId: "stored-tenant",
    projectId: "stored-project",
    selector: { source: "wiki", page_id: pageId, expected_hash: hash },
  });
  assert.deepEqual(fixture.events, ["mutation", "readback", "enqueue", "env", "wake"]);
  assert.deepEqual(fixture.wakeCalls, [{
    store,
    options: { tenantId: "stored-tenant", projectId: "stored-project", env: { OPENROUTER_API_KEY: "test-worker-key" } },
  }]);
  assert.deepEqual(result.memory_intake, { queued: true, id: "queue-1", worker: { started: true } });
});

test("Wiki intake refuses a caller project that differs from stored scope", async () => {
  const pageId = "page-2";
  const hash = "b".repeat(64);
  const fixture = wikiFixture({
    mutation: { page_id: pageId, hash },
    readback: { page_id: pageId, hash, project_id: "stored-project" },
  });

  const result = await callWikiTool(
    {},
    "orgbrain_wiki_patch",
    { page_id: pageId, project_id: "other-project" },
    fixture,
  );

  assert.equal(fixture.enqueued.length, 0);
  assert.equal(fixture.wakeCalls.length, 0);
  assert.deepEqual(result.memory_intake, {
    queued: false,
    reason: "wiki_project_scope_mismatch",
  });
});

test("Wiki intake refuses incomplete or mismatched readback identity and scope", async (t) => {
  const cases = [
    ["page id mismatch", { page_id: "another-page", hash: "c".repeat(64), project_id: "p" }, "wiki_page_id_mismatch"],
    ["hash mismatch", { page_id: "page-3", hash: "d".repeat(64), project_id: "p" }, "wiki_hash_mismatch"],
    ["missing project", { page_id: "page-3", hash: "c".repeat(64) }, "wiki_project_scope_missing"],
  ];

  for (const [label, readback, reason] of cases) {
    await t.test(label, async () => {
      const fixture = wikiFixture({
        mutation: { page_id: "page-3", hash: "c".repeat(64) },
        readback,
      });
      const result = await callWikiTool({}, "orgbrain_wiki_put", {}, fixture);
      assert.equal(fixture.enqueued.length, 0);
      assert.equal(fixture.wakeCalls.length, 0);
      assert.deepEqual(result.memory_intake, { queued: false, reason });
    });
  }
});

test("Wiki intake returns a safe reason when the mutation omits its page or hash", async (t) => {
  for (const mutation of [{ page_id: "page-5" }, { hash: "f".repeat(64) }]) {
    await t.test(JSON.stringify(mutation), async () => {
      const fixture = wikiFixture({ mutation });
      const result = await callWikiTool({}, "orgbrain_wiki_put", {}, fixture);
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.enqueued.length, 0);
      assert.equal(fixture.wakeCalls.length, 0);
      assert.deepEqual(result.memory_intake, {
        queued: false,
        reason: "wiki_mutation_identity_missing",
      });
    });
  }
});

test("Wiki intake reports bounded readback failure without exposing its error", async () => {
  const fixture = wikiFixture({
    mutation: { page_id: "page-4", hash: "e".repeat(64) },
    readback: new Error("private page contents must not be returned"),
  });

  const result = await callWikiTool({}, "orgbrain_wiki_put", {}, fixture);

  assert.equal(fixture.enqueued.length, 0);
  assert.equal(fixture.wakeCalls.length, 0);
  assert.deepEqual(result.memory_intake, {
    queued: false,
    reason: "wiki_page_readback_unavailable",
  });
  assert.doesNotMatch(JSON.stringify(result), /private page contents/);
});

test("feature-disabled Wiki mutation still fails before attempting memory intake", async () => {
  const fixture = wikiFixture({ mutation: new Error("feature_disabled") });

  await assert.rejects(
    callWikiTool({}, "orgbrain_wiki_put", {}, fixture),
    /feature_disabled/,
  );
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.enqueued.length, 0);
  assert.equal(fixture.wakeCalls.length, 0);
});

test("Wiki intake preserves a queued row and reports safe worker status when wake fails", async () => {
  const fixture = wikiFixture({
    mutation: { page_id: "page-wake-failure", hash: "9".repeat(64) },
    readback: { page_id: "page-wake-failure", hash: "9".repeat(64), tenant_id: "stored-tenant", project_id: "stored-project" },
    wakeError: new Error("worker secret and local path must not escape"),
  });

  const result = await callWikiTool({}, "orgbrain_wiki_put", {}, fixture);

  assert.equal(fixture.enqueued.length, 1);
  assert.equal(fixture.wakeCalls.length, 1);
  assert.deepEqual(result.memory_intake, {
    queued: true,
    id: "queue-1",
    worker: { started: false, reason: "worker_unavailable" },
  });
  assert.doesNotMatch(JSON.stringify(result), /worker secret|local path/);
});

test("Wiki intake does not wake for disabled or idempotent non-queued results", async (t) => {
  for (const enqueueResult of [
    { queued: false, reason: "disabled" },
    { queued: false, id: "queue-1" },
  ]) {
    await t.test(JSON.stringify(enqueueResult), async () => {
      const fixture = wikiFixture({
        mutation: { page_id: "page-not-queued", hash: "8".repeat(64) },
        readback: { page_id: "page-not-queued", hash: "8".repeat(64), tenant_id: "stored-tenant", project_id: "stored-project" },
        enqueueResult,
      });
      const result = await callWikiTool({}, "orgbrain_wiki_put", {}, fixture);
      assert.deepEqual(result.memory_intake, enqueueResult);
      assert.equal(fixture.wakeCalls.length, 0);
      assert.equal(fixture.envLoads, 0);
    });
  }
});
