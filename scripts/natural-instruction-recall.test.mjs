import assert from "node:assert/strict";
import test from "node:test";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { buildCompactMemoryContext, countContextTokens } from "../packages/orgbrain-cli/src/lib/compact-memory-context.mjs";
import { localTaskQueryPlan, matchesLocalTaskQuery, coversLocalTaskQuery } from "../packages/orgbrain-cli/src/lib/local-task-query.mjs";
import { syntheticRecords, syntheticPrimary, syntheticCases, at, settings, withStore, queryStore, replay } from "./fixtures/natural-instruction-recall.mjs";

globalThis.fetch = async () => { throw new Error("offline_replay_network_forbidden"); };
const originalNow = Date.now;
test.before(() => { Date.now = () => at; });
test.after(() => { Date.now = originalNow; });
const ids = (results) => results.map(({ memory }) => memory.id).sort();
const genericQuery = syntheticPrimary.query;
const genericRecords = syntheticRecords;

test("synthetic compound question retrieves both lessons without claiming current applicability", async () => {
  await withStore(LocalMemoryStore, syntheticRecords, async (store) => {
    const { results, response } = await queryStore(store, buildCompactMemoryContext, syntheticPrimary);
    assert.deepEqual(ids(results), [...syntheticPrimary.expected].sort());
    assert.deepEqual(ids(response.results), [...syntheticPrimary.expected].sort());
    assert.ok(results.every(({ score }) => score.total >= settings.minimum_total_score));
    assert.equal(response.evidence_bundle.evidence_status, "degraded");
    assert.match(response.evidence_bundle.guidance, /Historical evidence only/);
    assert.ok(countContextTokens(response) <= settings.token_budget);
    for (const evidence of response.evidence_bundle.evidence) {
      const record = syntheticRecords.find(({ id }) => id === evidence.memory_id);
      assert.equal(evidence.text, record.content);
      assert.equal(evidence.rationale, record.rationale);
      assert.equal(evidence.reuse_rule, record.reuse_rule);
      assert.equal(evidence.source_reference.ref, record.source);
      assert.equal(evidence.verification_state, "unverified");
    }
    assert.equal((await queryStore(store, buildCompactMemoryContext, syntheticPrimary, { minimum_total_score: 1 })).results.length, 0);
  });
});

test("synthetic keyword, natural and negative controls are stable across three real-store runs", async () => {
  const runs = [];
  for (let repeat = 0; repeat < 3; repeat++) runs.push(await replay(LocalMemoryStore, buildCompactMemoryContext, syntheticRecords, syntheticCases));
  for (const rows of runs) for (const row of rows) {
    assert.deepEqual([...row.search_ids].sort(), [...row.expected].sort(), row.id);
    assert.deepEqual([...row.delivered_ids].sort(), [...row.expected].sort(), row.id);
    assert.equal(row.abstention_recommended, !row.expected.length, row.id);
    assert.equal(row.fields_preserved, true, row.id);
    assert.ok(row.response_tokens <= settings.token_budget, row.id);
  }
  const projection = (rows) => rows.map(({ id, search_ids, delivered_ids, scores }) => ({ id, search_ids, delivered_ids, scores }));
  assert.deepEqual(projection(runs[0]), projection(runs[1]));
  assert.deepEqual(projection(runs[0]), projection(runs[2]));
});

test("independent questions generalize to unrelated vocabulary without OR-ing subject terms", async () => {
  const plan = localTaskQueryPlan(genericQuery);
  assert.equal(plan.clauses.length, 2);
  assert.equal(matchesLocalTaskQuery(genericRecords[0], plan), true);
  assert.equal(matchesLocalTaskQuery(genericRecords[1], plan), true);
  assert.equal(coversLocalTaskQuery(genericRecords.slice(0, 1), plan), false);
  assert.equal(coversLocalTaskQuery(genericRecords, plan), true);
  await withStore(LocalMemoryStore, genericRecords, async (store) => {
    const { results, response } = await queryStore(store, buildCompactMemoryContext, { query: genericQuery });
    assert.deepEqual(ids(results), genericRecords.map(({ id }) => id).sort());
    assert.deepEqual(ids(response.results), ids(results));
    // A repeated question does not grant permission to discard any unknown topic.
    for (const query of [
      `${genericQuery.slice(0, -1)} and what galactic payroll discrepancy should we review?`,
      "What archive restore method can run safely and what UnknownStore732 storage failure should we avoid?",
      "What archive restore method can run safely and what storage failure in US should we avoid?",
      "What archive restore method can run safely and what previous storage and payroll failure should we avoid?",
      "What archive restore method and galactic payroll discrepancy should we review?"
    ]) {
      const result = await queryStore(store, buildCompactMemoryContext, { query });
      assert.equal(result.results.length, 0, query);
      assert.equal(result.response.evidence_bundle.abstention_recommended, true, query);
    }
  });
});

