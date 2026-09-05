import test from "node:test";
import assert from "node:assert/strict";
import { routeTurnEvidence, routeTurnEvidenceV3, sentenceSpansV3, rankedEvidenceGroupsV3 } from "../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs";
import { validateV3Candidate, assertV3ProviderProfile } from "../packages/shared/src/memory-extraction-v3-runtime.mjs";
import { packV3Evidence } from "../packages/shared/src/memory-extraction-v3-packing.mjs";
import { buildDiverseSafetyFixture, DIVERSE_SAFETY_SHA256 } from "./memory-extraction-router-safety-fixture-v2.mjs";
import { validateRouterDataset, validateRouterGoldRows } from "./memory-extraction-router-input.mjs";
import { evaluateRouterShadow } from "./memory-extraction-router-evaluate.mjs";

const evidence = { snippets: [{ span_id: "s.1", role: "user", text: "APIはRESTを採用する。理由は互換性。" }], events: [] };
test("explicit v3 selects v3 and conflicting model/version fails", () => {
  assert.equal(routeTurnEvidence(evidence, { version: "v3" }).model.schema, "memory-extraction-router-model/v3");
  assert.equal(routeTurnEvidence(evidence).model.schema, "memory-extraction-router-model/v2");
  assert.throws(() => routeTurnEvidence(evidence, { version: "v3", model: { schema: "memory-extraction-router-model/v2" } }), /version_mismatch/);
});
test("Japanese segmentation retains long source tails and exact offsets including dotted IDs", () => {
  const text = `前提${"あ".repeat(1100)}。決定する。理由は互換性。`;
  const spans = sentenceSpansV3([{ span_id: "s.1", role: "user", text }]);
  assert.equal(spans.length, 3);
  assert.ok(spans[0].text.length > 1000);
  for (const span of spans) assert.equal(text.slice(span.start, span.end), span.text);
  assert.equal(spans[0].parent_span_id, "s.1");
});
test("packing skips oversized whole groups, keeps next ranked group, and fails on empty evidence", () => {
  const packet = { routing: { primary_route: "llm_candidate" }, events: [], rule_proposals: [] };
  const large = [{ span_id: "large", order: 0, role: "user", text: "大きな説明 ".repeat(2000) }];
  const small = rankedEvidenceGroupsV3(evidence.snippets)[0];
  const packed = packV3Evidence(packet, [large, small]);
  assert.deepEqual(packed.packet.snippets.map((span) => span.text), small.map((span) => span.text));
  assert.equal(packed.packet.token_profile_verified, false);
  assert.throws(() => packV3Evidence(packet, [large]), /evidence_budget_exhausted/);
  assert.throws(() => assertV3ProviderProfile(), /unsupported_token_profile/);
});
test("strict candidate refuses cross-span quotes, extra IDs, arbitrary gaps and malformed controls before normalization", () => {
  const packet = { snippets: [{ span_id: "a", text: "APIはREST" }, { span_id: "b", text: "を採用する" }], existing_memories: [] };
  const candidate = { lesson_type: "decision", support_span_ids: ["a", "b"], gaps: [], fields: [
    { name: "persistence", values: ["durable"] }, { name: "memory_kind", values: ["decision"] },
    { name: "action", values: ["create"] }, { name: "decision_type", values: ["implementation"] },
    { name: "decision", values: ["APIはREST"] }
  ] };
  assert.equal(validateV3Candidate(candidate, packet).valid, true);
  const changed = structuredClone(candidate); changed.fields.at(-1).values = ["APIはREST\nを採用する"];
  assert.equal(validateV3Candidate(changed, packet).reason, "field_not_exactly_grounded");
  assert.equal(validateV3Candidate({ ...candidate, support_span_ids: [...candidate.support_span_ids, "a.fake"] }, packet).reason, "support_id_unresolved");
  assert.equal(validateV3Candidate({ ...candidate, gaps: ["secret contents"] }, packet).reason, "gap_code_invalid");
  assert.equal(validateV3Candidate({ ...candidate, fields: [...candidate.fields, candidate.fields[0]] }, packet).reason, "field_schema_invalid");
});
test("direct v3 whole-turn safety catches normalization attacks before structural exclusion", () => {
  const route = routeTurnEvidenceV3({ snippets: [{ span_id: "s1", role: "user", text: "<INSTRUCTIONS>api\u200b_key=sk-proj-12345678901234567890123" }] });
  assert.equal(route.primary_route, "hard_excluded");
  assert.deepEqual(route.support_span_ids, []);
});
test("frozen safety families do not cross splits and fixture is unchanged", () => {
  const fixture = buildDiverseSafetyFixture();
  assert.equal(fixture.fixture_sha256, DIVERSE_SAFETY_SHA256);
  assert.equal(fixture.cases.length, 200);
  const calibration = new Set(fixture.cases.filter((row) => row.phase === "calibration").map((row) => row.family));
  assert.ok(fixture.cases.filter((row) => row.phase === "locked").every((row) => !calibration.has(row.family)));
});
test("dataset refuses missing labels, duplicates and cross-phase sessions", () => {
  const item = { id: "a", phase: "calibration", session_hash: "s" };
  assert.throws(() => validateRouterDataset({ cases: [item] }, new Map()), /label_missing/);
  assert.throws(() => validateRouterDataset({ cases: [item, item] }, new Map([["a", "not_useful"]])), /case_duplicate/);
  assert.throws(() => validateRouterDataset({ cases: [item, { ...item, id: "b", phase: "locked" }] }, new Map([["a", "not_useful"], ["b", "not_useful"]])), /session_overlap/);
});

