import { describe, expect, it } from "vitest";
import { evaluateMemoryQualityAuditV1 } from "../src/memory-quality-audit";

describe("MemoryQualityAuditV1", () => {
  it("surfaces pending feedback and confirmed contradictions by memory id without reasons or evidence text", async () => {
    const audit = await evaluateMemoryQualityAuditV1({
      tenant_id: "tenant-a", scope: "project", project_id: "project-a",
      memory_rows: [{ id: "a", project_id: "project-a", content: "private" }, { id: "b", project_id: "project-a", content: "private" }],
      decision_rows: [],
      integrity_issues: { feedback: [{ memory_id: "a", status: "reported", reason: "private reason" },
        { memory_id: "b", status: "confirmed", kind: "stale" }],
        contradictions: [{ from_memory_id: "a", to_memory_id: "b", evidence: "private evidence" }] }
    });
    expect(audit.counts).toMatchObject({ pending_feedback: 1, confirmed_stale: 1, unresolved_contradictions: 1 });
    expect(audit.reason_code_samples.pending_feedback).toEqual(["a"]);
    expect(audit.reason_code_samples.confirmed_stale).toEqual(["b"]);
    expect(audit.reason_code_samples.unresolved_contradiction).toEqual(["a", "b"]);
    expect(JSON.stringify(audit)).not.toContain("private reason");
    expect(JSON.stringify(audit)).not.toContain("private evidence");
  });
  it("returns aggregate-only quality evidence and detects duplicates and inferred decisions", async () => {
    const secretText = "internal prose that must never appear in an audit response";
    const audit = await evaluateMemoryQualityAuditV1({
      tenant_id: "tenant-a",
      project_id: "project-a",
      scope: "project",
      now: 1_800_000_000_000,
      memory_rows: [
        {
          id: "memory-a",
          project_id: "project-a",
          kind: "pitfall",
          lifecycle_state: "active",
          content: secretText,
          canonical_key: "duplicate-key",
          created_at: 1_700_000_000_000
        },
        {
          id: "memory-b",
          project_id: "project-a",
          kind: "fact",
          lifecycle_state: "active",
          content: "second private body",
          canonical_key: "duplicate-key",
          created_at: 1_700_000_000_001
        }
      ],
      decision_rows: [
        {
          id: "decision-inferred",
          project_id: "project-a",
          status: "active",
          confirmation_state: "inferred_unconfirmed",
          confirmed_at: null,
          rationale: "",
          source_refs_json: "[]"
        }
      ]
    });

    expect(audit).toMatchObject({
      contract: "memory-quality-audit/v1",
      read_only: true,
      counts: {
        memories_total: 2,
        memories_active: 2,
        decisions_total: 1,
        decisions_confirmed: 0,
        decisions_inferred: 1
      },
      integrity: {
        raw_content_emitted: false,
        pii_text_emitted: false,
        credential_values_emitted: false,
        physical_delete_count: 0
      }
    });
    expect(audit.reason_code_samples.duplicate_canonical_key).toEqual(["memory-a", "memory-b"]);
    expect(audit.reason_code_samples.active_decision_unconfirmed).toEqual(["decision-inferred"]);
    expect(JSON.stringify(audit)).not.toContain(secretText);
    expect(JSON.stringify(audit)).not.toContain("second private body");
  });

  it("does not treat null timestamps as TTL, verification, confirmation, or expiry", async () => {
    const audit = await evaluateMemoryQualityAuditV1({
      tenant_id: "tenant-a",
      project_id: "project-a",
      scope: "project",
      now: 1_800_000_000_000,
      memory_rows: [{
        id: "memory-null-timestamps",
        project_id: "project-a",
        kind: "fact",
        lifecycle_state: "active",
        content: "private body",
        verification_state: "verified",
        verified_at: null,
        valid_until: null
      }],
      decision_rows: [{
        id: "decision-null-timestamps",
        project_id: "project-a",
        status: "active",
        confirmation_state: "user_confirmed",
        confirmed_at: null,
        valid_until: null,
        rationale: "A reason",
        source_refs_json: JSON.stringify([{ type: "artifact", ref: "artifact-1" }])
      }]
    });

    expect(audit.coverage.ttl).toBe(0);
    expect(audit.coverage.verified).toBe(0);
    expect(audit.counts.decisions_confirmed).toBe(0);
    expect(audit.counts.decisions_inferred).toBe(1);
    expect(audit.reason_code_samples).not.toHaveProperty("expired_active");
    expect(audit.reason_code_samples).not.toHaveProperty("active_decision_expired");
  });
});
