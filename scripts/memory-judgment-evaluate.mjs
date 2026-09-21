#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createMemoryJudge, createOpenRouterMemoryTransport, MEMORY_JUDGMENT_MODEL, MEMORY_JUDGMENT_VERSION, judgmentHash, memoryJudgmentPolicyHash } from "../packages/shared/src/memory-judgment-runtime.mjs";
import { calibrateMemoryJudgment, qualifyMemoryJudgment, replayMemoryJudgmentCase, validateJudgmentDataset } from "../packages/shared/src/memory-judgment-evaluation.mjs";
import { localJudgmentImplementationHash } from "../packages/orgbrain-cli/src/lib/local-memory-judgment-binding.mjs";

function argsOf(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--live") result.live = true;
    else if (["--dataset", "--out", "--outcomes", "--manifest"].includes(args[i]) && args[i + 1]) result[args[i++].slice(2)] = args[i];
    else throw new Error("usage: --dataset FILE --out NEW_DIRECTORY [--live], or --manifest FILE --outcomes FILE --out NEW_DIRECTORY");
  }
  if (!result.out) throw new Error("new_output_directory_required");
  return result;
}

async function verifyOutcomes(outcomes, root, output) {
  const verified = [];
  for (const [index, item] of outcomes.entries()) {
    const proofs = {};
    for (const key of ["artifact", "test"]) {
      const file = resolve(root, item.verification?.[`${key}_path`] ?? "");
      if (!file.startsWith(`${resolve(root)}${sep}`)) throw new Error("evidence_outside_run");
      const bytes = await readFile(file);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== item.verification?.[`${key}_hash`]) throw new Error("evidence_hash_mismatch");
      if (key === "test") {
        const receipt = JSON.parse(bytes.toString());
        if (receipt.case_id !== item.case_id || receipt.arm !== item.arm || receipt.passed !== item.task_success || receipt.artifact_hash !== item.verification.artifact_hash) throw new Error("test_receipt_mismatch");
      }
      const relative = `evidence/${index}-${key}`;
      await writeFile(resolve(output, relative), bytes, { mode: 0o600, flag: "wx" });
      proofs[`${key}_path`] = relative;
      proofs[`${key}_hash`] = hash;
    }
    verified.push({ ...item, verification: { ...proofs, verified: true } });
  }
  return verified;
}

