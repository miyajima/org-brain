// Verification-only: the locale-dependent key ordering local-domain-recall used before canonical JSON
// moved to UTF-16 code unit order. Archives and digests written by earlier releases may carry it, so
// verifiers may accept it as a fallback. Never use it to produce new digests.
export function legacyLocaleCanonicalJson(value) {
  return JSON.stringify(legacyValue(value));
}

function legacyValue(value) {
  if (Array.isArray(value)) return value.map(legacyValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, legacyValue(item)]));
  }
  return value;
}
