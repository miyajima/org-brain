import { HttpError } from "./errors.js";

export type LimitParamOptions = { field: string; min: number; max: number; fallback: number };

/**
 * Shared policy for list limit/offset input: undefined, null or blank -> fallback; numbers and numeric strings
 * are accepted; non-numeric or non-integer input is a 400 invalid_payload; out-of-range integers clamp to [min, max].
 */
export function parseLimitParam(value: unknown, options: LimitParamOptions): number {
  const { field, min, max, fallback } = options;
  if (value === undefined || value === null) return fallback;
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return fallback;
    parsed = /^[+-]?\d+(?:\.0+)?$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  } else {
    parsed = Number.NaN;
  }
  if (!Number.isInteger(parsed)) throw new HttpError(400, "invalid_payload", `${field} must be an integer`);
  return Math.max(min, Math.min(max, parsed));
}
