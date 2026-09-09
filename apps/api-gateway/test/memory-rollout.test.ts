import { describe, expect, it } from "vitest";
import {
  resolveRetrievalProfileSearchMode,
  resolveRetrievalSearchMode,
  shouldRunRetrievalShadow
} from "../src/memory-service";
import { shouldEnqueueRetrievalProjection } from "../src/retrieval-rollout";

describe("retrieval rollout selection", () => {
  it("keeps explicit v4 requests on v4 and never removes the v4 path", () => {
    expect(resolveRetrievalSearchMode("hybrid_v4", {
      HYBRID_V3_MODE: "off",
      HYBRID_V4_MODE: "off"
    }, "fixture")).toBe("hybrid_v4");
  });

  it("keeps the default profile rollout-controlled and maps structured profiles to v4", () => {
    expect(resolveRetrievalProfileSearchMode()).toBe("memories");
    expect(resolveRetrievalProfileSearchMode("default")).toBe("memories");
    expect(resolveRetrievalProfileSearchMode("structured")).toBe("hybrid_v4");
    expect(resolveRetrievalProfileSearchMode("lexical")).toBe("hybrid_v3");
    expect(resolveRetrievalSearchMode(resolveRetrievalProfileSearchMode(), {
      HYBRID_V3_MODE: "off",
      HYBRID_V4_MODE: "on"
    }, "fixture")).toBe("hybrid_v4");
  });

  it("enqueues quality projection when either promoted retrieval generation needs it", () => {
    const queue = {} as Queue;
    expect(shouldEnqueueRetrievalProjection({
      RETRIEVAL_PROJECTION_QUEUE: queue,
      HYBRID_V3_MODE: "off",
      HYBRID_V4_MODE: "on"
    })).toBe(true);
    expect(shouldEnqueueRetrievalProjection({
      RETRIEVAL_PROJECTION_QUEUE: queue,
      HYBRID_V3_MODE: "off",
      HYBRID_V4_MODE: "shadow"
    })).toBe(false);
  });

  it("uses v4 for default searches only after canary selection or promotion", () => {
    expect(resolveRetrievalSearchMode("memories", {
      HYBRID_V3_MODE: "off",
      HYBRID_V4_MODE: "shadow"
    }, "fixture")).toBe("memories");
    expect(resolveRetrievalSearchMode("memories", {
      HYBRID_V3_MODE: "off",
      HYBRID_V4_MODE: "canary",
      HYBRID_V4_CANARY_SAMPLE_RATE: "1"
    }, "fixture")).toBe("hybrid_v4");
    expect(resolveRetrievalSearchMode("memories", {
      HYBRID_V3_MODE: "off",
      HYBRID_V4_MODE: "on"
    }, "fixture")).toBe("hybrid_v4");
  });

  it("supports deterministic sampling and clamps unsafe values", () => {
    expect(shouldRunRetrievalShadow("0", "same-request")).toBe(false);
    expect(shouldRunRetrievalShadow("1", "same-request")).toBe(true);
    expect(shouldRunRetrievalShadow("invalid", "same-request")).toBe(false);
    expect(shouldRunRetrievalShadow("0.25", "same-request"))
      .toBe(shouldRunRetrievalShadow("0.25", "same-request"));
  });
});