export async function runJudgmentEvaluation(args) {
  const out = resolve(args.out);
  // Existing attempts, including incomplete attempts, are never overwritten.
  await mkdir(out, { mode: 0o700 });
  const write = (name, data) => writeFile(resolve(out, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (args.outcomes) {
    const manifest = JSON.parse(await readFile(resolve(args.manifest), "utf8"));
    const raw = JSON.parse(await readFile(resolve(args.outcomes), "utf8"));
    await mkdir(resolve(out, "evidence"), { mode: 0o700 });
    const outcomes = await verifyOutcomes(raw, dirname(resolve(args.outcomes)), out);
    await write("manifest.json", manifest);
    await write("outcomes.json", outcomes);
    const qualification = await qualifyMemoryJudgment(manifest, outcomes);
    await write("qualification.json", qualification);
    return qualification;
  }
  const dataset = validateJudgmentDataset(JSON.parse(await readFile(resolve(args.dataset), "utf8")));
  const runtimeBytes = await readFile(new URL("../packages/shared/src/memory-judgment-runtime.mjs", import.meta.url));
  let currentCase;
  const transport = args.live ? createOpenRouterMemoryTransport({ apiKey: process.env.OPENROUTER_API_KEY }) : async (request) => ({
    model: "fixture-replay-not-a-model", usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
    answers: Object.fromEntries(Object.keys(request.questions).map((key) => {
      const [, ordinal, axis] = /^c(\d+)_(.+)$/u.exec(key);
      const text = request.state.candidates[Number(ordinal)].text;
      const candidate = currentCase.candidates.find((c) => c.text === text);
      const score = currentCase.replay_scores?.[request.state.stage]?.[candidate?.id]?.[axis];
      if (typeof score !== "number") throw new Error("fixture_answer_missing");
      return [key, { type: "noul", noul: score }];
    }))
  });
  const judge = createMemoryJudge({ transport });
  const examples = [];
  const calibrationJudgments = [];
  for (const item of dataset.cases.filter((c) => c.split === "dev")) {
    currentCase = item;
    for (const stage of ["capture", "use"]) {
      const context = stage === "capture" ? { project_id: item.project_id, ...item.capture_context, purpose: "Future reuse within the project" }
        : { ...item.context, project_id: item.project_id, query: item.query };
      const result = await judge({ stage, context, candidates: item.candidates, policy: { mode: "shadow" } });
      calibrationJudgments.push(result);
      for (const decision of result.decisions.filter((d) => d.scores)) examples.push({ split: "dev", stage,
        candidate: item.candidates.find((c) => c.id === decision.id), scores: decision.scores,
        required: item.required_ids?.includes(decision.id), forbidden: item.forbidden_ids?.includes(decision.id) });
    }
  }
  const calibration = examples.length ? calibrateMemoryJudgment(examples) : { status: "inconclusive", threshold: 0.98, reason: "no_valid_development_judgments" };
  const manifest = { schema: "memory-judgment-experiment/v1", policy_version: MEMORY_JUDGMENT_VERSION, model: MEMORY_JUDGMENT_MODEL,
    threshold: calibration.threshold, policy_hash: await memoryJudgmentPolicyHash(calibration.threshold), dataset_hash: await judgmentHash(dataset), runtime_hash: createHash("sha256").update(runtimeBytes).digest("hex"),
    implementation_hash: await localJudgmentImplementationHash(),
    evaluator: args.live ? "live_jev_stage_replay" : "fixture_contract_replay", created_at: new Date().toISOString(),
    dev_conversations: dataset.cases.filter((c) => c.split === "dev").map((c) => c.conversation_id),
    holdout_conversations: dataset.cases.filter((c) => c.split === "holdout").map((c) => c.conversation_id),
    holdout_cases: dataset.cases.filter((c) => c.split === "holdout").map((c) => ({ id: c.id, conversation_id: c.conversation_id })) };
  await write("manifest.json", manifest); // Freeze before looking at holdout answers.
  await write("calibration.json", calibration);
  const rows = [], judgments = [...calibrationJudgments];
  for (const item of dataset.cases) {
    currentCase = item;
    const result = await replayMemoryJudgmentCase(item, judge, calibration.threshold);
    rows.push(...result.rows); judgments.push(...result.judgments);
  }
  const report = { schema: "memory-judgment-replay-report/v1", status: "inconclusive", reason: "task_outcomes_not_measured",
    scope: "selection_policy_only; not runtime retrieval, budget control or parent task execution",
    evaluator: manifest.evaluator, threshold: calibration.threshold, cases: dataset.cases.length,
    model_calls: args.live ? judgments.reduce((n, j) => n + j.request_count, 0) : 0,
    transport_calls: judgments.reduce((n, j) => n + j.request_count, 0), cache_hits: judgments.filter((j) => j.cache_hit).length,
    fallback_count: judgments.filter((j) => j.status === "fallback").length,
    provider_cost: judgments.some((j) => j.request_count && j.provider_cost == null) ? null : judgments.reduce((n, j) => n + (j.provider_cost ?? 0), 0),
    parent_usage: null, task_success: null, task_elapsed_ms: null, activation_qualified: false,
    arms: Object.fromEntries([...new Set(rows.map((r) => r.arm))].map((arm) => [arm, {
      holdout_cases: rows.filter((r) => r.arm === arm && r.split === "holdout").length,
      required_memory_missing: rows.filter((r) => r.arm === arm && r.split === "holdout").reduce((n, r) => n + r.required_memory_missing, 0),
      irrelevant_memory_included: rows.filter((r) => r.arm === arm && r.split === "holdout").reduce((n, r) => n + r.irrelevant_memory_included, 0)
    }])) };
  await write("rows.json", rows); await write("judgments.json", judgments); await write("report.json", report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runJudgmentEvaluation(argsOf(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
}
