#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUBRIC_PATH = resolve(scriptDirectory, "../docs/product-ux-evaluation-rubric-v1.json");
export const DEFAULT_INPUT_SCHEMA_PATH = resolve(scriptDirectory, "../docs/product-ux-scorecard.schema.json");
const inputSchema = JSON.parse(await readFile(DEFAULT_INPUT_SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("date", {
  type: "string",
  validate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }
});
const validatePublishedInputSchema = ajv.compile(inputSchema);

const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};
const sum = (values) => values.reduce((total, value) => total + value, 0);
const unique = (values) => new Set(values).size === values.length;

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function validateRubric(rubric) {
  assertCondition(rubric?.schema_version === 1, "rubric.schema_version must be 1");
  assertCondition(typeof rubric.method_version === "string" && rubric.method_version.length > 0, "rubric.method_version is required");
  assertCondition(Array.isArray(rubric.axes) && rubric.axes.length > 0, "rubric.axes must not be empty");
  assertCondition(unique(rubric.axes.map((axis) => axis.id)), "rubric axis ids must be unique");
  assertCondition(Math.abs(sum(rubric.axes.map((axis) => axis.weight)) - 1) < 1e-9, "rubric axis weights must sum to 1");

  const itemIds = [];
  for (const axis of rubric.axes) {
    assertCondition(Array.isArray(axis.items) && axis.items.length > 0, `axis ${axis.id} must have items`);
    assertCondition(Math.abs(sum(axis.items.map((item) => item.weight)) - 1) < 1e-9, `axis ${axis.id} item weights must sum to 1`);
    itemIds.push(...axis.items.map((item) => item.id));
  }
  assertCondition(unique(itemIds), "rubric item ids must be unique");
  return rubric;
}

export function validateScorecardInput(rubric, input) {
  if (!validatePublishedInputSchema(input)) {
    const details = (validatePublishedInputSchema.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`input does not match ${DEFAULT_INPUT_SCHEMA_PATH}: ${details}`);
  }
  assertCondition(unique(input.evidence.map((item) => item.id)), "evidence ids must be unique");
  assertCondition(unique(input.measurements.map((item) => item.id)), "measurement ids must be unique");

  const expectedIds = rubric.axes.flatMap((axis) => axis.items.map((item) => item.id));
  const actualIds = input.measurements.map((item) => item.id);
  const missing = expectedIds.filter((id) => !actualIds.includes(id));
  const extra = actualIds.filter((id) => !expectedIds.includes(id));
  assertCondition(missing.length === 0, `missing measurements: ${missing.join(", ")}`);
  assertCondition(extra.length === 0, `unknown measurements: ${extra.join(", ")}`);
  return input;
}

function severityFor(findings) {
  const order = ["none", "low", "medium", "high", "critical"];
  return findings.reduce((highest, finding) => order.indexOf(finding.severity) > order.indexOf(highest) ? finding.severity : highest, "none");
}

