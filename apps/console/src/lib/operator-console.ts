import { createServerApi } from "./server-api";
import { dashboardTenantFromCookie } from "./dashboard-page";

export type OperatorLocale = "ja" | "en" | "zh";
export type ConsoleRecord = Record<string, any>;
export type KnowledgeKind = "memory" | "decision" | "resource";
export type ConsoleResult<T = ConsoleRecord> = { data: T | null; error: string | null; status?: number };
export const localText = (lang: OperatorLocale) => (ja: string, en: string, zh: string) => lang === "en" ? en : lang === "zh" ? zh : ja;

export function operatorScope(url: URL, cookie: string | null = null) {
  const rawLang = url.searchParams.get("lang");
  return {
    tenantId: url.searchParams.get("tenant_id")?.trim() || dashboardTenantFromCookie(cookie) || "default",
    projectId: url.searchParams.get("project_id")?.trim() || "",
    lang: (rawLang === "en" || rawLang === "zh" ? rawLang : "ja") as OperatorLocale,
    period: url.searchParams.get("period") === "30d" ? "30d" : "7d"
  };
}

export function operatorRequestUrl(request: Request) {
  const url = new URL(request.url);
  const scope = operatorScope(url, request.headers.get("cookie"));
  url.searchParams.set("tenant_id", scope.tenantId);
  url.searchParams.set("lang", scope.lang);
  return url;
}

/** Global navigation carries scope only; record IDs never leak across projects. */
export function operatorHref(url: URL, path: string, changes: Record<string, string | null | undefined> = {}) {
  const scope = operatorScope(url);
  const params = new URLSearchParams({ tenant_id: scope.tenantId, lang: scope.lang });
  if (scope.projectId) params.set("project_id", scope.projectId);
  for (const [key, value] of Object.entries(changes)) value == null || value === "" ? params.delete(key) : params.set(key, value);
  return `${path}?${params}`;
}

export function viewHref(url: URL, changes: Record<string, string | null | undefined>) {
  const params = new URLSearchParams(url.searchParams);
  for (const [key, value] of Object.entries(changes)) value == null || value === "" ? params.delete(key) : params.set(key, value);
  return `${url.pathname}?${params}`;
}

export function apiScope(url: URL, cookie: string | null = null, extra: Record<string, string> = {}) {
  const scope = operatorScope(url, cookie);
  const params = new URLSearchParams({ tenant_id: scope.tenantId });
  if (scope.projectId) params.set("project_id", scope.projectId);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params;
}

export function metricValue(value: unknown, state?: string): number | null {
  if (state && !["verified", "measured", "observed"].includes(state)) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function displayNumber(value: unknown, lang: OperatorLocale, state?: string) {
  const number = metricValue(value, state);
  return number === null ? "—" : new Intl.NumberFormat(lang).format(number);
}

export function displayDate(value: unknown, lang: OperatorLocale) {
  if (value == null || value === "") return "—";
  const date = new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(lang, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone:"Asia/Tokyo" }).format(date);
}

export function asRows(data: unknown, ...keys: string[]): ConsoleRecord[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of keys) if (Array.isArray((data as ConsoleRecord)[key])) return (data as ConsoleRecord)[key];
  }
  return [];
}

export type KnowledgeRow = { kind: KnowledgeKind; id: string; title: string; preview: string; project: string; state: string; updated: unknown; raw: ConsoleRecord };
export function knowledgeRows(kind: KnowledgeKind, data: unknown): KnowledgeRow[] {
  return asRows(data, "items", "results", "decisions").filter(row => row.id || row.memory_id).map(row => ({
    kind, id: String(row.id ?? row.memory_id),
    title: String(row.summary || row.conclusion || row.title || row.content_preview || row.content || row.id),
    preview: String(row.reason_summary || row.rationale || row.decision || row.content_preview || row.content || row.canonical_uri || ""),
    project: String(row.project_id || row.projectId || ""),
    state: String(row.verification_state || (row.confirmationState === "user_confirmed" ? "confirmed" : row.confirmationState) || row.status || row.lifecycle_state || "unverified"),
    updated: row.updated_at ?? row.updatedAt ?? row.created_at, raw: row
  }));
}

export async function readConsoleData<T = ConsoleRecord>(request: Request, path: string, init: RequestInit = {}, transport: typeof fetch = fetch): Promise<ConsoleResult<T>> {
  const text = localText(operatorScope(new URL(request.url)).lang);
  try {
    const response = await createServerApi(request, transport)(path, init);
    if (!response.ok) return { data: null, status: response.status, error: text(`取得できません（HTTP ${response.status}）。再試行してください。`, `Unavailable (HTTP ${response.status}). Try again.`, `无法获取（HTTP ${response.status}）。请重试。`) };
    const payload = await response.json() as { ok?: boolean; data?: T };
    if (payload?.ok !== true || payload.data == null) return { data: null, error: text("情報を取得できません。再試行してください。", "Information unavailable. Try again.", "无法获取信息。请重试。") };
    return { data: payload.data as T, error: null };
  } catch {
    return { data: null, error: text("接続または応答を確認できません。再試行してください。", "Connection or response unavailable. Try again.", "无法确认连接或响应。请重试。") };
  }
}

