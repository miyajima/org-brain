import { describe, expect, it } from "vitest";
import { estimateJsonTokens, estimateTextTokens } from "../src/token-estimate";

describe("shared token estimate", () => {
  it("is CJK aware and zero for empty text", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("日本語".repeat(100))).toBe(300);
    expect(estimateTextTokens("abcd".repeat(100))).toBe(100);
    expect(estimateTextTokens("deploy 手順 abc")).toBe(Math.ceil(2 + 11 / 4));
  });
  it("estimates JSON by compact text", () => {
    expect(estimateJsonTokens({ a: "日本" })).toBe(estimateTextTokens('{"a":"日本"}'));
    expect(estimateJsonTokens(undefined)).toBe(0);
  });
});
