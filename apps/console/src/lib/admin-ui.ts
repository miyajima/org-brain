import type { AdminLocale } from "./admin-copy";

export type AdminPageState =
  | "healthy"
  | "attention"
  | "empty"
  | "partial"
  | "error"
  | "loading"
  | "success";

export type AdminActionTone = "critical" | "warning" | "info" | "success";

export interface AdminAction {
  id: string;
  tone: AdminActionTone;
  title: string;
  description: string;
  count?: number;
  href?: string;
  submitAction?: string;
}

export interface RouteAuditCase {
  path: string;
  states: string[];
  locales: AdminLocale[];
  keyboardFlow: string[];
}

export const ADMIN_LOCALES: AdminLocale[] = ["en", "ja", "zh"];

export const adminCommonCopy = {
  en: {
    skipToContent: "Skip to main content",
    attention: "Needs attention",
    healthy: "No action needed",
    empty: "No records yet",
    partial: "Some information is unavailable",
    error: "We could not load this information",
    loading: "Loading",
    success: "Completed",
    retry: "Try again",
    technicalDetails: "Technical details",
    nextAction: "Next action",
    scopeDetails: "Scope and data freshness"
  },
  ja: {
    skipToContent: "メインコンテンツへ移動",
    attention: "対応が必要です",
    healthy: "現在、対応は不要です",
    empty: "まだ記録がありません",
    partial: "一部の情報を取得できません",
    error: "情報を読み込めませんでした",
    loading: "読み込み中",
    success: "完了しました",
    retry: "再試行",
    technicalDetails: "技術情報",
    nextAction: "次の操作",
    scopeDetails: "対象範囲とデータ鮮度"
  },
  zh: {
    skipToContent: "跳到主要内容",
    attention: "需要处理",
    healthy: "目前无需处理",
    empty: "尚无记录",
    partial: "部分信息不可用",
    error: "无法加载信息",
    loading: "正在加载",
    success: "已完成",
    retry: "重试",
    technicalDetails: "技术信息",
    nextAction: "下一步",
    scopeDetails: "范围和数据时效"
  }
} as const satisfies Record<AdminLocale, Record<string, string>>;

export function scopedAdminHref(path: string, current: URLSearchParams, overrides: Record<string, string | null> = {}) {
  const next = new URLSearchParams();
  for (const key of ["tenant_id", "project_id", "lang"]) {
    const value = current.get(key);
    if (value) next.set(key, value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null || value === "") next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return query ? `${path}?${query}` : path;
}
