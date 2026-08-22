import { HttpError, type MemorySearchMode } from "@org-brain/shared";

export function parseString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  }
  return trimmed;
}

export function parseOptionalBoolean(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_payload", `${field} must be a boolean`);
  }
  return value;
}

export function parseOptionalInteger(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new HttpError(400, "invalid_payload", `${field} must be between ${min} and ${max}`);
  }
  return value;
}

export function parseOptionalFiniteNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be a finite number`);
  }
  return value;
}

export function parseMemorySearchMode(value: unknown, field: string, fallback: MemorySearchMode): MemorySearchMode {
  if (value === undefined) return fallback;
  if (!["memories", "hybrid", "hybrid_v2", "hybrid_v3", "hybrid_v4"].includes(String(value))) {
    throw new HttpError(
      400,
      "invalid_payload",
      `${field} must be 'memories', 'hybrid', 'hybrid_v2', 'hybrid_v3', or 'hybrid_v4'`
    );
  }
  return value as MemorySearchMode;
}

export function normalizeActorPrincipal(principal: string | null | undefined): string | null {
  const trimmed = principal?.trim();
  return trimmed ? trimmed.slice(0, 128) : null;
}
