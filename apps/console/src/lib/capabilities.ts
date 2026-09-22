import { createServerApi } from "./server-api";
import { dashboardTenantFromCookie } from "./dashboard-page";

export type Capability = { enabled: boolean; mode?: string; writable?: boolean; allowed_actions?: string[] };
const requests = new WeakMap<Request, Promise<Record<string, Capability> | null>>();

export const capabilityPaths: Record<string, string> = {
  "/dashboard/knowledge": "organization_dashboard",
  "/retrospectives": "retrospective",
  "/improvement-actions": "improvement_actions",
  "/knowledge-packs/onboarding": "knowledge_pack_onboarding",
  "/domain-packs": "domain_packs",
  "/domain-workspaces": "domain_workspaces",
  "/domain-metrics": "domain_metrics"
};

export function loadConsoleCapabilities(request: Request) {
  let pending = requests.get(request);
  if (!pending) {
    pending = (async () => {
      const tenant = new URL(request.url).searchParams.get("tenant_id")?.trim()
        || dashboardTenantFromCookie(request.headers.get("cookie")) || "default";
      const response = await createServerApi(request)(`/api/v1/capabilities?tenant_id=${encodeURIComponent(tenant)}`);
      if (!response.ok) return null;
      const payload = await response.json() as { data?: Record<string, Capability> };
      return payload.data ?? null;
    })().catch(() => null);
    requests.set(request, pending);
  }
  return pending;
}