export function buildScorecard(rubricInput, input) {
  const rubric = validateRubric(structuredClone(rubricInput));
  validateScorecardInput(rubric, input);

  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const measurementById = new Map(input.measurements.map((item) => [item.id, item]));
  const findingIds = new Set();
  const findings = [];

  const axes = rubric.axes.map((axis) => {
    const items = axis.items.map((definition) => {
      const measurement = measurementById.get(definition.id);
      assertCondition(Number.isInteger(measurement.raw_score) || measurement.raw_score === null, `${definition.id}.raw_score must be an integer or null`);
      if (measurement.raw_score !== null) {
        assertCondition(measurement.raw_score >= 0 && measurement.raw_score <= 100, `${definition.id}.raw_score must be between 0 and 100`);
      }
      assertCondition(Array.isArray(measurement.evidence), `${definition.id}.evidence must be an array`);
      assertCondition(Array.isArray(measurement.findings), `${definition.id}.findings must be an array`);

      const referencedEvidence = measurement.evidence.map((id) => {
        const evidence = evidenceById.get(id);
        assertCondition(evidence, `${definition.id} references unknown evidence ${id}`);
        assertCondition(Object.hasOwn(rubric.evidence_caps, evidence.mode), `${id} has unknown evidence mode ${evidence.mode}`);
        return evidence;
      });
      const evidenceMode = referencedEvidence.reduce((best, evidence) =>
        rubric.evidence_caps[evidence.mode] > rubric.evidence_caps[best] ? evidence.mode : best, "unverified");
      const evidenceCap = rubric.evidence_caps[evidenceMode];
      const severity = severityFor(measurement.findings);
      const severityCap = rubric.severity_caps[severity];
      const verified = measurement.raw_score !== null && evidenceMode !== "unverified";
      const score = verified ? Math.min(measurement.raw_score, evidenceCap, severityCap) : 0;

      for (const finding of measurement.findings) {
        assertCondition(!findingIds.has(finding.id), `finding id ${finding.id} is assigned more than once`);
        assertCondition(Object.hasOwn(rubric.severity_caps, finding.severity), `${finding.id} has unknown severity ${finding.severity}`);
        findingIds.add(finding.id);
        findings.push({ ...finding, primary_item: definition.id, evidence: [...measurement.evidence] });
      }

      return {
        id: definition.id,
        label: definition.label,
        weight: definition.weight,
        raw_score: measurement.raw_score,
        score,
        verified,
        evidence_mode: evidenceMode,
        evidence_cap: evidenceCap,
        severity,
        severity_cap: severityCap,
        evidence: [...measurement.evidence],
        metrics: measurement.metrics ?? {},
        notes: measurement.notes
      };
    });

    const exactScore = sum(items.map((item) => item.score * item.weight));
    const exactCoverage = sum(items.map((item) => (item.verified ? item.weight : 0)));
    const minimum = axis.focus ? rubric.gates.focus_axis_minimum : rubric.gates.other_axis_minimum;
    return {
      id: axis.id,
      label: axis.label,
      weight: axis.weight,
      focus: axis.focus,
      minimum,
      score: round(exactScore),
      coverage: round(exactCoverage, 4),
      passed: exactScore >= minimum,
      items,
      _exact_score: exactScore,
      _exact_coverage: exactCoverage
    };
  });

  const exactOverallScore = sum(axes.map((axis) => axis._exact_score * axis.weight));
  const exactCoverage = sum(axes.map((axis) => axis._exact_coverage * axis.weight));
  const blockingFindings = findings.filter((finding) => rubric.gates.blocking_severities.includes(finding.severity));
  const reasons = [];
  for (const axis of axes) {
    if (!axis.passed) reasons.push(`${axis.id}=${axis.score} is below ${axis.minimum}`);
  }
  if (exactOverallScore < rubric.gates.overall_minimum) reasons.push(`overall=${round(exactOverallScore)} is below ${rubric.gates.overall_minimum}`);
  if (exactCoverage < rubric.gates.coverage_minimum) reasons.push(`coverage=${round(exactCoverage * 100)}% is below ${round(rubric.gates.coverage_minimum * 100)}%`);
  if (blockingFindings.length > 0) reasons.push(`${blockingFindings.length} critical/high findings remain`);
  if (input.audit.consecutive_passes < rubric.gates.consecutive_passes) reasons.push(`${input.audit.consecutive_passes} consecutive passes is below ${rubric.gates.consecutive_passes}`);
  if (rubric.gates.ai_repeat_consistent && input.audit.ai_repeat_consistent !== true) reasons.push("AI repeat consistency is not verified");
  if (rubric.gates.cloud_live_verified && input.audit.cloud_live_verified !== true) reasons.push("Cloud live verification is not complete");
  if (rubric.gates.voiceover_manually_verified && input.audit.voiceover_manually_verified !== true) reasons.push("VoiceOver manual verification is not complete");

  const cleanAxes = axes.map(({ _exact_score, _exact_coverage, ...axis }) => axis);
  return {
    schema_version: 1,
    method_version: rubric.method_version,
    audit: structuredClone(input.audit),
    formula: {
      item: "min(raw_score, evidence_cap, severity_cap); unverified=0",
      axis: "sum(item.score * item.weight); no N/A renormalization",
      overall: "sum(axis.score * axis.weight)",
      coverage: "sum(verified item.weight * axis.weight)"
    },
    axes: cleanAxes,
    findings,
    overall: {
      score: round(exactOverallScore),
      coverage: round(exactCoverage, 4),
      coverage_percent: round(exactCoverage * 100),
      blocking_findings: blockingFindings.length,
      completion_accepted: reasons.length === 0,
      provisional: reasons.length > 0,
      reasons
    }
  };
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  assertCondition(args[index + 1], `${name} requires a value`);
  return args[index + 1];
}

export async function runCli(args = process.argv.slice(2)) {
  const inputPath = valueAfter(args, "--input");
  const outputPath = valueAfter(args, "--output");
  const rubricPath = valueAfter(args, "--rubric") ?? DEFAULT_RUBRIC_PATH;
  assertCondition(inputPath, "Usage: product-ux-scorecard.mjs --input <measurement-input.json> --output <scorecard.json> [--rubric <rubric.json>] [--require-pass]");
  assertCondition(outputPath, "--output is required");

  const [rubric, input] = await Promise.all([loadJson(resolve(rubricPath)), loadJson(resolve(inputPath))]);
  const scorecard = buildScorecard(rubric, input);
  const absoluteOutput = resolve(outputPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, `${JSON.stringify(scorecard, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: absoluteOutput, overall: scorecard.overall })}\n`);
  if (args.includes("--require-pass") && !scorecard.overall.completion_accepted) process.exitCode = 2;
  return scorecard;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await runCli();
