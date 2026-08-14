import { evaluateAiJudgeConsensus } from "./memory-quality-certifier.mjs";
import {
  MEMORY_CONTRACT_V2_PROMPT_ID,
  MEMORY_CONTRACT_V2_VERIFIER_VERSION
} from "./memory-contract-v2-runtime.mjs";
import {
  MEMORY_CONTRACT_V2_JUDGE_PROFILES,
  MEMORY_CONTRACT_V2_PROMPT_HASH
} from "./memory-contract-v2-contract.mjs";

export const MEMORY_CONTRACT_JUDGE_PROFILES = MEMORY_CONTRACT_V2_JUDGE_PROFILES;

export const MEMORY_CONTRACT_JUDGE_RESPONSE_SCHEMA = {
  type: "object",
  required: ["verdict", "reason_codes", "support"],
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    reason_codes: { type: "array", maxItems: 16, items: { type: "string", maxLength: 128 } },
    support: { type: "array", maxItems: 16, items: { type: "string", maxLength: 256 } }
  }
};

export const MEMORY_CONTRACT_JUDGE_PROMPT_HASH = MEMORY_CONTRACT_V2_PROMPT_HASH;

function boundedStrings(value, limit = 16, itemLimit = 256) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.normalize("NFKC").trim().slice(0, itemLimit)).filter(Boolean))].slice(0, limit)
    : [];
}

function candidateForJudge(candidate) {
  const observation = candidate?.observation && typeof candidate.observation === "object"
    ? candidate.observation
    : candidate?.learning && typeof candidate.learning === "object"
      ? candidate.learning
      : candidate;
  const verification = candidate?.verification && typeof candidate.verification === "object"
    ? candidate.verification
    : {};
  const evidence = Array.isArray(candidate?.evidence)
    ? candidate.evidence
    : Array.isArray(verification.evidence)
      ? verification.evidence
      : [];
  const allowedObservationFields = [
    "record_type", "schema_version", "lesson_type", "capture_intent", "trigger", "applicability",
    "evidence_selectors", "gaps", "kind", "conclusion", "rationale", "reuse_rule", "outcome",
    "procedure", "why_it_worked", "observed_outcome", "reuse_when", "decision_type", "decision_key",
    "question", "selected_value", "decision", "constraints", "alternatives", "symptom",
    "failed_approach", "root_cause", "correction", "verified_outcome", "avoidance_rule"
  ];
  const safeObservation = observation && typeof observation === "object"
    ? Object.fromEntries(allowedObservationFields.filter((key) => Object.hasOwn(observation, key)).map((key) => [key, observation[key]]))
    : {};
  return {
    observation: safeObservation,
    verification: {
      state: verification.state ?? verification.verification_state ?? "unverified",
      reason_codes: boundedStrings(verification.reason_codes, 16, 128),
      evidence: evidence.slice(0, 16).map((item) => ({
        type: typeof (item?.type ?? item?.evidence_type) === "string" ? (item.type ?? item.evidence_type).slice(0, 64) : "unknown",
        ref: typeof (item?.ref ?? item?.evidence_ref) === "string" ? (item.ref ?? item.evidence_ref).slice(0, 512) : null,
        content_hash: typeof (item?.content_hash ?? item?.digest) === "string" ? (item.content_hash ?? item.digest).slice(0, 128) : null,
        diff_hash: typeof (item?.diff_hash ?? item?.diffHash) === "string" ? (item.diff_hash ?? item.diffHash).slice(0, 128) : null,
        supports: boundedStrings(item?.supports, 12, 128)
      }))
    }
  };
}

export function buildMemoryContractJudgeRequest(candidate, profileId) {
  const profile = MEMORY_CONTRACT_JUDGE_PROFILES.find((item) => item.id === profileId);
  if (!profile) throw new Error(`unknown_memory_contract_judge_profile:${profileId}`);
  return {
    protocol: "orgbrain-memory-contract-judge-v2",
    prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
    prompt_hash: MEMORY_CONTRACT_JUDGE_PROMPT_HASH,
    verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
    profile_id: profile.id,
    model_family: profile.model_family,
    temperature: 0,
    instruction: profile.instruction,
    response_schema: MEMORY_CONTRACT_JUDGE_RESPONSE_SCHEMA,
    candidate: candidateForJudge(candidate)
  };
}

