import { HttpError } from "@org-brain/shared";

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
  empty: "reject" | "null"
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (empty === "null") return null;
    throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  }
  return trimmed.slice(0, maxLength);
}

export function parseOptionalStrictString(value: unknown, field: string, maxLength = 256): string | null {
  return optionalString(value, field, maxLength, "reject");
}

export function parseOptionalNullableString(value: unknown, field: string, maxLength = 256): string | null {
  return optionalString(value, field, maxLength, "null");
}

export function normalizeTenantId(value: string): string {
  const tenantId = value.trim();
  if (!tenantId || tenantId.length > 128) {
    throw new HttpError(400, "invalid_tenant_id", "tenant_id must be between 1 and 128 characters");
  }
  return tenantId;
}

export function compactText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export function finiteConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null;
}

export function parseRequiredString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  return trimmed.slice(0, maxLength);
}

// Contracts and the gateway resolve separate Zod type identities, so bridge only
// the shared safeParse surface while preserving each schema's inferred output.
export function parseZodPayload<S extends { parse(raw: unknown): unknown }>(schema: S, raw: unknown): ReturnType<S["parse"]> {
  const parsed = (schema as unknown as {
    safeParse(value: unknown):
      | { success: true; data: ReturnType<S["parse"]> }
      | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
  }).safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "invalid_payload",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    );
  }
  return parsed.data;
}

// R6: shared list paging parsers (default limit is supplied per call site).
export function parseLimit(value: unknown, fallback = 50): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(100, Math.max(1, parsed)) : fallback;
}

export function parseOffset(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER - 100) {
    throw new HttpError(400, "invalid_offset", "Offset must be a nonnegative safe integer");
  }
  return parsed;
}
