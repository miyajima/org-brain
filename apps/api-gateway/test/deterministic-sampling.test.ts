import { describe, expect, it } from "vitest";
import { fnv1a32 } from "../src/deterministic-sampling";

describe("fnv1a32", () => {
  it("keeps deterministic unsigned hash vectors", () => {
    expect(fnv1a32("")).toBe(2166136261);
    expect(fnv1a32("same-request")).toBe(3810877583);
    expect(fnv1a32("tenant-a\0project-a\0query")).toBe(2818281856);
  });
});
