import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { handleLocalMcpRequest } from "../packages/orgbrain-cli/src/local-mcp.mjs";
import { searchContextWithFollowups, createLocalContextSearchJudge } from "../packages/orgbrain-cli/src/lib/context-search-followups.mjs";

const row = (id, version = 1) => ({ memory: { id, content: `${id} evidence`, rationale: "verified", reuse_rule: "staging only",
  project_id: "p", current_version: version, lifecycle_state: "active", source_references: [] }, score: { total: .8, lexical: .8 } });
const input = { tenant_id: "t", project_id: "p", principal_id: "alice", business_category_id: "b", work_type: "implementation",
  query: "Compare Redis and PostgreSQL for staging only", limit: 10, search_mode: "hybrid_v4", at: 123, minimum_total_score: .2 };
function decision(options, { missing = true, mode = "active", choose = 0 } = {}) {
  return { mode, applied: mode === "active", status: "judged", query_type: "comparison",
    coverage: Object.fromEntries(options.requirements.map((r) => [r.id, missing ? "missing" : "covered"])),
    selected_option_id: missing ? options.options[choose]?.id : "stop" };
}
const run = (extra = {}) => searchContextWithFollowups({ initialResults: [row("Redis")], searchInput: input,
  usagePurpose: "task", context: { task: input.query, conditions: "staging only; production excluded" },
  refresh: async (results) => ({ results, changed: false }), search: async () => [row("PostgreSQL")],
  judge: async (options) => decision(options), ...extra });

test("one retrieval performs a scoped additional search and stops when all requirements are covered", async () => {
  const searches = []; let judgments = 0;
  const result = await run({ judge: async (options) => {
    judgments++; assert.equal(options.context.conditions, "staging only; production excluded");
    return decision(options, { missing: judgments === 1 });
  }, search: async (request) => { searches.push(request); return [row("PostgreSQL"), row("Redis")]; } });
  assert.deepEqual(result.results.map((r) => r.memory.id), ["Redis", "PostgreSQL"]);
  assert.equal(searches.length, 1); assert.equal(judgments, 2);
  for (const key of ["tenant_id", "project_id", "principal_id", "business_category_id", "work_type", "at", "minimum_total_score", "search_mode"])
    assert.equal(searches[0][key], input[key]);
  assert.equal(result.report.additional_searches, 1);
  assert.equal(result.report.reason_code, "requirements_covered");
  assert.equal(result.report.basis, "prediction");
});

test("complete evidence needs no additional search", async () => {
  let searches = 0;
  const result = await run({ judge: async (options) => decision(options, { missing: false }), search: async () => { searches++; return []; } });
  assert.equal(searches, 0); assert.equal(result.report.reason_code, "requirements_covered");
});

test("shadow, uncertainty, invalid choices and audit retrieval preserve initial evidence without additional search", async () => {
  for (const variant of ["shadow", "uncertain", "invalid", "audit"]) {
    let searches = 0;
    const result = await run({ usagePurpose: variant === "audit" ? "audit" : "task", judge: async (options) => {
      const result = decision(options, { mode: variant === "shadow" ? "shadow" : "active" });
      if (variant === "uncertain") result.coverage = Object.fromEntries(options.requirements.map((r) => [r.id, "uncertain"]));
      if (variant === "invalid") result.selected_option_id = "arbitrary_external_search";
      return result;
    }, search: async () => { searches++; return []; } });
    assert.equal(searches, 0, variant); assert.deepEqual(result.results.map((r) => r.memory.id), ["Redis"]);
  }
});

test("no new evidence stops immediately and source changes stop before executing a predicted search", async () => {
  let searches = 0;
  const unchanged = await run({ search: async () => { searches++; return [row("Redis")]; } });
  assert.equal(searches, 1); assert.equal(unchanged.report.reason_code, "no_new_evidence");
  const changed = await run({ refresh: async () => ({ results: [], changed: true }), search: async () => { throw new Error("must not search"); } });
  assert.deepEqual(changed.results, []); assert.equal(changed.report.reason_code, "source_changed");
});

