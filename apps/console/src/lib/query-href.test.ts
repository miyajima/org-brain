import { describe, expect, it } from "vitest";
import { queryHref } from "./query-href";

describe("queryHref", () => {
  const url = new URL("https://console.example/memories?tenant_id=default&page=3&selected=m1");

  it("overrides keys and keeps the others", () => {
    expect(queryHref(url, url.searchParams, { page: "4" })).toBe("/memories?tenant_id=default&page=4&selected=m1");
  });

  it("removes keys whose override is null, undefined or empty", () => {
    expect(queryHref(url, url.searchParams, { selected: "", page: null, tenant_id: undefined })).toBe("/memories");
  });

  it("adds keys that are not present yet", () => {
    expect(queryHref(url, url.searchParams, { view: "quality" })).toBe("/memories?tenant_id=default&page=3&selected=m1&view=quality");
  });

  it("does not mutate the source params", () => {
    queryHref(url, url.searchParams, { page: "9" });
    expect(url.searchParams.get("page")).toBe("3");
  });
});
