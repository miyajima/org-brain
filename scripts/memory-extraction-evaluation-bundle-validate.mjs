#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CALIBRATION_QUOTAS,
  DEFAULT_LOCKED_QUOTAS,
  EVALUATION_CONTRACT
} from "./memory-extraction-evaluation-bundle.mjs";
import { stripMemoryCitationBlocks } from "../packages/shared/src/memory-extraction-review-text-runtime.mjs";

const ABSOLUTE_PATH = /(?:^|[\s"'`])\/(?:Users|home)\/[^\s"'`]+|\b[A-Za-z]:\\Users\\[^\s"'`]+/u;
const CREDENTIAL = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}\b|\bAKIA[A-Z0-9]{16}\b/u;
const COHORTS = ["decision", "success", "failure", "non_durable"];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sourceHash(turns) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(stableValue(turns)), "utf8").digest("hex")}`;
}

function assert(condition, reason) {
  if (!condition) throw new Error(`evaluation_bundle_invalid:${reason}`);
}

export function validateEvaluationBundle(bundle, options = {}) {
  assert(bundle && typeof bundle === "object" && !Array.isArray(bundle), "root");
  assert(bundle.contract === EVALUATION_CONTRACT, "contract");
  assert(typeof bundle.set_id === "string" && bundle.set_id.trim(), "set_id");
  assert(typeof bundle.frozen_at === "string" && Number.isFinite(Date.parse(bundle.frozen_at)), "frozen_at");
  assert(bundle.privacy?.source === "local_codex_sessions", "privacy_source");
  assert(bundle.privacy?.raw_transcript_persisted === false, "raw_transcript_persisted");
  assert(bundle.privacy?.reasoning_read === false, "reasoning_read");
  assert(bundle.privacy?.absolute_paths_included === false, "absolute_paths_included");
  assert(bundle.privacy?.external_network === false, "external_network");
  assert(Array.isArray(bundle.cases) && bundle.cases.length > 0, "cases");
  if (options.expectedTotal !== undefined) assert(bundle.cases.length === options.expectedTotal, `total:${bundle.cases.length}/${options.expectedTotal}`);

  const seenCases = new Set();
  const phaseSessions = { calibration: new Set(), locked: new Set() };
  const counts = {
    calibration: { decision: 0, success: 0, failure: 0, non_durable: 0 },
    locked: { decision: 0, success: 0, failure: 0, non_durable: 0 }
  };
  let lockedStarted = false;
  let sensitive = 0;
  for (const item of bundle.cases) {
    assert(item && typeof item === "object", "case_object");
    assert(typeof item.id === "string" && item.id && !seenCases.has(item.id), "case_id");
    seenCases.add(item.id);
    assert(item.phase === "calibration" || item.phase === "locked", `phase:${item.id}`);
    if (item.phase === "locked") lockedStarted = true;
    if (lockedStarted) assert(item.phase !== "calibration", "calibration_after_locked");
    assert(COHORTS.includes(item.cohort), `cohort:${item.id}`);
    counts[item.phase][item.cohort] += 1;
    assert(typeof item.session_hash === "string" && /^[a-f0-9]{64}$/u.test(item.session_hash), `session_hash:${item.id}`);
    phaseSessions[item.phase].add(item.session_hash);
    assert(Array.isArray(item.turns) && item.turns.length > 0, `turns:${item.id}`);
    assert(item.source_hash === sourceHash(item.turns), `source_hash:${item.id}`);
    const seenTurns = new Set();
    const seenTurnContent = new Set();
    for (const turn of item.turns) {
      assert(typeof turn.id === "string" && turn.id && !seenTurns.has(turn.id), `turn_id:${item.id}`);
      seenTurns.add(turn.id);
      assert(["user", "assistant", "tool", "system"].includes(turn.role), `turn_role:${item.id}`);
      assert(typeof turn.content === "string" && turn.content.trim(), `turn_content:${item.id}`);
      assert(!ABSOLUTE_PATH.test(turn.content), `absolute_path:${item.id}`);
      assert(!CREDENTIAL.test(turn.content), `credential:${item.id}`);
      const duplicateKey = `${turn.role}\0${stripMemoryCitationBlocks(turn.content).replace(/\s+/gu, " ").trim()}`;
      assert(!seenTurnContent.has(duplicateKey), `duplicate_turn:${item.id}`);
      seenTurnContent.add(duplicateKey);
    }
    const aliases = item.turn_aliases ?? {};
    assert(aliases && typeof aliases === "object" && !Array.isArray(aliases), `turn_aliases:${item.id}`);
    for (const [alias, target] of Object.entries(aliases)) {
      assert(typeof alias === "string" && alias && !seenTurns.has(alias), `turn_alias_collision:${item.id}`);
      assert(typeof target === "string" && seenTurns.has(target), `turn_alias_target:${item.id}`);
    }
    assert(item.retention_class === "standard" || item.retention_class === "sensitive", `retention_class:${item.id}`);
    if (item.retention_class === "sensitive") sensitive += 1;
    const retentionDays = item.retention_class === "sensitive" ? 7 : 180;
    const expectedExpiry = new Date(Date.parse(bundle.frozen_at) + retentionDays * 24 * 60 * 60 * 1_000).toISOString();
    assert(item.expires_at === expectedExpiry, `expires_at:${item.id}`);
    assert(!Object.hasOwn(item, "eligible_cohorts"), `eligible_cohorts_exposed:${item.id}`);
    assert(!Object.hasOwn(item, "inclusion_probability"), `unverified_probability_exposed:${item.id}`);
  }
  assert([...phaseSessions.calibration].every((session) => !phaseSessions.locked.has(session)), "session_overlap");

  const expectedPhaseQuotas = options.expectedPhaseQuotas;
  if (expectedPhaseQuotas) {
    for (const phase of ["calibration", "locked"]) {
      for (const cohort of COHORTS) {
        assert(counts[phase][cohort] === Number(expectedPhaseQuotas[phase][cohort] ?? 0),
          `quota:${phase}:${cohort}:${counts[phase][cohort]}/${expectedPhaseQuotas[phase][cohort] ?? 0}`);
      }
    }
  }
  return {
    ok: true,
    set_id: bundle.set_id,
    total: bundle.cases.length,
    counts,
    sensitive,
    session_overlap: 0,
    privacy: bundle.privacy
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}

export function main(argv = process.argv.slice(2)) {
  const inputValue = option(argv, "--input");
  if (!inputValue) throw new Error("--input is required");
  const input = path.resolve(inputValue);
  const stat = fs.statSync(input);
  assert(stat.isFile(), "input_not_file");
  assert((stat.mode & 0o077) === 0, `file_mode:${(stat.mode & 0o777).toString(8)}`);
  const bundle = JSON.parse(fs.readFileSync(input, "utf8"));
  const result = validateEvaluationBundle(bundle, {
    expectedTotal: 500,
    expectedPhaseQuotas: {
      calibration: DEFAULT_CALIBRATION_QUOTAS,
      locked: DEFAULT_LOCKED_QUOTAS
    }
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
