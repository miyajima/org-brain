import { describe, expect, it } from "vitest";
import { HttpError, parseLimitParam } from "../src/index";

const limit = { field: "limit", min: 1, max: 100, fallback: 20 };

describe("parseLimitParam", () => {
  it("uses the fallback for undefined, null and blank values", () => {
    for (const value of [undefined, null, "", "   "]) expect(parseLimitParam(value, limit)).toBe(20);
  });

  it("accepts numbers and numeric strings", () => {
    expect(parseLimitParam(5, limit)).toBe(5);
    expect(parseLimitParam("7", limit)).toBe(7);
    expect(parseLimitParam(" 9 ", limit)).toBe(9);
    expect(parseLimitParam("+3", limit)).toBe(3);
  });

  it("clamps out-of-range values instead of rejecting them", () => {
    expect(parseLimitParam(0, limit)).toBe(1);
    expect(parseLimitParam(-4, limit)).toBe(1);
    expect(parseLimitParam("100000", limit)).toBe(100);
    expect(parseLimitParam(0, { field: "offset", min: 0, max: 1000, fallback: 0 })).toBe(0);
    expect(parseLimitParam(-1, { field: "offset", min: 0, max: 1000, fallback: 0 })).toBe(0);
  });

  it("rejects non-numeric and non-integer values with invalid_payload", () => {
    for (const value of ["abc", "1.5", 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1e2x", {}, [], true]) {
      try {
        parseLimitParam(value, limit);
        throw new Error(`expected rejection for ${String(value)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect(error).toMatchObject({ status: 400, code: "invalid_payload", message: "limit must be an integer" });
      }
    }
  });
});
