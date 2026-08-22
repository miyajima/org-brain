import { describe, expect, it } from "vitest";
import {
  compactText,
  finiteConfidence,
  normalizeTenantId,
  parseOptionalNullableString,
  parseOptionalStrictString
} from "../src/request-value-utils";

describe("request value utilities", () => {
  it("keeps the two optional-string empty-value contracts distinct", () => {
    expect(parseOptionalNullableString("   ", "value")).toBeNull();
    expect(() => parseOptionalStrictString("   ", "value")).toThrow("value must not be empty");
    expect(parseOptionalStrictString(" value ", "value", 4)).toBe("valu");
  });

  it("normalizes tenant ids and compact response values", () => {
    expect(normalizeTenantId(" tenant-a ")).toBe("tenant-a");
    expect(() => normalizeTenantId(" ")).toThrow("tenant_id must be between 1 and 128 characters");
    expect(compactText(" alpha   beta ", 10)).toBe("alpha beta");
    expect(compactText("alpha beta gamma", 10)).toBe("alpha bet…");
    expect(finiteConfidence(1.5)).toBe(1);
    expect(finiteConfidence(Number.NaN)).toBeNull();
  });
});
