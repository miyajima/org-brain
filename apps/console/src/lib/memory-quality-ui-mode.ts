export type MemoryQualityUiMode = "off" | "beta" | "on";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeMemoryQualityUiMode(value: unknown): MemoryQualityUiMode {
  return value === "on" || value === "beta" ? value : "off";
}

export async function resolveMemoryQualityUiMode(locals: unknown): Promise<MemoryQualityUiMode> {
  const local = record(locals);
  const direct = record(local.env).MEMORY_QUALITY_UI_MODE;
  if (direct !== undefined) return normalizeMemoryQualityUiMode(direct);
  try {
    const runtime = await import("cloudflare:workers");
    const value = record(runtime.env).MEMORY_QUALITY_UI_MODE;
    if (value !== undefined) return normalizeMemoryQualityUiMode(value);
  } catch {
    // Node builds do not expose the Cloudflare runtime module.
  }
  const processLike = (globalThis as typeof globalThis & { process?: { env?: Record<string, unknown> } }).process;
  return normalizeMemoryQualityUiMode(processLike?.env?.MEMORY_QUALITY_UI_MODE);
}
