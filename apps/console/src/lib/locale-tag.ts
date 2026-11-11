import { normalizeLocale } from "./decision-ui";

const LOCALE_TAGS = { en: "en-US", ja: "ja-JP", zh: "zh-CN" } as const;

// BCP 47 tag for Intl and toLocaleString. Unknown or missing locales resolve to en-US.
export function localeTag(value: string | null | undefined): string {
  return LOCALE_TAGS[normalizeLocale(value)];
}