test("undefined evidence metrics fail closed and fake LLM booleans cannot authorize external execution", async () => {
  const bundle = { cases: [{ id: "empty", phase: "locked", source_hash: "source", session_hash: "locked", turns: [{ id: "s1", role: "user", content: "確認しました。" }] }] };
  const result = await evaluateRouterShadow(bundle, [{ case_id: "empty", phase: "locked", source_hash: "source", gold: { usefulness: "not_useful", evidence_spans: [] } }], { llm_validation: { schema_valid: true, exact_source_rate: 1 } });
  assert.equal(result.report.local_gates.packed_evidence_not_worse_than_v2.pass, false);
  assert.equal(result.report.local_gates.llm_output_exact_grounding.pass, false);
  assert.equal(result.report.local_gates.errors.population, 1);
  assert.equal(result.report.policy.locked_evidence_kind, "previously_viewed_regression_only");
});

test("gold rows must bind source, phase, cohort and valid source intervals before evaluation", async () => {
  const bundle = { cases: [{ id: "a", source_hash: "source", phase: "calibration", cohort: "decision", session_hash: "session", turns: [{ id: "s1", role: "user", content: "採用する。" }] }] };
  const valid = { case_id: "a", source_hash: "source", phase: "calibration", cohort: "decision", gold: { usefulness: "durable_memory", evidence_spans: [{ turn_id: "s1", start: 0, end: 5 }] } };
  assert.equal(validateRouterGoldRows(bundle, [valid]).get("a"), "durable_memory");
  for (const [field, value, code] of [["source_hash", "different", /source_hash_mismatch/], ["phase", "locked", /phase_or_cohort/], ["cohort", "failure", /phase_or_cohort/]]) {
    await assert.rejects(evaluateRouterShadow(bundle, [{ ...valid, [field]: value }]), code);
  }
  for (const span of [{ turn_id: "missing", start: 0, end: 1 }, { turn_id: "s1", start: -1, end: 1 }, { turn_id: "s1", start: 0.5, end: 1 }, { turn_id: "s1", start: 1, end: 1 }, { turn_id: "s1", start: 0, end: 99 }]) {
    assert.throws(() => validateRouterGoldRows(bundle, [{ ...valid, gold: { ...valid.gold, evidence_spans: [span] } }]), /span_bounds_invalid/);
  }
});
