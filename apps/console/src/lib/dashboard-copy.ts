export type DashboardDisplayLocale = "en" | "ja" | "zh";
export type DashboardLabelKind = "status" | "capability" | "relation" | "job" | "role" | "permission" | "nodeKind" | "signal" | "event";

export type MemoryDisplayCopy = {
  title: string;
  context: string | null;
  preview: string;
  rawLabel: string;
};

function compactMemoryText(value: string | null | undefined, limit: number): string {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Memory summaries often contain an internal routing key such as
 * `project | category | readable title`. Keep that context available, but
 * make the part a person needs to read the visual title.
 */
export function memoryDisplayCopy(
  label: string | null | undefined,
  content: string | null | undefined
): MemoryDisplayCopy {
  const rawLabel = compactMemoryText(label, 240) || compactMemoryText(content, 240) || "Untitled memory";
  const parts = rawLabel.split(/\s*\|\s*/gu).map((part) => part.trim()).filter(Boolean);
  const hasRoutingPrefix = parts.length >= 3;
  const context = hasRoutingPrefix ? parts.slice(0, 2).join(" · ") : null;
  const title = compactMemoryText(
    hasRoutingPrefix ? parts.slice(2).join(" | ") : rawLabel,
    140
  ) || compactMemoryText(content, 140) || "Untitled memory";
  const preview = compactMemoryText(content, 220) || (title !== rawLabel ? rawLabel : "内容なし");
  return { title, context, preview, rawLabel };
}

const JAPANESE_LABELS: Record<DashboardLabelKind, Record<string, string>> = {
  status: {
    created: "作成済み",
    queued: "待機中",
    leased: "割り当て済み",
    running: "実行中",
    succeeded: "成功",
    failed: "失敗",
    dead_letter: "隔離",
    canceled: "キャンセル",
    active: "有効",
    idle: "待機中",
    used: "利用済み",
    stale: "古いデータ",
    ready: "利用可能",
    never_run: "未実行",
    pending: "保留中",
    manual_review: "要手動確認",
    expired: "期限切れ",
    unconfirmed: "未確認",
    conflicting: "競合",
    configured: "設定済み",
    not_configured: "未設定",
    complete: "完了",
    error: "エラー"
  },
  capability: {
    memory_measurement: "記憶品質測定",
    knowledge_graph: "知識グラフ更新"
  },
  relation: {
    derived_from: "根拠",
    mentions: "言及",
    belongs_to: "所属",
    related: "関連",
    supports: "支持",
    supersedes: "置き換え"
  },
  job: {
    "memory-maintenance": "記憶メンテナンス",
    "retrieval-metrics-rollup": "検索指標集計",
    "retention-sweep": "保持期限処理",
    memory_measurement: "記憶品質測定"
  },
  role: {
    tenant_admin: "テナント管理者",
    tenant_operator: "テナント運用者",
    tenant_reader: "テナント閲覧者"
  },
  permission: {
    "memory:read": "記憶の閲覧",
    "memory:write": "記憶の変更",
    "task:read": "Taskの閲覧",
    "task:replay": "Taskの再実行"
  },
  nodeKind: {
    semantic: "意味",
    architecture: "アーキテクチャ",
    concept: "概念",
    project: "プロジェクト",
    document: "資料",
    task: "Task"
  },
  signal: {
    task_failed: "Taskの失敗",
    task_stalled: "Taskの停滞",
    handoff_unacked: "引き継ぎ未確認",
    impact_unreported: "影響未報告",
    retrieval_miss: "検索未ヒット",
    negative_memory_effect: "記憶利用の悪影響",
    decision_conflict: "判断の競合",
    memory_dormant: "記憶の休眠",
    memory_expired: "記憶の期限切れ"
  },
  event: {
    "task.failed": "Taskの失敗",
    "memory.read": "メモリ参照",
    "memory.write": "メモリ更新",
    "memory.retrieval": "メモリ検索",
    "memory.effect": "メモリ効果"
  }
};

export function dashboardLabel(
  kind: DashboardLabelKind,
  value: string | null | undefined,
  locale: DashboardDisplayLocale = "en"
): string {
  const raw = value?.trim() || "未計測";
  return locale === "ja" ? JAPANESE_LABELS[kind][raw] ?? raw : raw;
}

export function dashboardLabelPair(
  kind: DashboardLabelKind,
  value: string | null | undefined,
  locale: DashboardDisplayLocale = "en"
): { label: string; raw: string } {
  const raw = value?.trim() || "未計測";
  return { label: dashboardLabel(kind, raw, locale), raw };
}

export type DashboardTone = "neutral" | "healthy" | "warning" | "critical";

export function dashboardStatusTone(value: string | null | undefined): DashboardTone {
  switch (value?.toLowerCase()) {
    case "succeeded":
    case "active":
    case "ready":
      return "healthy";
    case "failed":
    case "dead_letter":
    case "error":
      return "critical";
    case "stale":
    case "pending":
    case "manual_review":
    case "queued":
    case "running":
      return "warning";
    default:
      return "neutral";
  }
}
