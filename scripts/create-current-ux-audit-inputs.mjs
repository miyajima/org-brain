#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_RUBRIC_PATH,
  loadJson,
  validateRubric,
  validateScorecardInput
} from "./product-ux-scorecard.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_AUDIT_ROOT = resolve(scriptDirectory, "../artifacts/product-ux-evaluation");

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  assertCondition(args[index + 1], `${name} requires a value`);
  return args[index + 1];
}

export async function registerAuditInput({ inputPath, phase, auditRoot = DEFAULT_AUDIT_ROOT, rubricPath = DEFAULT_RUBRIC_PATH }) {
  assertCondition(inputPath, "inputPath is required");
  assertCondition(/^[a-z0-9][a-z0-9-]*$/u.test(phase || ""), "phase must contain only lowercase letters, numbers, and hyphens");

  const [rubric, raw] = await Promise.all([
    loadJson(resolve(rubricPath)),
    readFile(resolve(inputPath), "utf8")
  ]);
  const input = JSON.parse(raw);
  validateScorecardInput(validateRubric(rubric), input);

  const target = resolve(auditRoot, input.audit.date, phase, "measurement-input.json");
  assertCondition(resolve(inputPath) !== target, "input must be a candidate file outside the destination phase");
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, `${JSON.stringify(input, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`audit input already exists and is immutable: ${target}`);
    }
    throw error;
  }
  return target;
}

export async function runCli(args = process.argv.slice(2)) {
  const inputPath = valueAfter(args, "--input");
  const phase = valueAfter(args, "--phase");
  const auditRoot = valueAfter(args, "--audit-root") ?? DEFAULT_AUDIT_ROOT;
  const rubricPath = valueAfter(args, "--rubric") ?? DEFAULT_RUBRIC_PATH;
  assertCondition(inputPath && phase, "Usage: create-current-ux-audit-inputs.mjs --input <candidate.json> --phase <phase> [--audit-root <directory>] [--rubric <rubric.json>]");
  const output = await registerAuditInput({ inputPath, phase, auditRoot, rubricPath });
  process.stdout.write(`${JSON.stringify({ output, immutable: true })}\n`);
  return output;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await runCli();
