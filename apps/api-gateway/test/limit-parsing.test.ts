import { describe, expect, it } from "vitest";
import { parseAuditLimit } from "../src/audit-service";
import { parseLimitParam } from "../src/request-value-utils";

describe("api-gateway limit parsing policy", () => {
  it("re-exports the shared helper", () => {
    expect(parseLimitParam("", { field: "limit", min: 1, max: 5, fallback: 3 })).toBe(3);
  });

  it("parses audit limits with the shared policy", () => {
    expect(parseAuditLimit(undefined)).toBe(100);
    expect(parseAuditLimit("")).toBe(100);
    expect(parseAuditLimit("0")).toBe(1);
    expect(parseAuditLimit("9999")).toBe(500);
    expect(parseAuditLimit("25")).toBe(25);
    expect(() => parseAuditLimit("abc")).toThrowError(expect.objectContaining({ status: 400, code: "invalid_payload", message: "limit must be an integer" }));
    expect(() => parseAuditLimit("2.5")).toThrowError(expect.objectContaining({ code: "invalid_payload" }));
  });
});
