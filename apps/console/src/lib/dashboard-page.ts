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
  API_BASE_URL?: string;
};

type ProcessLike = {
  env?: Record<string, string | undefined>;
};

const LOCAL_BINDING_FAILURES = [
  "Couldn't find a local dev session",
  "Couldn't fetch from any upstream"
];

function buildDashboardApiUrl(url: URL, baseUrl: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const path = url.pathname.replace(/^\/api(?=\/)/u, "").replace(/^\/+/u, "");
  const target = new URL(path, normalizedBaseUrl);
  target.search = url.search;
  return target;
}

async function fetchDashboardResponse(url: URL): Promise<Response> {
  const processEnv = (globalThis as typeof globalThis & { process?: ProcessLike }).process?.env ?? {};
  let runtimeEnv: DashboardRuntimeEnv = {};
  try {
    runtimeEnv = (await import("cloudflare:workers")).env as unknown as DashboardRuntimeEnv;
  } catch {
    // Non-Cloudflare runtimes and unit tests use process env or the normal fetch path.
  }

  const internalApiKey = runtimeEnv.INTERNAL_API_KEY ?? processEnv.INTERNAL_API_KEY;
  const apiBaseUrl = (runtimeEnv.API_BASE_URL ?? processEnv.API_BASE_URL)?.trim() ?? "";
  if (runtimeEnv.API && internalApiKey) {
    try {
      const path = url.pathname.replace(/^\/api(?=\/)/u, "");
      const target = new URL(path || "/", "https://internal");
      target.search = url.search;
      const response = await runtimeEnv.API.fetch(target.toString(), {
        headers: {
          accept: "application/json",
          "x-api-key": internalApiKey
        }
      });
      if (!apiBaseUrl || response.status !== 503) return response;
      const body = await response.clone().text();
      if (!LOCAL_BINDING_FAILURES.some((message) => body.includes(message))) return response;
    } catch {
      if (!apiBaseUrl) throw new Error("Service binding fetch failed and API_BASE_URL is not configured");
    }
  }

  if (apiBaseUrl && internalApiKey) {
    return fetch(buildDashboardApiUrl(url, apiBaseUrl), {
      headers: {
        accept: "application/json",
        "x-api-key": internalApiKey
      }
    });
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
