import { localeTag } from "./locale-tag";

// Single display policy for every date/time shown in the console.
// The time zone is fixed; callers choose granularity (date vs date+time, short vs medium)
// through Intl options, but cannot change the zone.
export const CONSOLE_TIME_ZONE = "Asia/Tokyo";
export const DATE_PLACEHOLDER = "—";

export type DateInput = number | string | Date | null | undefined;
export type DateFormatOptions = Omit<Intl.DateTimeFormatOptions, "timeZone">;

// Presets for call sites that previously used toLocaleString()/toLocaleDateString() with no style.
export const DATE_TIME_WITH_SECONDS: DateFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};
export const DATE_NUMERIC: DateFormatOptions = { year: "numeric", month: "numeric", day: "numeric" };

const DEFAULT_DATE_TIME_OPTIONS: DateFormatOptions = { dateStyle: "medium", timeStyle: "short" };
const DEFAULT_DATE_OPTIONS: DateFormatOptions = { dateStyle: "medium" };

function toValidDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWith(value: DateInput, lang: string | null | undefined, options: DateFormatOptions): string {
  const date = toValidDate(value);
  if (!date) return DATE_PLACEHOLDER;
  return new Intl.DateTimeFormat(localeTag(lang), { ...options, timeZone: CONSOLE_TIME_ZONE }).format(date);
}

// Date and time. Defaults to medium date + short time.
export function formatDateTime(
  value: DateInput,
  lang: string | null | undefined,
  options: DateFormatOptions = DEFAULT_DATE_TIME_OPTIONS,
): string {
  return formatWith(value, lang, options);
}

// Date only. Defaults to medium date.
export function formatDate(
  value: DateInput,
  lang: string | null | undefined,
  options: DateFormatOptions = DEFAULT_DATE_OPTIONS,
): string {
  return formatWith(value, lang, options);
}

// ---- Asia/Tokyo values for <input type="date"> / <input type="datetime-local"> ----
// Tokyo has no DST (fixed UTC+9), so a constant offset is exact. These helpers never
// depend on the browser or server time zone.
const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;

function tokyoWallIso(value: DateInput): string | null {
  const date = toValidDate(value);
  return date ? new Date(date.getTime() + TOKYO_OFFSET_MS).toISOString() : null;
}

// "YYYY-MM-DD" for the Tokyo calendar day of an instant, or "" when missing/invalid.
export function tokyoDateInputValue(value: DateInput): string {
  return tokyoWallIso(value)?.slice(0, 10) ?? "";
}

// "YYYY-MM-DDTHH:mm" in Tokyo wall time for a datetime-local input, or "" when missing/invalid.
export function tokyoDateTimeLocalValue(value: DateInput): string {
  return tokyoWallIso(value)?.slice(0, 16) ?? "";
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function tokyoWallToMs(y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0): number | null {
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  if (
    utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d ||
    utc.getUTCHours() !== h || utc.getUTCMinutes() !== mi || utc.getUTCSeconds() !== s
  ) return null;
  return utc.getTime() - TOKYO_OFFSET_MS;
}

// Interprets a datetime-local value as Asia/Tokyo wall time and returns a UTC ISO instant ("...Z"), or null.
export function tokyoDateTimeLocalToIso(value: string | null | undefined): string | null {
  const match = typeof value === "string" ? DATE_TIME_LOCAL.exec(value.trim()) : null;
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = tokyoWallToMs(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s ?? 0));
  return ms === null ? null : new Date(ms).toISOString();
}

// Start (00:00:00.000) or end (23:59:59.999) instant of a Tokyo calendar day "YYYY-MM-DD", or null.
export function tokyoDateToTimestamp(value: string | null | undefined, edge: "start" | "end"): number | null {
  const match = typeof value === "string" ? DATE_ONLY.exec(value.trim()) : null;
  if (!match) return null;
  const [, y, mo, d] = match;
  return edge === "start"
    ? tokyoWallToMs(Number(y), Number(mo), Number(d), 0, 0, 0)
    : tokyoWallToMs(Number(y), Number(mo), Number(d), 23, 59, 59, 999);
}
