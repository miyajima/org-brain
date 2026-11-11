import { describe, expect, it } from "vitest";
import { readBrowserCookie } from "./browser-cookie";

describe("readBrowserCookie", () => {
  it("returns the decoded value of the named cookie", () => {
    expect(readBrowserCookie("a=1; orgbrain_tenant=acme%20corp", "orgbrain_tenant")).toBe("acme corp");
  });

  it("keeps equals signs inside the value", () => {
    expect(readBrowserCookie("orgbrain_tenant=a=b", "orgbrain_tenant")).toBe("a=b");
  });

  it("returns null when the cookie is absent", () => {
    expect(readBrowserCookie("a=1; b=2", "orgbrain_tenant")).toBeNull();
    expect(readBrowserCookie("", "orgbrain_tenant")).toBeNull();
  });

  it("returns the raw value instead of throwing on malformed percent-encoding", () => {
    expect(readBrowserCookie("orgbrain_tenant=%E0%A4%A", "orgbrain_tenant")).toBe("%E0%A4%A");
  });
});
