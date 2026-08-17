import { createHash } from "node:crypto";
import {
  MEMORY_CONTRACT_V2_PROMPT,
  MEMORY_CONTRACT_V2_PROMPT_ID,
  MEMORY_CONTRACT_V2_SCHEMA_VERSION,
  MEMORY_CONTRACT_V2_VERIFIER_VERSION
} from "./memory-contract-v2-runtime.mjs";
import { MEMORY_CONTRACT_V2_REASON_CODE_DESCRIPTIONS } from "./memory-contract-v2-reason-codes.mjs";

// This is the exact source digest of schemas/memory_contract_v2.schema.json.
// The contract check script fails when the schema changes without this manifest
// being regenerated, so adapters cannot silently drift from the shared schema.
export const MEMORY_CONTRACT_V2_SCHEMA_SOURCE_HASH =
  "sha256:453779956bdab2bace666f49dba63db0e077a822af5363ae3bc8ed5749e5d691";
export const MEMORY_CONTRACT_V2_REASON_CODES_SOURCE_HASH =
  "sha256:431a804af352bb2202724c04b3c65231ff805fac4a285fbab397c1744ef79de8";
export const MEMORY_INGESTION_REGRESSION_V3_FIXTURE_HASH =
  "sha256:b68f1f9678c719e000d6e6a0a0c96b81c25f367f795279eb59b619ad47c59939";

export const MEMORY_CONTRACT_V2_JUDGE_PROFILES = Object.freeze([
  Object.freeze({
    id: "evidence_entailment",
    model_family: "family-a",
    instruction: "Reject when any durable claim is not supported by the supplied admissible evidence selectors."
  }),
  Object.freeze({
    id: "durability_atomicity",
    model_family: "family-b",
    instruction: "Reject compound, transient, inferred, or over-broad claims that are not one durable atomic event."
  }),
  Object.freeze({
    id: "future_reuse_overgeneralization",
    model_family: "family-a",
    instruction: "Reject when reuse conditions are missing, over-generalized, or unsafe outside the observed scope."
  })
]);

export const MEMORY_CONTRACT_V2_PROMPT_HASH = `sha256:${createHash("sha256")
  .update(MEMORY_CONTRACT_V2_PROMPT, "utf8")
  .digest("hex")}`;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export const MEMORY_CONTRACT_V2_REASON_CODES_HASH = `sha256:${createHash("sha256")
  .update(stableJson(MEMORY_CONTRACT_V2_REASON_CODE_DESCRIPTIONS), "utf8")
  .digest("hex")}`;

export const MEMORY_CONTRACT_V2_CONTRACT_MANIFEST = Object.freeze({
  schema_version: MEMORY_CONTRACT_V2_SCHEMA_VERSION,
  prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
  prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
  schema_source_hash: MEMORY_CONTRACT_V2_SCHEMA_SOURCE_HASH,
  reason_codes_hash: MEMORY_CONTRACT_V2_REASON_CODES_HASH,
  ingestion_regression_fixture_hash: MEMORY_INGESTION_REGRESSION_V3_FIXTURE_HASH,
  verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
  judge_profiles: MEMORY_CONTRACT_V2_JUDGE_PROFILES.map(({ id, model_family, instruction }) => ({
    id,
    model_family,
    instruction
  }))
});

export const MEMORY_CONTRACT_V2_CONTRACT_HASH =
  "sha256:f5a78848ffc628bd146740dbaa0b2780dd60e601a5b7ae63e337ce044cd3d3bb";
