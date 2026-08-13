import { describe, expect, it } from "vitest";
import {
  normalizeMemoryLearningEvent,
  observeMemoryLearningEvent
} from "../src/memory-learning";

const validEvent = {
  schema_version: 1,
  lesson_type: "success",
  kind: "fact",
  trigger: "When the Stop hook captures a completed implementation",
  conclusion: "The hook batches verified learning events once",
  rationale: "A single batch keeps retries idempotent and avoids duplicate memories",
  reuse_rule: "Use one batch when the same lifecycle hook emits multiple lessons",
  outcome: "The capture endpoint accepted one batch",
  applicability: {
    target_files: ["packages/orgbrain-cli/src/hook-memory-bridge.mjs"],
    components: ["stop-hook"]
  },
  evidence_selectors: [
    { type: "file", ref: "packages/orgbrain-cli/src/hook-memory-bridge.mjs" },
    { type: "command", ref: "vitest hook-memory-bridge" }
  ],
  gaps: []
} as const;

describe("memory learning event", () => {
  it("returns a stable event hash without persisting an event body", async () => {
    const first = await observeMemoryLearningEvent(validEvent);
    const second = await observeMemoryLearningEvent({ ...validEvent });
    expect(first).toEqual(second);
    expect(first.accepted).toBe(true);
    expect(first.event_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toHaveProperty("event");
  });

  it("rejects credentials before an event can be observed", async () => {
    const result = await normalizeMemoryLearningEvent({
      ...validEvent,
      rationale: "Use api_key=super-secret-value-12345 because it passed"
    });
    expect(result.accepted).toBe(false);
    expect(result.reason_codes).toContain("credential_detected");
    expect(result.event_hash).toBeNull();
  });

  it("keeps gaps observable but marks them for review", async () => {
    const result = await normalizeMemoryLearningEvent({ ...validEvent, gaps: ["Production binding is not checked"] });
    expect(result.accepted).toBe(true);
    expect(result.reason_codes).toContain("gaps_present");
  });

  it("does not mistake timestamps and numeric ids for phone numbers", async () => {
    const result = await normalizeMemoryLearningEvent({
      ...validEvent,
      outcome: "2026-08-13T10:20:30Z status 1892212233445566778 exited successfully"
    });
    expect(result.accepted).toBe(true);
  });
});

