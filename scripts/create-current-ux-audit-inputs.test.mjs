import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerAuditInput } from "./create-current-ux-audit-inputs.mjs";
import { DEFAULT_RUBRIC_PATH, loadJson } from "./product-ux-scorecard.mjs";

const rubric = await loadJson(DEFAULT_RUBRIC_PATH);

function validInput() {
  return {
    audit: {
      id: "immutable-test",
      date: "2026-08-24",
      commit: "de5f9afa",
      state: "iteration",
      basis: "test candidate",
      consecutive_passes: 0,
      ai_repeat_consistent: false,
      cloud_live_verified: false,
      voiceover_manually_verified: false
    },
    evidence: [{ id: "E-01", mode: "static", description: "test", source: "test" }],
    measurements: rubric.axes.flatMap((axis) => axis.items.map((item) => ({
      id: item.id,
      raw_score: 80,
      evidence: ["E-01"],
      findings: [],
      notes: "test"
    })))
  };
}

test("registers a validated audit input once and never overwrites the phase", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orgbrain-ux-audit-"));
  const inputPath = path.join(directory, "candidate.json");
  const auditRoot = path.join(directory, "artifacts");
  const input = validInput();
  await writeFile(inputPath, JSON.stringify(input));

  const target = await registerAuditInput({ inputPath, phase: "iteration-4", auditRoot });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), input);

  input.audit.basis = "attempted replacement";
  await writeFile(inputPath, JSON.stringify(input));
  await assert.rejects(
    registerAuditInput({ inputPath, phase: "iteration-4", auditRoot }),
    /already exists and is immutable/u
  );
  assert.equal(JSON.parse(await readFile(target, "utf8")).audit.basis, "test candidate");
});
