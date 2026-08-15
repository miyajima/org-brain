#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  certifyMemoryContractQuality,
  certifyMemoryQuality
} from "../packages/shared/src/memory-quality-certifier.mjs";

export function main(argv = process.argv.slice(2)) {
  const manifestArg = argv.indexOf("--manifest");
  const oracleArg = argv.indexOf("--oracle-report");
  const calibrationArg = argv.indexOf("--calibration-report");
  const autonomousArg = argv.indexOf("--autonomous-report");
  const outputArg = argv.indexOf("--output");
  if (manifestArg < 0 || !argv[manifestArg + 1]) throw new Error("--manifest is required");
  const manifestPath = path.resolve(argv[manifestArg + 1]);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (oracleArg >= 0) {
    if (!argv[oracleArg + 1] || argv[oracleArg + 1].startsWith("--")) {
      throw new Error("--oracle-report requires a path");
    }
    manifest.oracle_qualification = JSON.parse(fs.readFileSync(path.resolve(argv[oracleArg + 1]), "utf8"));
  }
  if (calibrationArg >= 0) {
    if (!argv[calibrationArg + 1] || argv[calibrationArg + 1].startsWith("--")) {
      throw new Error("--calibration-report requires a path");
    }
    manifest.calibration_qualification = JSON.parse(fs.readFileSync(path.resolve(argv[calibrationArg + 1]), "utf8"));
  }
  if (autonomousArg >= 0) {
    if (!argv[autonomousArg + 1] || argv[autonomousArg + 1].startsWith("--")) {
      throw new Error("--autonomous-report requires a path");
    }
    manifest.autonomous_qualification = JSON.parse(fs.readFileSync(path.resolve(argv[autonomousArg + 1]), "utf8"));
  }
  if (manifest.raw_transcript || manifest.transcripts || manifest.prompt_text || manifest.response_text) {
    throw new Error("quality manifest must not embed raw transcript text");
  }
  const legacyHumanCompatibility = argv.includes("--legacy-human-compatibility");
  const result = manifest.schema_version === 2 || Array.isArray(manifest.measurements)
    ? certifyMemoryContractQuality(manifest, {
      threshold: 0.95,
      reaskUpperThreshold: 0.05,
      requireAutonomousQualification: !legacyHumanCompatibility
    })
    : certifyMemoryQuality(manifest, { threshold: 95 });
  const output = outputArg >= 0 && argv[outputArg + 1] ? path.resolve(argv[outputArg + 1]) : null;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(output), 0o700);
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(output, 0o600);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, output, certification: result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
