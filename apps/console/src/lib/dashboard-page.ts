export type DashboardFetchResult<T> = {
  data: T;
  error: string | null;
};

type ApiEnvelope<T> = {
  ok?: boolean;
  data?: T;
  error?: { message?: string };
};

type DashboardRuntimeEnv = {
  API?: Fetcher;
  INTERNAL_API_KEY?: string;
};

async function fetchDashboardResponse(url: URL): Promise<Response> {
  try {
    const runtimeEnv = (await import("cloudflare:workers")).env as unknown as DashboardRuntimeEnv;
    if (runtimeEnv.API && runtimeEnv.INTERNAL_API_KEY) {
      const path = url.pathname.replace(/^\/api(?=\/)/u, "");
      const target = new URL(path || "/", "https://internal");
      target.search = url.search;
      return runtimeEnv.API.fetch(target.toString(), {
        headers: {
          accept: "application/json",
          "x-api-key": runtimeEnv.INTERNAL_API_KEY
        }
      });
    }
  } catch {
    // Non-Cloudflare runtimes and unit tests use the normal fetch path.
  }
  return fetch(url, { headers: { accept: "application/json" } });
}

export function dashboardPageParams(url: URL): {
  params: URLSearchParams;
  apiParams: URLSearchParams;
  tenantId: string;
  projectId: string | null;
  lang: "en" | "ja" | "zh";
} {
  const params = new URLSearchParams(url.searchParams);
  const tenantId = params.get("tenant_id")?.trim() || "default";
  const projectId = params.get("project_id")?.trim() || null;
  const requestedLang = params.get("lang");
  const lang = requestedLang === "ja" || requestedLang === "zh" ? requestedLang : "en";
  params.set("tenant_id", tenantId);
  if (projectId) params.set("project_id", projectId);
  else params.delete("project_id");
  const apiParams = new URLSearchParams({ tenant_id: tenantId });
  if (projectId) apiParams.set("project_id", projectId);
  return { params, apiParams, tenantId, projectId, lang };
}

export function dashboardApiPath(
  pathname: string,
  scope: URLSearchParams,
  additional: Record<string, string | number> = {}
): string {
  const params = new URLSearchParams(scope);
  for (const [key, value] of Object.entries(additional)) params.set(key, String(value));
  return params.size > 0 ? `${pathname}?${params.toString()}` : pathname;
}

export async function fetchDashboardData<T>(
  url: URL,
  normalize: (value: unknown) => T,
  fallback: T
): Promise<DashboardFetchResult<T>> {
  try {
    const response = await fetchDashboardResponse(url);
    const payload = await response.json() as ApiEnvelope<unknown>;
    if (!response.ok || payload.ok !== true || !("data" in payload)) {
      return {
        data: fallback,
        error: payload.error?.message || `Dashboard API request failed (HTTP ${response.status})`
      };
    }
    return { data: normalize(payload.data), error: null };
  } catch (error) {
    return {
      data: fallback,
      error: error instanceof Error ? error.message : "Dashboard API request failed"
    };
  }
}