test("at most two additional searches execute, with no repeated query", async () => {
  const queries = []; let judgments = 0;
  const result = await run({ judge: async (options) => { judgments++; return decision(options); },
    search: async (request) => { queries.push(request.query); return [row(`new${queries.length}`)]; } });
  assert.equal(queries.length, 2); assert.equal(new Set(queries).size, 2);
  assert.equal(judgments, 3); assert.equal(result.report.reason_code, "search_limit_reached");
});

test("failures and expired search deadline preserve evidence and never retry", async () => {
  let calls = 0;
  const failed = await run({ judge: async () => { calls++; throw new Error("provider unavailable"); } });
  assert.equal(calls, 1); assert.deepEqual(failed.results.map((r) => r.memory.id), ["Redis"]);
  assert.equal(failed.report.reason_code, "judgment_unavailable");
  let time = 0;
  const expired = await run({ now: () => time, judge: async (options) => { time = 5001; return decision(options); },
    search: async () => { throw new Error("must not search after deadline"); } });
  assert.equal(expired.report.reason_code, "timeout");
});

test("off and unqualified active policy make zero provider requests", async () => {
  for (const mode of ["off", "active"]) {
    let calls = 0;
    const judge = createLocalContextSearchJudge({ env: { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_SEARCH_MODE: mode,
      ORGBRAIN_JEV_OBJECTIVE: "cost" }, transport: async () => { calls++; throw new Error("unexpected provider request"); } });
    const result = await run({ judge });
    assert.equal(calls, 0); assert.equal(result.report.additional_searches, 0);
    assert.equal(result.report.reason_code, mode === "off" ? "disabled" : "qualification_required");
  }
});

test("typed shadow planning batches query type, coverage and action and retains original conditions", async () => {
  let calls = 0;
  const judge = createLocalContextSearchJudge({ env: { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_SEARCH_MODE: "shadow" },
    transport: async (request) => {
      calls++; assert.ok(JSON.stringify(request.state).includes("production excluded"));
      return { model: "typesafe/jev-1.13", answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
        const choice = id === "query_type" ? "comparison" : id === "next_search" ? Object.keys(q.criteria).find((k) => k !== "stop" && k !== "uncertain") : "missing";
        return [id, { type: "choice", choice, confidence: .99, probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0])) }];
      })), usage: { input_tokens: 100, output_tokens: 20, cost: .001 } };
    } });
  const result = await run({ judge });
  assert.equal(calls, 1); assert.equal(result.report.mode, "shadow"); assert.equal(result.report.additional_searches, 0);
  assert.equal(result.report.query_type, "comparison");
});

test("a stalled additional search returns within the phase deadline and keeps prior evidence", async () => {
  const result = await run({ timeoutMs: 10, search: async () => new Promise(() => {}) });
  assert.equal(result.report.reason_code, "timeout");
  assert.deepEqual(result.results.map((r) => r.memory.id), ["Redis"]);
  assert.equal(result.report.additional_searches, 1);
});

test("freshness verification shares the phase deadline and stops before judging stale candidates", async () => {
  let judgments = 0;
  const stalled = await run({ timeoutMs: 10, refresh: async () => new Promise(() => {}),
    judge: async (options) => { judgments++; return decision(options); } });
  assert.equal(stalled.report.reason_code, "timeout");
  assert.equal(judgments, 0);
  assert.equal(stalled.report.additional_searches, 0);
  const revoked = await run({ refresh: async () => ({ results: [], changed: true }),
    judge: async () => { throw new Error("revoked evidence must not reach judge"); } });
  assert.equal(revoked.report.reason_code, "source_changed");
  assert.deepEqual(revoked.results, []);
});

test("the total candidate set remains bounded and literal single-term queries are not repeated", async () => {
  const result = await run({ search: async () => Array.from({ length: 50 }, (_, i) => row(`found${i}`)) });
  assert.equal(result.results.length, 50); assert.equal(result.report.additional_searches, 1);
  assert.equal(result.report.reason_code, "candidate_limit_reached");
  let searches = 0;
  const single = await run({ searchInput: { ...input, query: "Redis" }, search: async () => { searches++; return [row(`found${searches}`)]; } });
  assert.equal(searches, 1); assert.equal(single.report.reason_code, "search_uncertain");
});

