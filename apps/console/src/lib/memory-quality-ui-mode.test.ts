import { describe, expect, it } from "vitest";
import { normalizeMemoryQualityUiMode } from "./memory-quality-ui-mode";

describe("memory quality UI mode", () => {
  it("fails closed and accepts beta/on", () => {
    expect(normalizeMemoryQualityUiMode(undefined)).toBe("off");
    expect(normalizeMemoryQualityUiMode("beta")).toBe("beta");
    expect(normalizeMemoryQualityUiMode("on")).toBe("on");
  });
});
