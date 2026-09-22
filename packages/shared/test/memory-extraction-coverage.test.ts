import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCoverageEvidenceGroups,
  buildMemoryExtractionPrompt,
  decideCoverageSecondPass,
  memoryExtractionProviderInputUpperBound,
  mergeCoverageCandidates,
  packCoverageGroups,
  selectCoverageEvidence,
  splitCoverageSentences,
  validateCoverageCandidate,
  verifiedCandidates
} from "../src/memory-extraction-provider-contract";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("memory extraction coverage/v1", () => {
  it("checks all qualifiers in a cited group's dependency closure", () => {
    const packet = { snippets: [
      { span_id: "a", role: "user", text: "APIを使う。" },
      { span_id: "b", role: "user", text: "ただし本番では使わない。" },
      { span_id: "c", role: "user", text: "障害時のみCLIを使う。" }
    ], events: [], coverage: { groups: [{ span_ids: ["a", "b", "c"] }] } };
    const candidate = { lesson_type: "decision", support_span_ids: ["a"], fields: [{ name: "decision", values: ["APIを使う。"] }] };
    expect(validateCoverageCandidate(candidate, packet).reason_codes).toContain("qualifier_not_retained");
    expect(validateCoverageCandidate({ ...candidate, support_span_ids: ["a", "b", "c"], fields: [{ name: "decision", values: packet.snippets.map((s) => s.text) }] }, packet).valid).toBe(true);
  });

  it("allows one qualified sentence to be partitioned across exact grounded fields", () => {
    const packet = { snippets: [
      { span_id: "a", role: "user", text: "違います。" },
      { span_id: "b", role: "user", text: "gRPC案は撤回し、社内画面に限ってJSON APIを採用します。" }
    ], events: [], coverage: { groups: [{ span_ids: ["a", "b"] }] } };
    const candidate = { lesson_type: "decision", support_span_ids: ["b"], fields: [
      { name: "rejected_approach", values: ["gRPC案は撤回し"] },
      { name: "condition", values: ["社内画面に限って"] },
      { name: "decision", values: ["JSON APIを採用します"] }
    ] };
    expect(validateCoverageCandidate(candidate, packet).valid).toBe(true);
    expect(validateCoverageCandidate({ ...candidate, fields: candidate.fields.filter((field) => field.name !== "condition") }, packet).reason_codes).toContain("qualifier_not_retained");
    const combined = { ...packet, snippets: [{ span_id: "b", role: "user", text: "違います。gRPC案は撤回し、社内画面に限ってJSON APIを採用します。" }], coverage: { groups: [{ span_ids: ["b"] }] } };
    expect(validateCoverageCandidate(candidate, combined).valid).toBe(true);
  });

  it("requires the actual result text and matching call for an outcome", () => {
    const candidate = { lesson_type: "success", support_span_ids: ["s", "e"], fields: [{ name: "observed_outcome", values: ["latency 10 ms"] }] };
    const packet = { snippets: [{ span_id: "s", role: "tool", source: "tool_result", call_id: "call-a", text: "latency 10 ms" }],
      events: [{ event_id: "e", call_id: "call-b", status: "completed", exit_code: 0 }] };
    expect(validateCoverageCandidate(candidate, packet).valid).toBe(false);
    packet.events[0].call_id = "call-a";
    expect(validateCoverageCandidate(candidate, packet).valid).toBe(true);
    expect(validateCoverageCandidate({ ...candidate, support_span_ids: ["s"] }, packet).valid).toBe(true);
    packet.snippets[0].source = "assistant";
    expect(validateCoverageCandidate(candidate, packet).valid).toBe(false);
  });
  it("keeps offsets and does not split decimals, versions, URLs, or Unicode", () => {
    const text = "v2.1は3.14を使う。URLはhttps://example.com/a.b です。次へ！";
    const spans = splitCoverageSentences([{ span_id: "s1", role: "user", text }], { hash_text: hash });
    expect(spans.map((span) => span.text)).toEqual(["v2.1は3.14を使う。", "URLはhttps://example.com/a.b です。", "次へ！"]);
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(span.text);
      expect(span.text_hash).toBe(hash(span.text));
    }
  });

  it("keeps qualifier dependencies atomic and omits whole groups", () => {
    const groups = buildCoverageEvidenceGroups([{ span_id: "s1", role: "user", text: "原則はAPIを使う。 ただし障害時だけCLIを使う。 次の決定を採用する。" }], [], { hash_text: hash });
    expect(groups[0].snippets).toHaveLength(3);
    const packed = packCoverageGroups({ schema: "learning-extraction-proposal/v2", extraction_profile: "coverage/v1", snippets: [] }, groups, {
      max_snippets: 1,
      upper_bound: () => 100
    });
    expect(packed.packet.snippets).toEqual([]);
    expect(packed.omitted[0].reason).toBe("input_budget");
  });

  it("limits the pool with IDs and reasons", () => {
    const groups = buildCoverageEvidenceGroups(Array.from({ length: 20 }, (_, index) => ({ span_id: `s${index}`, role: "user", text: `方針${index}を決定する。` })), [], { hash_text: hash });
    const selected = selectCoverageEvidence(groups);
    expect(selected.span_count).toBe(16);
    expect(selected.omitted).toHaveLength(4);
    expect(selected.omitted.every((row: any) => row.reason === "pool_limit")).toBe(true);
  });

  it("omits a group when an atomic dependency is missing", () => {
    const selected = selectCoverageEvidence([{
      group_id: "g1", span_ids: ["s1", "s2"], priority: 1, latest_order: 1, byte_length: 4,
      snippets: [{ span_id: "s1", text: "条件" }]
    }]);
    expect(selected.groups).toEqual([]);
    expect(selected.omitted).toEqual([{ group_id: "g1", span_ids: ["s1", "s2"], reason: "dependency_missing" }]);
  });

  it("runs pass two only after a successful pass with important evidence remaining", () => {
    const groups = [{ group_id: "g1", important: true, span_ids: ["s1"] }, { group_id: "g2", important: true, span_ids: ["s2"] }];
    expect(decideCoverageSecondPass({ groups, pass1_presented_group_ids: ["g1"], pass1_adopted_span_ids: ["s1"], pass1_status: "succeeded" })).toMatchObject({ run: true, group_ids: ["g2"] });
    expect(decideCoverageSecondPass({ groups, pass1_status: "failed" })).toMatchObject({ run: false, reason: "pass1_not_successful" });
  });

  it("rejects joined quotes, invented human approval, missing tool outcomes, and dropped qualifiers", () => {
    const packet = {
      snippets: [
        { span_id: "a", role: "assistant", text: "承認済み" },
        { span_id: "b", role: "user", text: "10 ms" },
        { span_id: "c", role: "user", text: "ただし失敗時のみ実行する。" }
      ],
      events: [{ event_id: "started", status: "started" }]
    };
    const result = validateCoverageCandidate({ lesson_type: "decision", support_span_ids: ["a", "b", "c", "started"], fields: [
      { name: "decision", values: ["承認済み"] },
      { name: "selected_value", values: ["承認済み10 ms"] },
      { name: "verified_outcome", values: ["10 ms"] }
    ] }, packet);
    expect(result.reason_codes).toEqual(expect.arrayContaining(["selected_value_not_single_fragment_grounded", "human_attribution_unsupported", "verified_tool_outcome_missing", "qualifier_not_retained"]));
  });

  it("allows contract control values without pretending they are evidence text", () => {
    const packet = { snippets: [{ span_id: "s", role: "user", text: "APIを必ず使う。" }], events: [], existing_memories: [{ id: "m1" }] };
    const result = validateCoverageCandidate({ lesson_type: "decision", support_span_ids: ["s"], fields: [
      { name: "decision", values: ["APIを必ず使う。"] },
      { name: "decision_type", values: ["governance"] },
      { name: "persistence", values: ["durable"] },
      { name: "action", values: ["update"] },
      { name: "target_memory_id", values: ["m1"] }
    ] }, packet);
    expect(result).toEqual({ valid: true, reason_codes: [] });
  });


  it("a-plus reads refinement_profile from the packet when top-level input omits it", async () => {
    const packet = {
      schema: "learning-extraction-proposal/v2",
      refinement_profile: "a-plus/v1" as const,
      snippets: [{ span_id: "s", role: "user", source: "user", text: "APIを必ず使う。" }],
      events: []
    };
    const result = await verifiedCandidates({ packet, project_id: "org-brain", run_id: "packet-refined" }, [{
      lesson_type: "decision", support_span_ids: ["s"], gaps: [], fields: [
        { name: "decision", values: ["APIを必ず使う。"] },
        { name: "question", values: ["どのAPIを使うか"] }
      ]
    }]);
    expect(result.accepted_indices).toEqual([0]);
    expect(result.candidates[0].reason_codes).toContain("unsupported_provider_fields_omitted");
    expect(result.candidates[0].observation.question).toBeNull();
  });

  it("a-plus omits unsupported optional provider fields before normalization", async () => {
    const packet = { schema: "learning-extraction-proposal/v2", snippets: [{ span_id: "s", role: "user", source: "user", text: "APIを必ず使う。" }], events: [] };
    const result = await verifiedCandidates({ packet, project_id: "org-brain", run_id: "refined", refinement_profile: "a-plus/v1" }, [{
      lesson_type: "decision", support_span_ids: ["s"], gaps: [], fields: [
        { name: "decision", values: ["APIを必ず使う。"] },
        { name: "question", values: ["どのAPIを使うか"] }
      ]
    }]);
    expect(result.accepted_indices).toEqual([0]);
    expect(result.candidates[0].reason_codes).toContain("unsupported_provider_fields_omitted");
    expect(result.candidates[0].observation.question).toBeNull();
  });

  it("a-plus restores a paraphrased explicit decision to the exact supported user statement", async () => {
    const packet = {
      schema: "learning-extraction-proposal/v2",
      routing: { reason_codes: ["explicit_user_decision_search"] },
      snippets: [
        { span_id: "s", role: "user", source: "user", text: "今後は未完了なら原因調査と報告を行ってください。" },
        { span_id: "a", role: "assistant", source: "assistant", text: "未完了時は調査と報告を行う。" }
      ],
      events: []
    };
    const result = await verifiedCandidates({ packet, project_id: "org-brain", run_id: "explicit", refinement_profile: "a-plus/v1" }, [{
      lesson_type: "decision", support_span_ids: ["s", "a"], gaps: [], fields: [
        { name: "decision", values: ["未完了時は調査と報告を行う。"] },
        { name: "selected_value", values: ["原因調査と報告"] }
      ]
    }]);
    expect(result.accepted_indices).toEqual([0]);
    expect(result.candidates[0].observation.decision).toBe("今後は未完了なら原因調査と報告を行ってください。");
    expect(result.candidates[0].support_span_ids).toEqual(["s"]);
    expect(result.candidates[0].reason_codes).toContain("unsupported_provider_fields_omitted");
  });

  it("a-plus rejects a failure candidate whose unsupported fields are all removed", async () => {
    const packet = {
      schema: "learning-extraction-proposal/v2",
      snippets: [],
      events: [{ event_id: "e", status: "failed" }]
    };
    const result = await verifiedCandidates({ packet, project_id: "org-brain", run_id: "empty-failure", refinement_profile: "a-plus/v1" }, [{
      lesson_type: "failure", support_span_ids: ["e"], gaps: ["root_cause"], fields: [
        { name: "symptom", values: ["failed"] }
      ]
    }]);
    expect(result.accepted_indices).toEqual([]);
    expect(result.rejections[0].reason_codes).toContain("failure_evidence_missing");
  });

  it("a-plus resolves a packet call id to its event without rejecting grounded support", async () => {
    const packet = {
      schema: "learning-extraction-proposal/v2",
      snippets: [
        { span_id: "s", role: "user", source: "user", text: "公開前は契約確認を必須にします。" },
        { span_id: "t", role: "tool", source: "tool_result", call_id: "call-1", text: "契約確認に成功" }
      ],
      events: [{ event_id: "e", call_id: "call-1", status: "completed", exit_code: 0 }]
    };
    const result = await verifiedCandidates({ packet, project_id: "org-brain", run_id: "refined-call", refinement_profile: "a-plus/v1" }, [{
      lesson_type: "success", support_span_ids: ["s", "t", "e", "call-1"], gaps: [], fields: [
        { name: "procedure", values: ["公開前は契約確認を必須にします。"] },
        { name: "observed_outcome", values: ["契約確認に成功"] }
      ]
    }]);
    expect(result.accepted_indices).toEqual([0]);
    expect(result.candidates[0].support_span_ids).toEqual(["s", "t", "e"]);
    expect(result.candidates[0].reason_codes).toContain("unsupported_provider_fields_omitted");
  });

  it("rejects one-off instructions while preserving a durable project-only scope", () => {
    const oneOff = validateCoverageCandidate({ lesson_type: "decision", support_span_ids: ["s"], fields: [
      { name: "decision", values: ["この提出分だけCSVを日付の降順に並べてください。"] },
      { name: "selected_value", values: ["日付の降順"] }
    ] }, { snippets: [{ span_id: "s", role: "user", text: "この提出分だけCSVを日付の降順に並べてください。" }], events: [] });
    expect(oneOff.reason_codes).toContain("explicitly_transient");

    const reviewOnly = validateCoverageCandidate({ lesson_type: "success", support_span_ids: ["r"], fields: [
      { name: "procedure", values: ["今回のレビューだけ表の行間を広げてください。"] }
    ] }, { snippets: [{ span_id: "r", role: "user", text: "今回のレビューだけ表の行間を広げてください。" }], events: [] });
    expect(reviewOnly.reason_codes).toContain("explicitly_transient");

    const durable = validateCoverageCandidate({ lesson_type: "decision", support_span_ids: ["d"], fields: [
      { name: "decision", values: ["このプロジェクトだけ大阪リージョンを使用します。"] },
      { name: "selected_value", values: ["大阪リージョン"] }
    ] }, { snippets: [{ span_id: "d", role: "user", text: "このプロジェクトだけ大阪リージョンを使用します。" }], events: [] });
    expect(durable.reason_codes).not.toContain("explicitly_transient");
  });

  it("rejects a number-only reuse even when the digits occur in evidence", () => {
    const result = validateCoverageCandidate({ lesson_type: "success", support_span_ids: ["s"], fields: [
      { name: "observed_outcome", values: ["10"] }
    ] }, { snippets: [{ span_id: "s", role: "assistant", text: "latency was 10 ms" }], events: [{ event_id: "e", status: "completed", exit_code: 0 }] });
    expect(result.reason_codes).toContain("observed_outcome_numeric_only");
  });

  it("deduplicates exact candidates, rejects conflicts, and records the candidate limit", () => {
    const candidate = (value: string, support: string) => ({ lesson_type: "decision", support_span_ids: [support], fields: [{ name: "decision", values: [value] }] });
    const merged = mergeCoverageCandidates([[candidate("A", "s1"), candidate("B", "s1")], [candidate("C", "s2"), candidate("C", "s2"), candidate("D", "s3"), candidate("E", "s4"), candidate("F", "s5")]]);
    expect(merged.conflicts).toHaveLength(2);
    expect(merged.candidates).toHaveLength(3);
    expect(merged.omitted).toHaveLength(1);
  });

  it("builds a complete request inside the conservative ceiling", () => {
    const packet = { schema: "learning-extraction-proposal/v2", extraction_profile: "coverage/v1", coverage_pass: 1, snippets: [], events: [], limits: { input_tokens: 2000, output_tokens: 800, candidates: 3, calls: 2 } };
    const groups = buildCoverageEvidenceGroups([{ span_id: "s", role: "user", text: "このAPIを必ず使う。理由は互換性のため。" }], [], { hash_text: hash });
    const packed = packCoverageGroups(packet, groups, { reserve_bytes: 256, upper_bound: (value: any) => memoryExtractionProviderInputUpperBound(buildMemoryExtractionPrompt(value)) });
    expect(packed.packet.snippets.length).toBeGreaterThan(0);
    expect(packed.upper_bound + 256).toBeLessThanOrEqual(2000);
    expect(buildMemoryExtractionPrompt(packed.packet)).toContain("Field names only:");
  });
});
