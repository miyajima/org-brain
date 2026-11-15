import { describe, expect, it } from "vitest";
import { decisionEditorHref, optionalDateTime, optionalText, parseLines, sourceRowError } from "./decision-form-values";

describe("decision form values", () => {
  it("trims optional and multiline values", () => {
    const form = new FormData();
    form.set("text", "  value  ");
    form.set("empty", "   ");
    expect(optionalText(form, "text")).toBe("value");
    expect(optionalText(form, "empty")).toBeNull();
    expect(parseLines(" one\r\n\n two  ")).toEqual(["one", "two"]);
  });

  it("validates source URLs and dates with existing precedence", () => {
    expect(sourceRowError("https://example.com", "2024-02-29", true)).toBeNull();
    expect(sourceRowError("not a URL", "", true)).toBe("invalidUrl");
    expect(sourceRowError("not a URL", "bad-date", true)).toBe("invalidDate");
    expect(sourceRowError("", "bad-date", false)).toBeNull();
  });

  it("converts Tokyo wall time with existing date helper and preserves editor query context", () => {
    const form = new FormData();
    form.set("validFrom", "2024-02-29T12:30");
    expect(optionalDateTime(form, "validFrom")).toBe("2024-02-29T03:30:00.000Z");
    form.set("validFrom", "2024-02-30T12:30");
    expect(optionalDateTime(form, "validFrom")).toBeNull();
    const url = new URL("https://console.test/decisions?tenant_id=old&project_id=old&mode=create&q=acl&lang=ja");
    expect(decisionEditorHref(url, "d:1", "default", null)).toBe("/decisions?tenant_id=default&q=acl&lang=ja&selected=d%3A1&view=editor");
  });
});
