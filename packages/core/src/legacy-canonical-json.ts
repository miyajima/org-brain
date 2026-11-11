/**
 * Verification-only: the key ordering canonicalJson used before it was changed to UTF-16 code unit
 * order. Digests persisted by earlier releases were computed with this locale-dependent order, so
 * callers that recompute and compare a stored digest may accept it as a fallback. Never use this to
 * produce new digests.
 */
export function legacyLocaleCanonicalJson(value: unknown): string {
  return JSON.stringify(legacyValue(value));
}

function legacyValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_json_non_finite_number");
    return value;
  }
  if (Array.isArray(value)) return value.map(legacyValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, legacyValue(item)]));
  }
  throw new Error("canonical_json_unsupported_value");
}
