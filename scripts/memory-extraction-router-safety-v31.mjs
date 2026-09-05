import { buildDiverseSafetyFixture, DIVERSE_SAFETY_SHA256 } from "./memory-extraction-router-safety-fixture-v2.mjs";
import { routeTurnEvidenceV3 } from "../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs";
import { routerHash } from "./memory-extraction-router-input.mjs";

export function evaluateDiverseSafety() {
  const fixture = buildDiverseSafetyFixture();
  const rows = fixture.cases.map((item) => {
    const route = routeTurnEvidenceV3({ snippets: [{ span_id: "s1", role: "user", text: item.text }], events: [] });
    return { id: item.id, family: item.family, phase: item.phase, category: item.category, expected: item.expected,
      primary_route: route.primary_route, reason_codes: route.reason_codes };
  });
  const phases = {};
  for (const phase of ["calibration", "locked"]) {
    const unsafe = rows.filter((row) => row.phase === phase && row.expected === "hard_excluded");
    const benign = rows.filter((row) => row.phase === phase && row.expected === "allowed");
    const excluded = unsafe.filter((row) => row.primary_route === "hard_excluded").length;
    const falseExcluded = benign.filter((row) => row.primary_route === "hard_excluded").length;
    phases[phase] = { unsafe_total: unsafe.length, unsafe_excluded: excluded, benign_total: benign.length,
      benign_false_excluded: falseExcluded, gate_pass: excluded === unsafe.length && falseExcluded === 0,
      // Boundary one-sided Clopper-Pearson bounds, otherwise unavailable.
      unsafe_one_sided_95_lower: excluded === unsafe.length ? 0.05 ** (1 / unsafe.length) : null,
      benign_one_sided_95_upper: falseExcluded === 0 ? 1 - 0.05 ** (1 / benign.length) : null };
  }
  const normalized = new Map();
  for (const item of fixture.cases) {
    const key = `${item.expected}:${item.text.normalize("NFKC").replace(/\d+/gu, "#").replace(/\s+/gu, " ")}`;
    if (!normalized.has(key)) normalized.set(key, new Set());
    normalized.get(key).add(item.phase);
  }
  const crossSplitDuplicates = [...normalized.values()].filter((phases) => phases.size > 1).length;
  if (crossSplitDuplicates) phases.locked.gate_pass = false;
  return { report: { contract: "memory-extraction-router-safety-report/v2", fixture_sha256: DIVERSE_SAFETY_SHA256,
    rows_sha256: routerHash(rows), phases, cross_split_normalized_duplicates: crossSplitDuplicates,
    interval_scope: "synthetic correlated fixtures; not a population guarantee", external_network: false, persistence_performed: false }, rows };
}
export function verifyDiverseSafety(document) {
  const actual = evaluateDiverseSafety();
  if (routerHash(document) !== routerHash(actual)) throw new Error("router_safety_result_mismatch");
  return actual.report;
}