async function databaseFixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), "context-followups-"));
  const store = new LocalMemoryStore(join(directory, "memory.sqlite"), { env: {}, denseEmbeddingProvider: null });
  try { await store.init(); await fn(store); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function seed(store, key, extra = {}) {
  const receipt = await store.capture({ tenant_id: "t", project_id: "p", work_type: "implementation", kind: "fact", lifecycle_state: "active", scope_type: "project", scope_key: "p",
    content: `${key} cache: use only for staging; production is excluded.`, summary: `${key} cache`, tags: [], entities: [],
    source: "test", external_key: key, source_references: [{ ref: `proof-${key}` }], rationale: "observed", reuse_rule: "staging only",
    evidence: [], conflicts: [], permissions: [], ...extra });
  return store.get("t", receipt.memory_id);
}

test("MCP returns additional evidence within one response and records only packed items once", async () => {
  await databaseFixture(async (store) => {
    const a = await seed(store, "Redis"), b = await seed(store, "PostgreSQL");
    const searches = []; let plans = 0;
    store.search = async (request) => { searches.push(request); return searches.length === 1 ? [{ memory: a, score: { total: .8, lexical: .8 } }]
      : [{ memory: a, score: { total: .8, lexical: .8 } }, { memory: b, score: { total: .8, lexical: .8 } }]; };
    store.contextSearchJudge = async (options) => decision(options, { missing: ++plans === 1 });
    const response = await handleLocalMcpRequest(store, { method: "tools/call", params: { name: "orgbrain_context_enrich",
      arguments: { tenant_id: "t", project_id: "p", work_type: "implementation", query: input.query, usage_purpose: "task", task_id: "test-followup", token_budget: 1500 } } });
    assert.equal(response.isError, false, JSON.stringify(response));
    const value = JSON.parse(response.content[0].text);
    assert.equal(searches.length, 2); assert.equal(plans, 2);
    assert.equal(value.meta.context_search.additional_searches, 1);
    assert.equal(value.results.length, 2); assert.equal(value.meta.usage_items.length, 2);
    assert.ok(value.evidence_bundle.estimated_tokens <= 1500);
    assert.ok(value.evidence_bundle.evidence.every((item) => item.text.includes("production is excluded")));
    const db = store.open({ readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM memory_usage_events WHERE task_id='test-followup'").get().n, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM memory_usage_items").get().n, 2);
    } finally { db.close(); }
  });
});

test("ACL revoked during successful or failed judgment removes stale evidence and prevents follow-up execution", async () => {
  for (const failure of [false, true]) {
  await databaseFixture(async (store) => {
    const a = await seed(store, "Redis", { permissions: [{ principal_id: "alice", permissions: ["read"] }] });
    let searches = 0;
    store.search = async () => { searches++; return [{ memory: a, score: { total: .8, lexical: .8 } }]; };
    store.contextSearchJudge = async (options) => {
      const db = store.open();
      try { db.prepare("UPDATE memories SET permissions_json=? WHERE id=?").run(JSON.stringify([{ principal_id: "bob", permissions: ["read"] }]), a.id); }
      finally { db.close(); }
      if (failure) throw new Error("provider unavailable");
      return decision(options);
    };
    const result = await store.retrieveContext({ tenant_id: "t", project_id: "p", principal_id: "alice", query: "Redis cache",
      usage_purpose: "task", context_format: "compact", token_budget: 1500 });
    assert.equal(searches, 1); assert.equal(result.results.length, 0);
    if (!failure) assert.equal(result.meta.context_search.reason_code, "source_changed");
    assert.equal(result.meta.usage_items.length, 0);
  });
  }
});

test("a changed work scope cannot be returned or used for a further search", async () => {
  await databaseFixture(async (store) => {
    const a = await seed(store, "Redis", { work_type: "implementation" });
    let searches = 0;
    store.search = async () => { searches++; return [{ memory: a, score: { total: .8, lexical: .8 } }]; };
    store.contextSearchJudge = async (options) => {
      const db = store.open();
      try { db.prepare("UPDATE memories SET work_type='research' WHERE id=?").run(a.id); } finally { db.close(); }
      return decision(options);
    };
    const result = await store.retrieveContext({ tenant_id: "t", project_id: "p", query: "Redis cache", work_type: "implementation",
      usage_purpose: "task", context_format: "compact", token_budget: 1500 });
    assert.equal(searches, 1); assert.equal(result.results.length, 0);
    assert.equal(result.meta.context_search.reason_code, "source_changed");
  });
});