export function normalizeMemoryContractJudgeResult(profileId, result, modelFamily = null) {
  const profile = MEMORY_CONTRACT_JUDGE_PROFILES.find((item) => item.id === profileId);
  if (!profile) throw new Error(`unknown_memory_contract_judge_profile:${profileId}`);
  const verdict = result?.verdict === "pass" || result?.verdict === "fail" ? result.verdict : null;
  if (!verdict) throw new Error(`invalid_memory_contract_judge_verdict:${profileId}`);
  return {
    judge_name: profile.id,
    model_family: String(modelFamily ?? result?.model_family ?? profile.model_family).slice(0, 128),
    verdict,
    reason_codes: boundedStrings(result.reason_codes, 16, 128),
    support: boundedStrings(result.support, 16, 256),
    prompt_hash: MEMORY_CONTRACT_JUDGE_PROMPT_HASH
  };
}

export async function runMemoryContractJudgeConsensus(candidate, runners, options = {}) {
  if (!runners || typeof runners !== "object") throw new Error("judge_runners_required");
  const judgments = await Promise.all(MEMORY_CONTRACT_JUDGE_PROFILES.map(async (profile) => {
    const runner = runners[profile.id];
    if (typeof runner !== "function") throw new Error(`judge_runner_missing:${profile.id}`);
    const result = await runner(buildMemoryContractJudgeRequest(candidate, profile.id));
    return normalizeMemoryContractJudgeResult(profile.id, result, result?.model_family ?? options.model_families?.[profile.id]);
  }));
  return {
    ...evaluateAiJudgeConsensus(judgments, { requiredJudges: MEMORY_CONTRACT_JUDGE_PROFILES.length }),
    judgments
  };
}

export function isAiConsensusCertified(value) {
  const metadata = value?.learning?.contract_metadata && typeof value.learning.contract_metadata === "object"
    ? value.learning.contract_metadata
    : {};
  const declared = value?.ai_certification ?? value?.certification ?? value?.verification?.ai_certification ?? metadata.ai_certification;
  const consensus = value?.judge_consensus ?? value?.verification?.judge_consensus ?? metadata.judge_consensus;
  if (declared !== "ai_consensus_certified" || !consensus || typeof consensus !== "object") return false;
  const judgments = Array.isArray(consensus.judgments) ? consensus.judgments : [];
  const expectedNames = new Set(MEMORY_CONTRACT_JUDGE_PROFILES.map((profile) => profile.id));
  const actualNames = new Set(judgments.map((judgment) => judgment?.judge_name));
  const verifierVersion = value?.verifier_version ?? value?.verification?.verifier_version ?? metadata.verifier_version;
  const expectedProfile = (judgeName) => MEMORY_CONTRACT_JUDGE_PROFILES.find((profile) => profile.id === judgeName);
  if (
    judgments.length !== MEMORY_CONTRACT_JUDGE_PROFILES.length ||
    actualNames.size !== expectedNames.size ||
    [...actualNames].some((name) => !expectedNames.has(name)) ||
    judgments.some((judgment) => judgment?.prompt_hash !== MEMORY_CONTRACT_JUDGE_PROMPT_HASH) ||
    judgments.some((judgment) => {
      const profile = expectedProfile(judgment?.judge_name);
      return !profile || judgment?.model_family !== profile.model_family;
    }) ||
    (verifierVersion !== undefined && verifierVersion !== MEMORY_CONTRACT_V2_VERIFIER_VERSION)
  ) return false;
  return evaluateAiJudgeConsensus(judgments, { requiredJudges: MEMORY_CONTRACT_JUDGE_PROFILES.length }).pass === true;
}
