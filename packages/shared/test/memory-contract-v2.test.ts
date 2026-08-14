import { describe, expect, it } from "vitest";
import { validateMemoryContractV2Event } from "../src/ajv";
import { normalizeMemoryContractV2Event } from "../src/memory-contract-v2";

const base = {
  record_type: "learning_observation",
  schema_version: 2,
  trigger: "ユーザーが保存方針を選択した",
  applicability: { target_files: ["docs/MEMORY_CONTRACT_V2.md"], components: ["Codex hooks"] },
  gaps: []
};

describe("Memory Contract v2 normalizer", () => {
  it("exposes an executable AI input schema with closed top-level fields", () => {
    const valid = validateMemoryContractV2Event({
      ...base,
      lesson_type: "decision",
      capture_intent: "verify",
      decision_type: "user_choice",
      decision_key: "agent_rollout",
      question: "どのAgentから認証しますか？",
      selected_value: "共通契約＋Codex先行",
      rationale: null,
      constraints: [],
      alternatives: [],
      evidence_selectors: [{ type: "user_statement", ref: "共通契約＋Codex先行", supports: ["selected_value"] }]
    });
    expect(valid).toBe(true);
    expect(validateMemoryContractV2Event.errors).toBeNull();
    expect(validateMemoryContractV2Event({
      ...base,
      lesson_type: "decision",
      capture_intent: "verify",
      decision_type: "user_choice",
      decision_key: "agent_rollout",
      question: "どのAgentから認証しますか？",
      selected_value: "共通契約＋Codex先行",
      evidence_selectors: [{ type: "user_statement", ref: "共通契約＋Codex先行", supports: ["selected_value"] }],
      injected_id: "must be rejected"
    })).toBe(false);
    expect(validateMemoryContractV2Event({
      ...base,
      lesson_type: "success",
      capture_intent: "review",
      evidence_selectors: [],
      gaps: ["outcome evidence is pending"]
    })).toBe(true);
  });

  it("accepts an explicit user choice without inventing rationale", async () => {
    const result = await normalizeMemoryContractV2Event({
      ...base,
      lesson_type: "decision",
      capture_intent: "verify",
      decision_type: "user_choice",
      decision_key: "agent_rollout",
      question: "どのAgentから認証しますか？",
      selected_value: "共通契約＋Codex先行",
      rationale: null,
      constraints: [],
      alternatives: [],
      evidence_selectors: [{ type: "user_statement", ref: "共通契約＋Codex先行", supports: ["selected_value"] }]
    });
    expect(result.accepted).toBe(true);
    expect(result.event?.rationale).toBeNull();
    expect(result.event?.decision_key).toBe("agent_rollout");
    expect(result.event_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps incomplete observations as review candidates and rejects them for verify", async () => {
    const review = await normalizeMemoryContractV2Event({
      ...base,
      lesson_type: "success",
      capture_intent: "review",
      gaps: ["成功した検証結果がまだない"],
      evidence_selectors: []
    });
    expect(review.accepted).toBe(true);
    expect(review.event?.capture_intent).toBe("review");
    expect(review.reason_codes).toContain("gaps_present");

    const verify = await normalizeMemoryContractV2Event({
      ...base,
      lesson_type: "success",
      capture_intent: "verify",
      evidence_selectors: []
    });
    expect(verify.accepted).toBe(false);
    expect(verify.event).toBeNull();
  });

  it("requires a digest for deterministic tool-result evidence and rejects secrets", async () => {
    const missingDigest = await normalizeMemoryContractV2Event({
      ...base,
      lesson_type: "decision",
      capture_intent: "verify",
      decision_type: "user_choice",
      decision_key: "review_policy",
      question: "人間reviewerを必須にしますか？",
      selected_value: "AIのみ",
      rationale: null,
      constraints: [],
      alternatives: [],
      evidence_selectors: [{ type: "tool_result", ref: "AIのみ", supports: ["selected_value"] }]
    });
    expect(missingDigest.accepted).toBe(false);
    expect(missingDigest.reason_codes).toContain("evidence_selector_0_digest_required_for_tool_result");

    const secret = await normalizeMemoryContractV2Event({
      ...base,
      lesson_type: "decision",
      capture_intent: "verify",
      decision_type: "user_choice",
      decision_key: "secret_test",
      question: "保存しますか？",
      selected_value: "api_key=supersecretvalue123",
      rationale: null,
      constraints: [],
      alternatives: [],
      evidence_selectors: [{ type: "user_statement", ref: "api_key=supersecretvalue123", supports: ["selected_value"] }]
    });
    expect(secret.accepted).toBe(false);
    expect(secret.reason_codes).toContain("credential_detected");
  });

  it("requires rationale and rejected alternatives for implementation decisions", async () => {
    const result = await normalizeMemoryContractV2Event({
      ...base,
      lesson_type: "decision",
      capture_intent: "verify",
      decision_type: "implementation",
      decision_key: "storage_backend",
      question: "どの保存方式を採用しますか？",
      decision: "SQLite",
      constraints: [],
      evidence_selectors: [{ type: "user_statement", ref: "SQLite", supports: ["decision"] }]
    });
    expect(result.accepted).toBe(false);
    expect(result.reason_codes).toContain("rationale_required_for_decision_type");
    expect(result.reason_codes).toContain("alternatives_required_for_decision_type");
  });
});
