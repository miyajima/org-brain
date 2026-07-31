#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const FINAL_EVALUATION_QUOTAS = Object.freeze({
  user: 28,
  assistant: 22,
  preference: 12,
  temporal: 54,
  update: 32,
  "multi-session": 52
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildFinalEvaluationSeal(rows, developmentIds, options = {}) {
  if (!Array.isArray(rows)) throw new Error("final evaluation payload must be an array");
  const ids = rows.map((row) => String(row.id ?? row.question_id ?? ""));
  if (ids.some((id) => !id)) throw new Error("every row requires id or question_id");
  if (new Set(ids).size !== ids.length) throw new Error("final evaluation IDs must be unique");
  const overlap = ids.filter((id) => developmentIds.has(id));
  if (overlap.length > 0) throw new Error(`development overlap detected: ${overlap.length}`);
  for (const row of rows) {
    if (!Object.hasOwn(FINAL_EVALUATION_QUOTAS, row.category)) {
      throw new Error(`unsupported category: ${row.category}`);
    }
    if (!String(row.question ?? "").trim()) throw new Error(`${row.id}: question is required`);
    if (!String(row.answer ?? "").trim()) throw new Error(`${row.id}: answer is required`);
    if (!Array.isArray(row.evidence_session_ids) || row.evidence_session_ids.length === 0) {
      throw new Error(`${row.id}: evidence_session_ids are required`);
    }
    const audit = row.audit;
    if (
      !audit ||
      audit.question_verified !== true ||
      audit.answer_verified !== true ||
      audit.evidence_verified !== true ||
      !String(audit.reviewer ?? "").trim() ||
      !String(audit.reviewed_at ?? "").trim()
    ) {
      throw new Error(`${row.id}: independent audit is incomplete`);
    }
  }
  const counts = Object.fromEntries(
    Object.keys(FINAL_EVALUATION_QUOTAS).map((category) => [
      category,
      rows.filter((row) => row.category === category).length
    ])
  );
  for (const [category, quota] of Object.entries(FINAL_EVALUATION_QUOTAS)) {
    if (counts[category] !== quota) {
      throw new Error(`${category} has ${counts[category]} rows; ${quota} required`);
    }
  }
  const payload = canonicalJson(rows);
  return {
    benchmark: "orgbrain-final-sealed-200-v1",
    status: "sealed-before-freeze",
    question_count: rows.length,
    category_quotas: FINAL_EVALUATION_QUOTAS,
    development_overlap: 0,
    audit: {
      all_questions_reviewed: true,
      all_answers_reviewed: true,
      all_evidence_sessions_reviewed: true,
      reviewer_count: new Set(rows.map((row) => row.audit.reviewer)).size
    },
    dataset_sha256: sha256(payload),
    selected_ids_sha256: sha256([...ids].sort().join("\n")),
    development_ids_sha256: sha256([...developmentIds].sort().join("\n")),
    sealed_at: options.sealedAt ?? new Date().toISOString()
  };
}

function parseArgs(argv) {
  const options = { payload: null, development: [], output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === "--payload") options.payload = next();
    else if (arg === "--development") options.development.push(next());
    else if (arg === "--output") options.output = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.payload || !options.output || options.development.length === 0) {
    throw new Error("--payload, at least one --development, and --output are required");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = JSON.parse(await readFile(options.payload, "utf8"));
  const developmentIds = new Set();
  for (const path of options.development) {
    const development = JSON.parse(await readFile(path, "utf8"));
    for (const row of development) {
      developmentIds.add(String(row.id ?? row.question_id ?? row.source_question_id ?? ""));
    }
  }
  const seal = buildFinalEvaluationSeal(rows, developmentIds);
  await writeFile(options.output, `${JSON.stringify(seal, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(seal, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
