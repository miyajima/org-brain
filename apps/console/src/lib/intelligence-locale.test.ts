import { describe, expect, it } from "vitest";
import { intelligenceDateLocale, intelligencePageCopy } from "./intelligence-locale";

describe("intelligence locale copy", () => {
  it.each([
    ["en", "Your organization is learning in real time", "Knowledge Constellation", "What your organization knows now"],
    ["ja", "あなたの組織は、リアルタイムで学習しています", "ナレッジ・コンステレーション", "いま、あなたの組織が知っていること"],
    ["zh", "您的组织正在实时学习", "知识星图", "您的组织当前掌握的知识"]
  ])("returns %s copy for every dashboard surface", (locale, nervous, constellation, strata) => {
    const copy = intelligencePageCopy(locale);
    expect(copy.nervous.title).toBe(nervous);
    expect(copy.constellation.title).toBe(constellation);
    expect(copy.strata.title).toBe(strata);
  });

  it("localizes navigation, polling states, and locale-sensitive dates", () => {
    expect(intelligencePageCopy("en").nav.decisionsAria).toBe("Decision views");
    expect(intelligencePageCopy("ja").poller.reconnecting).toContain("再接続中");
    expect(intelligencePageCopy("zh").nav.constellation).toBe("知识星图");
    expect(intelligenceDateLocale("en")).toBe("en-US");
    expect(intelligenceDateLocale("ja")).toBe("ja-JP");
    expect(intelligenceDateLocale("zh")).toBe("zh-CN");
  });

  it("falls back to English for an unsupported locale", () => {
    expect(intelligencePageCopy("fr").poller.live).toBe("Live");
    expect(intelligenceDateLocale("fr")).toBe("en-US");
  });
});
