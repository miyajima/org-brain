#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { certifyMemoryQuality } from "../packages/shared/src/memory-quality-certifier.mjs";

export function main(argv = process.argv.slice(2)) {
  const manifestArg = argv.indexOf("--manifest");
  const outputArg = argv.indexOf("--output");
  if (manifestArg < 0 || !argv[manifestArg + 1]) throw new Error("--manifest is required");
  const manifestPath = path.resolve(argv[manifestArg + 1]);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.raw_transcript || manifest.transcripts || manifest.prompt_text || manifest.response_text) {
    throw new Error("quality manifest must not embed raw transcript text");
  }
  const result = certifyMemoryQuality(manifest, { threshold: 95 });
  const output = outputArg >= 0 && argv[outputArg + 1] ? path.resolve(argv[outputArg + 1]) : null;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
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

