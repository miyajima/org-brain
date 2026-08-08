export type InsightsUiMode = "off" | "beta" | "on";

export type InsightsUiBehavior = {
  enableInsightsRoutes: boolean;
  renderInsightsHome: boolean;
  useInsightsNavigation: boolean;
  showOverviewLab: boolean;
  showLegacyDashboard: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function legacyRuntimeMode(locals: unknown): unknown {
  const localRecord = record(locals);
  try {
    const runtimeEnv = record(record(localRecord.runtime).env);
    if (runtimeEnv.INSIGHTS_UI_MODE !== undefined) return runtimeEnv.INSIGHTS_UI_MODE;
  } catch {
    // Astro 6 deliberately throws when the removed locals.runtime.env getter is read.
  }
  try {
    const directEnv = record(localRecord.env);
    if (directEnv.INSIGHTS_UI_MODE !== undefined) return directEnv.INSIGHTS_UI_MODE;
  } catch {
    // Keep feature-flag resolution fail-closed when an adapter exposes a throwing getter.
  }
  return undefined;
}

export function normalizeInsightsUiMode(value: unknown): InsightsUiMode {
  return value === "on" || value === "beta" ? value : "off";
}

export function processInsightsUiModeFallback(): unknown {
  const processLike = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, unknown> };
  }).process;
  return processLike?.env?.INSIGHTS_UI_MODE;
}

export function resolveInsightsUiMode(locals: unknown, processFallback?: unknown): InsightsUiMode {
  return normalizeInsightsUiMode(legacyRuntimeMode(locals) ?? processFallback);
}

export async function resolveRequestInsightsUiMode(
  locals: unknown,
  processFallback?: unknown
): Promise<InsightsUiMode> {
  const legacyMode = legacyRuntimeMode(locals);
  if (legacyMode !== undefined) return normalizeInsightsUiMode(legacyMode);
  try {
    const runtime = await import("cloudflare:workers");
    const runtimeMode = record(runtime.env).INSIGHTS_UI_MODE;
    if (runtimeMode !== undefined) return normalizeInsightsUiMode(runtimeMode);
  } catch {
    // Node builds and unit tests do not expose the Cloudflare runtime module.
  }
  return normalizeInsightsUiMode(processFallback);
}

export function insightsUiBehavior(mode: InsightsUiMode): InsightsUiBehavior {
  return {
    enableInsightsRoutes: mode !== "off",
    renderInsightsHome: mode === "on",
    useInsightsNavigation: mode === "on",
    showOverviewLab: mode === "beta",
    showLegacyDashboard: mode === "on"
  };
}
