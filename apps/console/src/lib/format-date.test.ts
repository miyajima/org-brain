import { describe, expect, it } from "vitest";
import {
  DATE_NUMERIC,
  DATE_PLACEHOLDER,
  DATE_TIME_WITH_SECONDS,
  formatDate,
  formatDateTime,
  tokyoDateInputValue,
  tokyoDateTimeLocalToIso,
  tokyoDateTimeLocalValue,
  tokyoDateToTimestamp,
} from "./format-date";

// 2026-03-01T15:30:00Z is 2026-03-02 00:30 in Asia/Tokyo (UTC+9), so the
// Tokyo calendar day differs from the UTC calendar day.
const ACROSS_MIDNIGHT = "2026-03-01T15:30:00Z";

describe("format-date policy", () => {
  it("uses the shared placeholder for missing or invalid values", () => {
    expect(DATE_PLACEHOLDER).toBe("—");
    for (const value of [null, undefined, "", "not-a-date", Number.NaN]) {
      expect(formatDateTime(value, "en")).toBe("—");
      expect(formatDate(value, "en")).toBe("—");
    }
  });

  it("converts a UTC instant to the Asia/Tokyo calendar day", () => {
    expect(formatDate(ACROSS_MIDNIGHT, "en")).toBe("Mar 2, 2026");
    expect(formatDateTime(ACROSS_MIDNIGHT, "en")).toBe("Mar 2, 2026, 12:30 AM");
  });

  it("moves the day boundary exactly at Tokyo midnight", () => {
    // 14:59:59Z = 23:59:59 JST on Mar 1; 15:00:00Z = 00:00 JST on Mar 2.
    expect(formatDate("2026-03-01T14:59:59Z", "en")).toBe("Mar 1, 2026");
    expect(formatDate("2026-03-01T15:00:00Z", "en")).toBe("Mar 2, 2026");
  });

  it("ignores a caller-supplied time zone", () => {
    const options = { dateStyle: "medium", timeZone: "UTC" } as unknown as Parameters<typeof formatDate>[2];
    expect(formatDate(ACROSS_MIDNIGHT, "en", options)).toBe("Mar 2, 2026");
  });

  it("maps console locales to Intl locales (ja-JP, zh-CN, en-US)", () => {
    expect(formatDate(ACROSS_MIDNIGHT, "ja")).toBe("2026/03/02");
    expect(formatDate(ACROSS_MIDNIGHT, "zh")).toBe("2026年3月2日");
    expect(formatDate(ACROSS_MIDNIGHT, "en")).toBe("Mar 2, 2026");
    expect(formatDateTime(ACROSS_MIDNIGHT, "ja")).toBe("2026/03/02 0:30");
    expect(formatDateTime(ACROSS_MIDNIGHT, "zh")).toBe("2026年3月2日 00:30");
  });

  it("falls back to en-US for unknown or missing locales", () => {
    expect(formatDate(ACROSS_MIDNIGHT, "fr")).toBe("Mar 2, 2026");
    expect(formatDate(ACROSS_MIDNIGHT, null)).toBe("Mar 2, 2026");
    expect(formatDate(ACROSS_MIDNIGHT, undefined)).toBe("Mar 2, 2026");
  });

  it("accepts epoch milliseconds, ISO strings and Date objects alike", () => {
    const epoch = Date.parse(ACROSS_MIDNIGHT);
    expect(formatDateTime(epoch, "ja")).toBe("2026/03/02 0:30");
    expect(formatDateTime(ACROSS_MIDNIGHT, "ja")).toBe("2026/03/02 0:30");
    expect(formatDateTime(new Date(ACROSS_MIDNIGHT), "ja")).toBe("2026/03/02 0:30");
  });

  it("provides presets for the numeric styles previously used by toLocaleString()", () => {
    expect(formatDateTime(ACROSS_MIDNIGHT, "en", DATE_TIME_WITH_SECONDS)).toBe("3/2/2026, 12:30:00 AM");
    expect(formatDateTime(ACROSS_MIDNIGHT, "ja", DATE_TIME_WITH_SECONDS)).toBe("2026/3/2 0:30:00");
    expect(formatDate(ACROSS_MIDNIGHT, "en", DATE_NUMERIC)).toBe("3/2/2026");
    expect(formatDate(ACROSS_MIDNIGHT, "ja", DATE_NUMERIC)).toBe("2026/3/2");
  });

  it("keeps caller-chosen granularity while fixing time zone and locale", () => {
    expect(formatDateTime(ACROSS_MIDNIGHT, "ja", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })).toBe(
      "3月2日 00:30",
    );
    expect(formatDate(ACROSS_MIDNIGHT, "en", { year: "numeric", month: "2-digit", day: "2-digit" })).toBe("03/02/2026");
  });
});

describe("Asia/Tokyo input values", () => {
  it("expresses an instant as the Tokyo calendar date (23:30 UTC is already the next day)", () => {
    expect(tokyoDateInputValue("2026-03-01T15:30:00Z")).toBe("2026-03-02");
    expect(tokyoDateInputValue("2026-03-01T14:59:59Z")).toBe("2026-03-01");
    expect(tokyoDateInputValue(Date.parse("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
    expect(tokyoDateInputValue(new Date("2026-07-01T00:30:00Z"))).toBe("2026-07-01");
  });

  it("expresses an instant as a Tokyo datetime-local value", () => {
    expect(tokyoDateTimeLocalValue("2026-03-01T15:30:00Z")).toBe("2026-03-02T00:30");
    expect(tokyoDateTimeLocalValue("2026-07-01T00:00:00Z")).toBe("2026-07-01T09:00");
  });

  it("returns an empty string for missing or invalid input", () => {
    for (const value of [null, undefined, "", "nope", Number.NaN]) {
      expect(tokyoDateInputValue(value)).toBe("");
      expect(tokyoDateTimeLocalValue(value)).toBe("");
    }
  });

  it("interprets datetime-local as Tokyo wall time and returns a UTC ISO instant", () => {
    expect(tokyoDateTimeLocalToIso("2026-03-02T00:30")).toBe("2026-03-01T15:30:00.000Z");
    expect(tokyoDateTimeLocalToIso("2026-07-01T09:00")).toBe("2026-07-01T00:00:00.000Z");
    expect(tokyoDateTimeLocalToIso("2026-07-01T09:00:30")).toBe("2026-07-01T00:00:30.000Z");
  });

  it("round-trips and rejects malformed datetime-local values", () => {
    expect(tokyoDateTimeLocalValue(tokyoDateTimeLocalToIso("2026-11-12T08:15"))).toBe("2026-11-12T08:15");
    for (const value of [null, undefined, "", "nope", "2026-13-01T00:00", "2026-02-30T00:00", "2026-03-02", "2026-03-02T25:00"]) {
      expect(tokyoDateTimeLocalToIso(value)).toBeNull();
    }
  });

  it("converts a Tokyo calendar date to the start or end instant of that Tokyo day", () => {
    expect(tokyoDateToTimestamp("2026-03-02", "start")).toBe(Date.parse("2026-03-01T15:00:00Z"));
    expect(tokyoDateToTimestamp("2026-03-02", "end")).toBe(Date.parse("2026-03-02T14:59:59.999Z"));
    expect(tokyoDateToTimestamp("2026-02-30", "start")).toBeNull();
    expect(tokyoDateToTimestamp("", "end")).toBeNull();
  });
});
