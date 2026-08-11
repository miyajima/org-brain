export type DashboardFetchResult<T> = {
  data: T;
  error: string | null;
};

export type DashboardTask = {
  id: string;
  tenant_id: string | null;
  project_id: string | null;
  capability: string;
  status: string;
  updated_at: number | string;
};

export const DASHBOARD_TASK_PAGE_SIZE = 20;
export const DASHBOARD_TASK_STATUSES = [
  "created",
  "queued",
  "leased",
  "running",
  "succeeded",
  "failed",
  "dead_letter",
  "canceled"
] as const;

export type DashboardTaskViewParams = ReturnType<typeof dashboardTaskPageParams>;

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

function cookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key !== name) continue;
    const value = valueParts.join("=");
    try {
      return decodeURIComponent(value).trim() || null;
    } catch {
      return value.trim() || null;
    }
  }
  return null;
}

export function dashboardTenantFromCookie(cookieHeader: string | null | undefined): string | null {
  return cookieValue(cookieHeader, "orgbrain_tenant");
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

export function dashboardPageParams(url: URL, cookieHeader?: string | null): {
  params: URLSearchParams;
  apiParams: URLSearchParams;
  tenantId: string;
  projectId: string | null;
  lang: "en" | "ja" | "zh";
} {
  const params = new URLSearchParams(url.searchParams);
  const tenantId = params.get("tenant_id")?.trim() || dashboardTenantFromCookie(cookieHeader) || "default";
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

export function dashboardTaskPageParams(url: URL, cookieHeader?: string | null) {
  const scope = dashboardPageParams(url, cookieHeader);
  const rawPage = Number.parseInt(url.searchParams.get("task_page") ?? "0", 10);
  const taskPage = Number.isFinite(rawPage) ? Math.min(1000, Math.max(0, rawPage)) : 0;
  const taskQuery = url.searchParams.get("task_q")?.trim().slice(0, 120) ?? "";
  const requestedStatus = url.searchParams.get("task_status")?.trim().slice(0, 64) ?? "";
  const taskStatus = /^[a-z][a-z0-9_-]{0,63}$/u.test(requestedStatus) ? requestedStatus : "";
  const apiParams = new URLSearchParams(scope.apiParams);
  const params = new URLSearchParams(scope.params);
  if (taskQuery) params.set("task_q", taskQuery);
  else params.delete("task_q");
  if (taskStatus) params.set("task_status", taskStatus);
  else params.delete("task_status");
  if (taskPage > 0) params.set("task_page", String(taskPage));
  else params.delete("task_page");
  if (taskQuery) apiParams.set("q", taskQuery);
  if (taskStatus) apiParams.set("status", taskStatus);
  apiParams.set("limit", String(DASHBOARD_TASK_PAGE_SIZE + 1));
  apiParams.set("offset", String(taskPage * DASHBOARD_TASK_PAGE_SIZE));
  return {
    ...scope,
    params,
    apiParams,
    taskPage,
    taskPageSize: DASHBOARD_TASK_PAGE_SIZE,
    taskQuery,
    taskStatus
  };
}

export function normalizeDashboardTasks(value: unknown): DashboardTask[] {
  if (!Array.isArray(value)) throw new Error("Dashboard task payload was invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Dashboard task payload was invalid");
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const capability = typeof record.capability === "string" ? record.capability.trim() : "";
    const status = typeof record.status === "string" ? record.status.trim() : "";
    const updatedAt = typeof record.updated_at === "number" && Number.isFinite(record.updated_at)
      ? record.updated_at
      : typeof record.updated_at === "string" && record.updated_at.trim() && Number.isFinite(Date.parse(record.updated_at))
        ? record.updated_at
        : null;
    if (!id || !capability || !status || updatedAt == null) {
      throw new Error("Dashboard task payload was invalid");
    }
    return {
      id,
      tenant_id: typeof record.tenant_id === "string" ? record.tenant_id : null,
      project_id: typeof record.project_id === "string" ? record.project_id : null,
      capability,
      status,
      updated_at: updatedAt
    };
  });
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
