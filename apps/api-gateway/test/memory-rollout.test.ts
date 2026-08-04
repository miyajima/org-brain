import { describe, expect, it } from "vitest";
import { resolveRetrievalSearchMode, shouldRunRetrievalShadow } from "../src/memory-service";

describe("retrieval rollout selection", () => {
  it("keeps explicit v4 requests on v4 and never removes the v4 path", () => {
    expect(resolveRetrievalSearchMode("hybrid_v4", {
      HYBRID_V3_MODE: "off",
      HYBRID_V4_MODE: "off"
    }, "fixture")).toBe("hybrid_v4");
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
