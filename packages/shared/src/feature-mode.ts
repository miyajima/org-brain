/**
 * Single reading of a *_MODE feature flag: unset, blank or "off" is disabled ("off"); any other value
 * is enabled and returned trimmed so callers can compare it against their own modes.
 */
export function featureMode(raw: string | undefined | null): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value === "" || value === "off" ? "off" : value;
}

export function isFeatureEnabled(raw: string | undefined | null): boolean {
  return featureMode(raw) !== "off";
}
