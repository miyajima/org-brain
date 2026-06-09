export type OwnerRef = {
  type?: string;
  id?: string;
  name?: string;
};

export type SourceRef = {
  type?: string;
  id?: string;
  title?: string;
  url?: string;
  updatedAt?: string;
};

export type StructuredRow = Record<string, FormDataEntryValue | string | null | undefined>;
export type Locale = "en" | "ja" | "zh";

export const LOCALES: Array<{ code: Locale; label: string }> = [
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" }
];

export const CONFIRMATION_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    draft: "Draft",
    inferred_unconfirmed: "Unconfirmed inference",
    user_confirmed: "Human confirmed",
    user_corrected: "Human corrected",
    reviewed: "Reviewed"
  },
  ja: {
    draft: "下書き",
    inferred_unconfirmed: "未確認の推定",
    user_confirmed: "人が確認済み",
    user_corrected: "人が修正済み",
    reviewed: "レビュー済み"
  },
  zh: {
    draft: "草稿",
    inferred_unconfirmed: "未确认推断",
    user_confirmed: "人工确认",
    user_corrected: "人工修正",
    reviewed: "已审核"
  }
};

export const STATUS_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    active: "Active",
    uncertain: "Needs review",
    deprecated: "Deprecated",
    superseded: "Superseded"
  },
  ja: {
    active: "有効",
    uncertain: "要確認",
    deprecated: "廃止",
    superseded: "置き換え済み"
  },
  zh: {
    active: "有效",
    uncertain: "待确认",
    deprecated: "已废弃",
    superseded: "已替代"
  }
};

export const FRESHNESS_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    current: "Current",
    stale: "Possibly stale"
  },
  ja: {
    current: "新鮮",
    stale: "古い可能性"
  },
  zh: {
    current: "新鲜",
    stale: "可能过期"
  }
};

export const OPERATION_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    create: "Created",
    revise: "Revised",
    confirm: "Confirmed"
  },
  ja: {
    create: "作成",
    revise: "改訂",
    confirm: "確認"
  },
  zh: {
    create: "已创建",
    revise: "已修订",
    confirm: "已确认"
  }
};

export function displayLabel(labels: Record<string, string>, value: string | null | undefined): string {
  const key = String(value ?? "").trim();
  return labels[key] ?? (key || "-");
}

export function normalizeLocale(value: string | null | undefined): Locale {
  if (value === "ja" || value === "zh") return value;
  return "en";
}

export function confirmationLabel(value: string | null | undefined, locale: Locale = "en"): string {
  return displayLabel(CONFIRMATION_LABELS[locale], value);
}

export function statusLabel(value: string | null | undefined, locale: Locale = "en"): string {
  return displayLabel(STATUS_LABELS[locale], value);
}

export function freshnessLabel(value: string | null | undefined, locale: Locale = "en"): string {
  return displayLabel(FRESHNESS_LABELS[locale], value);
}

export function operationLabel(value: string | null | undefined, locale: Locale = "en"): string {
  return displayLabel(OPERATION_LABELS[locale], value);
}

export function isHumanConfirmed(state: string | null | undefined): boolean {
  return state === "user_confirmed" || state === "user_corrected" || state === "reviewed";
}

export function isUnconfirmedInference(state: string | null | undefined): boolean {
  return state === "inferred_unconfirmed";
}

export function isExpired(validUntil: number | null | undefined, now = Date.now()): boolean {
  return typeof validUntil === "number" && Number.isFinite(validUntil) && validUntil < now;
}

export function trimField(value: unknown, limit: number): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, limit) : undefined;
}

export function compactOwnerRefs(rows: StructuredRow[], maxItems = 16): OwnerRef[] {
  return rows
    .map((row) => ({
      type: trimField(row.type, 64),
      id: trimField(row.id, 128),
      name: trimField(row.name, 160)
    }))
    .filter((row) => Boolean(row.id || row.name))
    .slice(0, maxItems);
}

export function compactSourceRefs(rows: StructuredRow[], maxItems = 16): SourceRef[] {
  return rows
    .map((row) => ({
      type: trimField(row.type, 80),
      id: trimField(row.id, 160),
      title: trimField(row.title, 240),
      url: trimField(row.url, 500),
      updatedAt: trimField(row.updatedAt, 80)
    }))
    .filter((row) => Boolean(row.type || row.id || row.title || row.url))
    .slice(0, maxItems);
}

export function refLabel(ref: OwnerRef | SourceRef): string {
  const name = "name" in ref ? ref.name : undefined;
  const title = "title" in ref ? ref.title : undefined;
  return [name, title, ref.id, ref.type].filter(Boolean).join(" / ") || "Unknown";
}
