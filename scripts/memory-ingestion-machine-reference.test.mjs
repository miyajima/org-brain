import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateMachineReferenceCouncil,
  evaluateMachineReferencePredictions,
  MACHINE_REFERENCE_JUDGE_PROFILES,
  sealMachineReference
} from "./memory-ingestion-machine-reference.mjs";

function judgments(route = "active") {
  return MACHINE_REFERENCE_JUDGE_PROFILES.map((judge, index) => ({
    judge_name: judge,
    model_family: `family-${index % 3}`,
    model_version: `model-${index}`,
    prompt_hash: `sha256:${judge}`,
    candidate_hash: "sha256:candidate",
    verdict: route === "active" ? "pass" : "fail",
    confidence: 0.99,
    reason_codes: [],
    support_selector: [`selector-${index}`],
    signature: `sig-${judge}`,
    public_key_fingerprint: `key-${index % 3}`,
    label: { route, lesson_type: route === "active" ? "success" : null, verification_state: route === "active" ? "verified" : "rejected", hard_guardrails: [] }
  }));
}

test("machine reference council accepts stable unanimous active labels and quarantines disagreement", () => {
  const accepted = evaluateMachineReferenceCouncil({ first: judgments(), second: judgments(), candidate_hash: "sha256:candidate" });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.label.route, "active");
  assert.equal(evaluateMachineReferenceCouncil({ first: judgments(), second: judgments().reverse(), candidate_hash: "sha256:candidate" }).accepted, true);
  const changed = judgments();
  changed[0].label.route = "quarantine";
  assert.equal(evaluateMachineReferenceCouncil({ first: judgments(), second: changed, candidate_hash: "sha256:candidate" }).accepted, false);
  assert.equal(evaluateMachineReferenceCouncil({ first: judgments().slice(0, 2), second: judgments().slice(0, 2) }).status, "insufficient_evidence");
  const promptMismatch = judgments();
  promptMismatch[0].prompt_hash = "sha256:tampered";
  assert.equal(evaluateMachineReferenceCouncil({ first: judgments(), second: promptMismatch, candidate_hash: "sha256:candidate" }).accepted, false);
  const missingSignature = judgments();
  delete missingSignature[0].signature;
  assert.equal(evaluateMachineReferenceCouncil({ first: judgments(), second: missingSignature, candidate_hash: "sha256:candidate" }).status, "insufficient_evidence");
  const unknownProfile = judgments();
  unknownProfile[0].judge_name = "unlisted-profile";
  assert.equal(evaluateMachineReferenceCouncil({ first: unknownProfile, second: judgments(), candidate_hash: "sha256:candidate" }).status, "insufficient_evidence");
  assert.equal(evaluateMachineReferenceCouncil({
    first: judgments(),
    second: judgments(),
    candidate_hash: "sha256:candidate",
    producer_model_families: ["family-0"]
  }).status, "insufficient_evidence");
});

test("machine reference seal enforces 300 per route without human fields", () => {
  const cases = [];
  const references = [];
  for (const route of ["active", "quarantine", "excluded"]) {
    for (let index = 0; index < 300; index += 1) {
      const caseId = `${route}-${index}`;
      cases.push({ case_id: caseId, rows: [{ type: "synthetic" }] });
      references.push({ case_id: caseId, accepted: true, label: { route, lesson_type: route === "active" ? "success" : null, verification_state: route === "active" ? "verified" : "rejected", required_reason_codes: [], forbidden_reason_codes: [], hard_guardrails: [] }, repeat_agreement: 1, judgment_hashes: [] });
    }
  }
  const seal = sealMachineReference(cases, references, { seed_hash: "sha256:seed" });
  assert.deepEqual(seal.route_counts, { active: 300, quarantine: 300, excluded: 300 });
  assert.equal(seal.human_grounded, false);
  assert.equal(seal.selected_case_count, 900);
  const predictions = seal.selectedCases.map((item) => {
    const reference = references.find((row) => row.case_id === item.case_id);
    return {
      case_id: item.case_id,
      route: reference.label.route,
      ...(reference.label.route === "active" ? { lesson_type: reference.label.lesson_type } : {}),
      judge_verdicts: Object.fromEntries(MACHINE_REFERENCE_JUDGE_PROFILES.map((profile) => [profile, reference.label.route === "active" ? "pass" : "fail"]))
    };
  });
  const report = evaluateMachineReferencePredictions({ seal, cases: seal.selectedCases, gold: seal.gold, predictions, observedOutcomes: { passed: true } });
  assert.equal(report.passed, true);
  assert.throws(
    () => sealMachineReference([{ case_id: "human-case", reviewer_id: "opaque" }], [{ case_id: "human-case", accepted: true, label: { route: "active" } }]),
    /machine_reference_human_provenance_forbidden/u
  );
  assert.throws(
    () => sealMachineReference(cases, references.slice(0, -1), { seed_hash: "sha256:seed" }),
    /machine_reference_case_reference_set_mismatch/u
  );
});
