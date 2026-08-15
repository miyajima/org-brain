import assert from "node:assert/strict";
import test from "node:test";
import { generateMachineReferenceCandidates } from "./memory-ingestion-machine-reference-generator.mjs";

test("machine-reference generator is blind and deterministic", () => {
  const generated = generateMachineReferenceCandidates({ seed: "private-machine-reference-seed", count: 1_200 });
  assert.equal(generated.cases.length, 1_200);
  assert.equal(new Set(generated.cases.map((item) => item.case_id)).size, 1_200);
  const serialized = JSON.stringify(generated.cases);
  assert.doesNotMatch(serialized, /expected_route|gold|prediction|label|reason_code/iu);
  assert.doesNotMatch(serialized, /raw_transcript|reasoning|sk-[A-Za-z0-9]{20,}/iu);
  assert.deepEqual(
    generated.cases,
    generateMachineReferenceCandidates({ seed: "private-machine-reference-seed", count: 1_200 }).cases
  );
});
