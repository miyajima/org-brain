#!/usr/bin/env node

import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
import {
  evaluateMachineReferenceCouncil,
  evaluateMachineReferencePredictions,
  MACHINE_REFERENCE_DATASET_ID,
  MACHINE_REFERENCE_JUDGE_PROFILES,
  sealMachineReference,
  sha
} from "./memory-ingestion-machine-reference.mjs";
import { generateMachineReferenceDirectory, MACHINE_REFERENCE_CANDIDATE_COUNT } from "./memory-ingestion-machine-reference-generator.mjs";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split("=", 2);
    if (!name.startsWith("--")) throw new Error(`unknown_argument:${argv[index]}`);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name}_requires_value`);
    values.set(name, value);
  }
  return { command: argv[0], get(name, fallback = undefined) { return values.get(name) ?? fallback; } };
}

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(file), "utf8"));
}

async function readJsonl(file) {
  const rows = [];
  const input = readline.createInterface({ input: createReadStream(path.resolve(file), { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of input) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

async function writePrivate(file, value, jsonl = false) {
  const destination = path.resolve(file);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.tmp`);
  const text = jsonl ? value.map((item) => JSON.stringify(item)).join("\n") + "\n" : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  return destination;
}

function stableJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableJson(item))));
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(stableJson(value[key]))])));
}