const identities = new WeakMap<Request, Promise<ConsoleResult>>();
export function operatorIdentity(request: Request) {
  let result = identities.get(request);
  if (!result) {
    const url = new URL(request.url);
    result = readConsoleData(request, `/api/v1/auth/me?${apiScope(url, request.headers.get("cookie"))}`);
    identities.set(request, result);
  }
  return result;
}

export function safeExternalHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

export function stateLabel(state: string, lang: OperatorLocale) {
  const labels: Record<string, [string, string, string]> = {
    verified: ["確認済み", "Verified", "已确认"], unverified: ["未確認", "Unverified", "未确认"], partial: ["一部確認", "Partially verified", "部分确认"], rejected: ["利用対象外", "Rejected", "不予使用"],
    active: ["有効", "Active", "有效"], suppressed: ["利用停止", "Suppressed", "已停用"], confirmed: ["確認済み", "Confirmed", "已确认"], draft: ["下書き", "Draft", "草稿"],
    deprovisioned: ["登録解除", "Deprovisioned", "已取消登记"], published: ["公開済み", "Published", "已发布"], revoked: ["無効化済み", "Revoked", "已停用"], succeeded: ["成功", "Succeeded", "成功"], user_confirmed: ["確認済み", "Confirmed", "已确认"], inferred_unconfirmed: ["未確認の推定", "Unconfirmed inference", "未确认的推断"],
    unconfirmed: ["要確認", "Needs review", "待确认"], expired: ["期限切れ", "Expired", "已过期"], artifact_missing: ["根拠・成果物を確認", "Check evidence and artifacts", "检查依据与成果"], share_pending: ["共有待ち", "Sharing pending", "待共享"],
    critical: ["優先対応", "Urgent", "紧急"], warning: ["要確認", "Needs attention", "待检查"], blocked: ["利用保留", "Use blocked", "暂缓使用"], healthy: ["問題なし", "Healthy", "正常"],
    invited: ["招待中", "Invited", "已邀请"], suspended: ["停止中", "Suspended", "已暂停"], completed: ["完了", "Completed", "完成"], failed: ["失敗", "Failed", "失败"], running: ["実行中", "Running", "运行中"], pending: ["待機中", "Pending", "等待中"],
    private: ["本人のみ", "Private", "仅本人"], project: ["プロジェクト", "Project", "项目"], tenant: ["組織内", "Organization", "组织内"], group: ["グループ", "Group", "群组"], restricted: ["指定した対象", "Restricted", "指定对象"],
  };
  const entry = labels[state];
  return entry ? localText(lang)(...entry) : state;
}

export function legacyConsoleDestination(url: URL): string | null {
  const path = url.pathname.replace(/\/$/, "") || "/";
  const kinds: Record<string, KnowledgeKind> = { "/memories": "memory", "/decisions": "decision", "/resources": "resource" };
  const settings: Record<string, string> = { "/organization": "organization", "/users": "users", "/groups": "groups", "/client-installations": "connections", "/profile": "profile", "/business-categories": "categories", "/operations": "operations", "/agents": "agents", "/skills": "skills", "/domain-packs":"packs", "/domain-metrics":"metrics", "/retrospectives":"retrospectives", "/improvement-actions":"improvements" };
  const params = new URLSearchParams(url.searchParams);
  if (kinds[path] && !params.has("view")) {
    params.set("kind", kinds[path]);
    const selected = params.get("selected") || params.get("id");
    if (selected) params.set("id", selected);
    return `/knowledge?${params}`;
  }
  const decision = path.match(/^\/decisions\/([^/]+)$/);
  if (decision && !["new", "history"].includes(decision[1])) { params.set("kind", "decision"); params.set("id", decodeURIComponent(decision[1])); return `/knowledge?${params}`; }
  if(path === "/dashboard"){params.set("section","operations");return `/settings?${params}`;}
  if(path === "/tasks" || /^\/tasks\/[^/]+$/.test(path) && path !== "/tasks/new") {params.set("section","operations"); if(path !== "/tasks") params.set("id",decodeURIComponent(path.slice(7))); return `/settings?${params}`;}
  const group=path.match(/^\/groups\/([^/]+)$/);if(group){params.set("section","groups");params.set("id",decodeURIComponent(group[1]));return `/settings?${params}`;}
  const retro=path.match(/^\/retrospectives\/([^/]+)(?:\/admin)?$/);if(retro){params.set("section","retrospectives");params.set("id",decodeURIComponent(retro[1]));return `/settings?${params}`;}
  if(path === "/dashboard/knowledge" || path === "/knowledge-dashboard"){params.set("view","goals");return `/?${params}`;}
  if (settings[path]) { params.set("section", settings[path]); return `/settings?${params}`; }
  if (["/overview", "/dashboard", "/knowledge-dashboard", "/memory-impact"].includes(path)) return `/?${params}`;
  return null;
}
