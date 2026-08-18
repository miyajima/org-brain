export type DecisionConsoleMode = "off" | "beta" | "on";

export type DecisionConsoleBehavior = {
  enabled: boolean;
  renderDecisionHome: boolean;
  useDecisionNavigation: boolean;
  showBetaLabel: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function legacyRuntimeMode(locals: unknown): unknown {
  const localRecord = record(locals);
  try {
    const runtimeEnv = record(record(localRecord.runtime).env);
    if (runtimeEnv.DECISION_CONSOLE_MODE !== undefined) return runtimeEnv.DECISION_CONSOLE_MODE;
  } catch {
    // Astro 6 removed locals.runtime.env and may expose a throwing compatibility getter.
  }
  try {
    const directEnv = record(localRecord.env);
    if (directEnv.DECISION_CONSOLE_MODE !== undefined) return directEnv.DECISION_CONSOLE_MODE;
  } catch {
    // Feature flags remain fail-closed when an adapter exposes a throwing getter.
  }
  return undefined;
}

export function normalizeDecisionConsoleMode(value: unknown): DecisionConsoleMode {
  return value === "beta" || value === "on" ? value : "off";
}

export function processDecisionConsoleModeFallback(): unknown {
  const processLike = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, unknown> };
  }).process;
  return processLike?.env?.DECISION_CONSOLE_MODE;
}

export function resolveDecisionConsoleMode(locals: unknown, processFallback?: unknown): DecisionConsoleMode {
  return normalizeDecisionConsoleMode(legacyRuntimeMode(locals) ?? processFallback);
}

export async function resolveRequestDecisionConsoleMode(
  locals: unknown,
  processFallback?: unknown
): Promise<DecisionConsoleMode> {
  const legacyMode = legacyRuntimeMode(locals);
  if (legacyMode !== undefined) return normalizeDecisionConsoleMode(legacyMode);
  try {
    const runtime = await import("cloudflare:workers");
    const runtimeMode = record(runtime.env).DECISION_CONSOLE_MODE;
    if (runtimeMode !== undefined) return normalizeDecisionConsoleMode(runtimeMode);
  } catch {
    // Node builds and unit tests do not expose the Cloudflare runtime module.
  }
  return normalizeDecisionConsoleMode(processFallback);
}

export function decisionConsoleBehavior(mode: DecisionConsoleMode): DecisionConsoleBehavior {
  return {
    enabled: mode !== "off",
    renderDecisionHome: mode !== "off",
    useDecisionNavigation: mode !== "off",
    showBetaLabel: mode === "beta"
  };
}