function sign(value, privateKeyPath) {
  if (!privateKeyPath) return { signature: null, public_key_fingerprint: null };
  const privateKey = crypto.createPrivateKey({ key: readFileSync(path.resolve(privateKeyPath)), format: "pem", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  const signature = crypto.sign(null, Buffer.from(stableJson(value), "utf8"), privateKey).toString("base64");
  return {
    signature,
    public_key_fingerprint: sha(publicKey.export({ type: "spki", format: "der" }))
  };
}

function verifyTopLevelSignature(value, publicKeyPath) {
  const signature = String(value?.signature ?? "");
  if (!signature || !publicKeyPath) return false;
  const publicKey = crypto.createPublicKey({ key: readFileSync(path.resolve(publicKeyPath)), format: "pem", type: "spki" });
  const payload = { ...value };
  delete payload.signature;
  delete payload.public_key_fingerprint;
  return crypto.verify(null, Buffer.from(stableJson(payload), "utf8"), publicKey, Buffer.from(signature, "base64"));
}

function csvValues(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function judgeCommand(args) {
  const cases = await readJsonl(args.get("--cases"));
  const seedHashes = new Set(cases.map((item) => item.seed_hash).filter(Boolean));
  if (seedHashes.size > 1) throw new Error("machine_reference_seed_mismatch");
  const caseSeedHash = [...seedHashes][0] ?? null;
  const requestedSeedHash = args.get("--seed-hash", caseSeedHash);
  if (caseSeedHash && requestedSeedHash && requestedSeedHash !== caseSeedHash) throw new Error("machine_reference_seed_mismatch");
  const modulePath = args.get("--runner-module");
  if (!modulePath) throw new Error("runner_module_required");
  const signingKey = args.get("--signing-key");
  if (!signingKey) throw new Error("machine_reference_signing_key_required");
  const producerModelFamilies = csvValues(args.get("--producer-model-families"));
  const producerModelVersions = csvValues(args.get("--producer-model-versions"));
  const runner = await import(pathToFileURL(path.resolve(modulePath)).href);
  if (typeof runner.runMachineReferenceJudge !== "function") throw new Error("runner_module_must_export_runMachineReferenceJudge");
  const results = [];
  for (const item of cases) {
    if (Object.hasOwn(item, "expected_route") || Object.hasOwn(item, "gold") || Object.hasOwn(item, "prediction")) throw new Error(`machine_reference_input_leakage:${item.case_id}`);
    if (/raw_transcript|reasoning|chain.of.thought|sk-[A-Za-z0-9]{20,}|\/Users\/[^/]+\//iu.test(JSON.stringify(item))) throw new Error(`machine_reference_privacy_violation:${item.case_id}`);
    const rounds = [];
    for (const round of ["first", "second"]) {
      const profiles = [...MACHINE_REFERENCE_JUDGE_PROFILES];
      if (round === "second") profiles.reverse();
      const judgments = [];
      for (const profile of profiles) {
        const result = await runner.runMachineReferenceJudge({ case: item, profile, round });
        if (!result || typeof result !== "object") throw new Error(`machine_reference_judge_result_missing:${item.case_id}:${profile}`);
        if (/raw_transcript|reasoning|chain.of.thought|sk-[A-Za-z0-9]{20,}|\/Users\/[^/]+\//iu.test(JSON.stringify(result))) {
          throw new Error(`machine_reference_privacy_violation:${item.case_id}:${profile}`);
        }
        const candidateHash = result.candidate_hash ?? sha(stableJson(item));
        if (candidateHash !== sha(stableJson(item))) throw new Error(`machine_reference_candidate_hash_mismatch:${item.case_id}:${profile}`);
        const judgment = {
          judge_name: result.judge_name ?? profile,
          profile_id: profile,
          model_family: result.model_family ?? "",
          model_version: result.model_version ?? "",
          prompt_hash: result.prompt_hash ?? "",
          candidate_hash: candidateHash,
          verdict: result.verdict ?? result.route ?? "",
          confidence: result.confidence,
          reason_codes: Array.isArray(result.reason_codes) ? result.reason_codes.map(String).slice(0, 32) : [],
          support_selector: Array.isArray(result.support_selector ?? result.support) ? (result.support_selector ?? result.support).map(String).slice(0, 16) : [],
          signature: result.signature ?? "",
          public_key_fingerprint: result.public_key_fingerprint ?? "",
          label: result.label
        };
        judgments.push(judgment);
      }
      rounds.push(judgments);
    }
    const council = evaluateMachineReferenceCouncil({
      first: rounds[0],
      second: rounds[1],
      candidate_hash: sha(stableJson(item)),
      producer_model_families: producerModelFamilies,
      producer_model_versions: producerModelVersions
    });
    const payload = { case_id: item.case_id, first: rounds[0], second: rounds[1], ...council };
    results.push({ ...payload, judgment_hashes: rounds.flat().map((row) => sha(stableJson(row))) });
  }
  const output = {
    schema_version: 1,
    dataset_id: MACHINE_REFERENCE_DATASET_ID,
    seed_hash: requestedSeedHash,
    rubric_hash: args.get("--rubric-hash", null),
    contract_hash: args.get("--contract-hash", null),
    prompt_hash: args.get("--prompt-hash", null),
    reason_code_hash: args.get("--reason-code-hash", null),
    cases: results,
    privacy: { reasoning_persisted: false, raw_transcript_copied: false, real_credentials_or_pii: false }
  };
  const signed = { ...output, ...sign(output, signingKey) };
  await writePrivate(args.get("--output"), signed);
  process.stdout.write(`${JSON.stringify({ ok: true, cases: results.length, output: path.resolve(args.get("--output")) })}\n`);
}

async function generateCommand(args) {
  const result = await generateMachineReferenceDirectory({
    seedFile: args.get("--seed-file"),
    outputDir: args.get("--output-dir"),
    count: Number(args.get("--count", MACHINE_REFERENCE_CANDIDATE_COUNT))
  });
  process.stdout.write(`${JSON.stringify({ ok: true, dataset_id: result.dataset_id, cases: result.cases.length, cases_sha256: result.cases_sha256, output_dir: result.output_dir })}\n`);
}

async function sealCommand(args) {
  const cases = await readJsonl(args.get("--cases"));
  const council = await readJson(args.get("--council"));
  const caseSeedHashes = new Set(cases.map((item) => item.seed_hash).filter(Boolean));
  if (caseSeedHashes.size > 1) throw new Error("machine_reference_seed_mismatch");
  const caseSeedHash = [...caseSeedHashes][0] ?? null;
  const requestedSeedHash = args.get("--seed-hash", council.seed_hash ?? caseSeedHash);
  if (caseSeedHash && requestedSeedHash && requestedSeedHash !== caseSeedHash) throw new Error("machine_reference_seed_mismatch");
  if (!council.signature || !council.public_key_fingerprint) throw new Error("machine_reference_council_signature_missing");
  if (args.get("--council-public-key") && !verifyTopLevelSignature(council, args.get("--council-public-key"))) {
    throw new Error("machine_reference_council_signature_invalid");
  }
  const result = sealMachineReference(cases, council.cases, {
    seed_hash: requestedSeedHash,
    rubric_hash: args.get("--rubric-hash", council.rubric_hash),
    contract_hash: args.get("--contract-hash", council.contract_hash),
    prompt_hash: args.get("--prompt-hash", council.prompt_hash),
    reason_code_hash: args.get("--reason-code-hash", council.reason_code_hash),
    metamorphic: {
      pair_count: Number(args.get("--metamorphic-pairs", 0)),
      violation_count: Number(args.get("--metamorphic-violations", 0))
    },
    datasetId: args.get("--dataset-id", MACHINE_REFERENCE_DATASET_ID),
    council_signature: council.signature ?? null,
    council_public_key_fingerprint: council.public_key_fingerprint ?? null,
    council_key_fingerprints: [...new Set(council.cases.flatMap((item) => [
      ...(item.first ?? []),
      ...(item.second ?? [])
    ].map((row) => row.public_key_fingerprint).filter(Boolean)))]
  });
  const outputDir = path.resolve(args.get("--output-dir"));
  try {
    const existing = await readJson(path.join(outputDir, "seal.json"));
    if (existing.seed_hash && existing.seed_hash === result.seed_hash) throw new Error("machine_reference_seed_reuse");
  } catch (error) {
    if (error?.message === "machine_reference_seed_reuse") throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  await writePrivate(path.join(outputDir, "sealed-cases.jsonl"), result.selectedCases, true);
  await writePrivate(path.join(outputDir, "sealed-gold.jsonl"), result.gold, true);
  await writePrivate(path.join(outputDir, "seal.json"), result);
  process.stdout.write(`${JSON.stringify({ ok: true, selected_case_count: result.selected_case_count, output_dir: outputDir })}\n`);
}

async function evaluateCommand(args) {
  const seal = await readJson(args.get("--seal"));
  if (seal.evaluated === true) throw new Error("machine_reference_seal_already_evaluated_new_version_required");
  const cases = await readJsonl(args.get("--cases"));
  const gold = await readJsonl(args.get("--gold"));
  const predictions = await readJsonl(args.get("--predictions"));
  const outcomes = args.get("--observed-outcomes") ? await readJson(args.get("--observed-outcomes")) : { passed: false, status: "insufficient_evidence" };
  const report = evaluateMachineReferencePredictions({ seal, cases, gold, predictions, observedOutcomes: outcomes });
  await writePrivate(args.get("--output"), report);
  await writePrivate(args.get("--seal"), { ...seal, evaluated: true, evaluation_report_sha256: sha(JSON.stringify(report)) });
  process.stdout.write(`${JSON.stringify({ ok: report.passed, status: report.status, output: path.resolve(args.get("--output")) })}\n`);
  if (!report.passed) process.exitCode = 1;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === "generate") return generateCommand(args);
  if (args.command === "judge") return judgeCommand(args);
  if (args.command === "seal") return sealCommand(args);
  if (args.command === "evaluate") return evaluateCommand(args);
  throw new Error("machine_reference_command_required");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