test("unknown identifiers and explicit quoted terms are literal constraints", () => {
  for (const [query, decoy] of [
    ["What ArchiveRunner731 dependencies does the fixture require?", "ArchiveRunner dependencies required fixture"],
    ["channel closed archive_checksum_failure", "channel closed failure_archive_checksum"],
    ['What "safely" restore method should we use?', "safe restore method"],
    ["What SafeLY restore method should we use?", "safe restore method"],
    ["What US storage failure should we avoid?", "EU storage failure"]
  ]) assert.equal(matchesLocalTaskQuery({ content: decoy }, localTaskQueryPlan(query)), false, query);
  assert.equal(matchesLocalTaskQuery({ content: "fixture dependencies are required" },
    localTaskQueryPlan("What dependencies does the fixture require?")), true);
  const quotedCoordinator = localTaskQueryPlan('What "archive and what previous storage" failure should we avoid?');
  assert.equal(quotedCoordinator.clauses.length, 1);
  assert.equal(matchesLocalTaskQuery({ content: "archive failure previous storage" }, quotedCoordinator), false);
  assert.ok(localTaskQueryPlan("What current tests actually passed?").groups.some((group) => group.includes("current")));
  assert.ok(localTaskQueryPlan("What storage failure should we not avoid?").groups.some((group) => group.includes("not")));
  assert.equal(localTaskQueryPlan("What storage failure and what archive method and what billing case and what payroll error?"), null);
});

test("other retrieval channels cannot erase a literal identifier boundary", async () => {
  await withStore(LocalMemoryStore, [{ id: "identifier-decoy", content: "channel closed failure_archive_checksum",
    summary: "channel closed failure_archive_checksum", rationale: "An archive error", reuse_rule: "Historical evidence only", source: "fixtures/identifier.md" }],
  async (store) => {
    const result = await queryStore(store, buildCompactMemoryContext, { query: "channel closed archive_checksum_failure" });
    assert.equal(result.results.length, 0);
    assert.equal(result.response.evidence_bundle.abstention_recommended, true);
  });
});

test("missing, unauthorized, wrong-scope, expired and conflicted clauses cannot enable a rescue", async () => {
  const variants = [null,
    { tenant_id: "another-tenant" }, { project_id: "another-project" }, { work_type: "research" },
    { permissions: [{ principal_type: "principal", principal_id: "owner", permissions: ["read"] }] },
    { lifecycle_state: "suppressed" }, { valid_from: at + 86400000 },
    { valid_until: at - 86400000 }, { expires_at: at - 86400000 },
    { conflicts: ["Procedure revoked pending investigation."] }
  ];
  for (const variant of variants) {
    const records = variant === null ? genericRecords.slice(0, 1)
      : [genericRecords[0], { ...genericRecords[1], ...variant }];
    await withStore(LocalMemoryStore, records, async (store) => {
      const result = await queryStore(store, buildCompactMemoryContext, { query: genericQuery });
      assert.equal(result.results.length, 0, JSON.stringify(variant));
      assert.equal(result.response.results.length, 0, JSON.stringify(variant));
      assert.equal(result.response.evidence_bundle.abstention_recommended, true, JSON.stringify(variant));
    });
  }
});

test("packing cannot turn partial lexical coverage into a complete answer", async () => {
  await withStore(LocalMemoryStore, genericRecords, async (store) => {
    const { results } = await queryStore(store, buildCompactMemoryContext, { query: genericQuery });
    for (const selected of [results.slice(0, 1), results]) {
      const { response } = buildCompactMemoryContext({ results: selected, query: genericQuery,
        topK: 1, tokenBudget: settings.token_budget, at, usageId: "partial-replay" });
      assert.equal(response.results.length, 0);
      assert.equal(response.evidence_bundle.abstention_recommended, true);
      assert.ok(response.evidence_bundle.missing_evidence.includes("incomplete_question_coverage"));
    }
    const budgeted = buildCompactMemoryContext({ results, query: genericQuery, topK: 3,
      tokenBudget: 500, at, usageId: "budget-replay" }).response;
    assert.equal(budgeted.results.length, 0);
    assert.equal(budgeted.evidence_bundle.abstention_recommended, true);
    assert.equal(budgeted.evidence_bundle.budget_limited, true);
    assert.ok(countContextTokens(budgeted) <= 500);
    const sameSource = structuredClone(results);
    for (const result of sameSource) result.memory.source_references = [{ type: "file", ref: "fixtures/one-source.md" }];
    const correlated = buildCompactMemoryContext({ results: sameSource, query: genericQuery, topK: 3,
      tokenBudget: 1500, at, usageId: "same-source-replay" }).response;
    assert.equal(correlated.results.length, 0);
    assert.ok(correlated.evidence_bundle.missing_evidence.includes("insufficient_independent_sessions"));
    const conflicted = structuredClone(results);
    conflicted[0].memory.conflicts = ["Contradictory procedure"];
    const { response } = buildCompactMemoryContext({ results: conflicted, query: genericQuery,
      topK: 3, tokenBudget: settings.token_budget, at, usageId: "conflict-replay" });
    assert.equal(response.results.length, 0);
    assert.ok(response.evidence_bundle.missing_evidence.includes("conflicting_evidence"));
  });
});
