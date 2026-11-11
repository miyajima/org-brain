import { describe, expect, it } from "vitest";
import { localeTag } from "./locale-tag";

describe("localeTag", () => {
  it("maps console locales to BCP 47 tags", () => {
    expect(localeTag("ja")).toBe("ja-JP");
    expect(localeTag("zh")).toBe("zh-CN");
    expect(localeTag("en")).toBe("en-US");
  });

  it("falls back to en-US for unknown or missing locales", () => {
    expect(localeTag("fr")).toBe("en-US");
    expect(localeTag("JA")).toBe("en-US");
    expect(localeTag("")).toBe("en-US");
    expect(localeTag(null)).toBe("en-US");
    expect(localeTag(undefined)).toBe("en-US");
  });
});
