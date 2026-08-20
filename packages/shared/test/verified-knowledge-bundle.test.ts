import { describe, expect, it } from "vitest";
import {
  buildSignedVerifiedKnowledgeBundle,
  buildVerifiedKnowledgeBundle,
  buildVerifiedKnowledgeBundles,
  clearVerifiedLocalModelCache,
  evaluateVerifiedKnowledgeBundle,
  splitVerifiedSessionIntoBatches,
  verifySignedVerifiedKnowledgeBundle,
  type LocalSessionV1
} from "../src/verified-knowledge-bundle";

const session: LocalSessionV1 = {
  tenant_id: "tenant-a",
  project_id: "project-a",
  task_id: "task-a",
  decision_thread_id: "thread-a",
  events: [{
    event_id: "event-1",
    turn_id: "turn-1",
    tenant_id: "tenant-a",
    project_id: "project-a",
    task_id: "task-a",
    decision_thread_id: "thread-a",
    role: "user",
    actor_type: "human",
    actor_id: "user:1",
    occurred_at: 1,
    text: "決定: src/app.ts を採用する。理由は変更範囲を小さくできるため。",
    file_change: { path: "src/app.ts", content_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }]
};

describe("verified knowledge bundle", () => {
  it("keeps scene batches bounded and separates background events", () => {
    const events = Array.from({ length: 16 }, (_, index) => ({
      ...session.events[0],
      event_id: "event-" + index,
      turn_id: "turn-" + Math.floor(index / 2),
      is_new_input: index < 11,
      text: "message " + index
    }));
    const batches = splitVerifiedSessionIntoBatches({ ...session, events });
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches.map((batch) => batch.events.length))).toBeLessThanOrEqual(10);
    expect(Math.max(...batches.map((batch) => batch.background.length))).toBeLessThanOrEqual(5);
  });

  it("signs and verifies the canonical bundle", async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const bundle = await buildSignedVerifiedKnowledgeBundle(session, keys.privateKey, { collector_key_id: "collector-1" });
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const result = await verifySignedVerifiedKnowledgeBundle(bundle, publicKey);
    expect(result.valid).toBe(true);
    expect(bundle.signature.key_id).toBe("collector-1");
  });

  it("does not promote a fabricated local-model candidate", async () => {
    clearVerifiedLocalModelCache();
    const bundle = await buildVerifiedKnowledgeBundle({
      ...session,
      events: [{ ...session.events[0], text: "短い入力です。" }]
    }, {
      collector_key_id: "collector-1",
      model_id: "local-test",
      local_llm: async () => ({
        candidates: [{
          candidate_type: "decision",
          value: "存在しない決定",
          source_event_id: "event-1"
        }]
      })
    });
    const evaluation = evaluateVerifiedKnowledgeBundle(bundle, { signature_valid: true, event_chain_valid: true, publish_authorized: true });
    expect(evaluation.state).not.toBe("active");
    expect(evaluation.reasons.some((reason) => reason.includes("candidate_not_in_source") || reason.includes("decision"))).toBe(true);
  });

  it("does not call the local model when deterministic rules are complete", async () => {
    clearVerifiedLocalModelCache();
    let calls = 0;
    const options = {
      collector_key_id: "collector-1",
      model_id: "local-test",
      local_llm: async () => {
        calls += 1;
        return { candidates: [] };
      }
    };
    await buildVerifiedKnowledgeBundle(session, options);
    await buildVerifiedKnowledgeBundle(session, options);
    expect(calls).toBe(0);
  });

  it("builds a unique signed-bundle input for every bounded scene batch", async () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      ...session.events[0],
      event_id: "batch-event-" + index,
      turn_id: "batch-turn-" + index,
      text: `決定: src/batch-${index}.ts を採用する。理由は検証可能だから。`,
      file_change: { path: `src/batch-${index}.ts`, content_hash: "a".repeat(64) }
    }));
    const bundles = await buildVerifiedKnowledgeBundles({ ...session, events }, { collector_key_id: "collector-1" });
    expect(bundles).toHaveLength(2);
    expect(new Set(bundles.map((bundle) => bundle.bundle_key)).size).toBe(2);
    expect(bundles.every((bundle) => bundle.new_input_refs.length <= 10)).toBe(true);
  });

  it("quarantines PII-bearing candidates", async () => {
    const bundle = await buildVerifiedKnowledgeBundle({
      ...session,
      events: [{ ...session.events[0], text: "決定: src/private.ts を採用する。理由は user@example.invalid に送るため。" }]
    }, { collector_key_id: "collector-1" });
    const evaluation = evaluateVerifiedKnowledgeBundle(bundle, { signature_valid: true, event_chain_valid: true, publish_authorized: true });
    expect(evaluation.state).toBe("quarantined");
    expect(evaluation.reasons.some((reason) => reason.startsWith("unsafe_candidate:"))).toBe(true);
  });
});
