#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { MEMORY_CONTRACT_V2_PROMPT } from "../packages/shared/src/memory-contract-v2-runtime.mjs";
import {
  MEMORY_CONTRACT_V2_CONTRACT_HASH,
  MEMORY_CONTRACT_V2_CONTRACT_MANIFEST,
  MEMORY_CONTRACT_V2_JUDGE_PROFILES,
  MEMORY_CONTRACT_V2_PROMPT_HASH,
  MEMORY_CONTRACT_V2_REASON_CODES_HASH,
  MEMORY_CONTRACT_V2_SCHEMA_SOURCE_HASH
} from "../packages/shared/src/memory-contract-v2-contract.mjs";
import { MEMORY_CONTRACT_V2_REASON_CODE_DESCRIPTIONS } from "../packages/shared/src/memory-contract-v2-reason-codes.mjs";

function hash(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export async function checkMemoryContractV2() {
  const schemaUrl = new URL("../packages/shared/schemas/memory_contract_v2.schema.json", import.meta.url);
  const schemaText = await readFile(schemaUrl, "utf8");
  const schemaHash = hash(schemaText);
  const promptHash = hash(MEMORY_CONTRACT_V2_PROMPT);
  const reasonCodesHash = hash(stableJson(MEMORY_CONTRACT_V2_REASON_CODE_DESCRIPTIONS));
  const contractHash = hash(stableJson(MEMORY_CONTRACT_V2_CONTRACT_MANIFEST));
  const profileIds = MEMORY_CONTRACT_V2_JUDGE_PROFILES.map((profile) => profile.id);
  const uniqueProfileIds = new Set(profileIds);
  const familyCount = new Set(MEMORY_CONTRACT_V2_JUDGE_PROFILES.map((profile) => profile.model_family)).size;
  const checks = {
    schema_source_hash: schemaHash === MEMORY_CONTRACT_V2_SCHEMA_SOURCE_HASH,
    prompt_hash: promptHash === MEMORY_CONTRACT_V2_PROMPT_HASH,
    reason_codes_hash: reasonCodesHash === MEMORY_CONTRACT_V2_REASON_CODES_HASH &&
      MEMORY_CONTRACT_V2_CONTRACT_MANIFEST.reason_codes_hash === reasonCodesHash,
    contract_hash: contractHash === MEMORY_CONTRACT_V2_CONTRACT_HASH,
    judge_profiles_unique: uniqueProfileIds.size === profileIds.length,
    judge_profiles_independent_families: familyCount >= 2,
    judge_profiles_complete: profileIds.length === 3
  };
  return { ok: Object.values(checks).every(Boolean), checks, hashes: {
    schema_source_hash: schemaHash,
    prompt_hash: promptHash,
    reason_codes_hash: reasonCodesHash,
    contract_hash: contractHash
  } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const report = await checkMemoryContractV2();
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
