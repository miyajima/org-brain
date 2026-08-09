import { describe, expect, it } from "vitest";
import { intelligenceDateLocale, intelligencePageCopy } from "./intelligence-locale";

describe("intelligence locale copy", () => {
  it.each([
    ["en", "Organization activity", "Knowledge connections", "Knowledge history"],
    ["ja", "組織の活動", "知識のつながり", "知識の履歴"],
    ["zh", "组织活动", "知识关联", "知识历史"]
  ])("returns %s copy for every dashboard surface", (locale, nervous, constellation, strata) => {
    const copy = intelligencePageCopy(locale);
    expect(copy.nervous.title).toBe(nervous);
    expect(copy.constellation.title).toBe(constellation);
    expect(copy.strata.title).toBe(strata);
  });

  it("localizes navigation, polling states, and locale-sensitive dates", () => {
    expect(intelligencePageCopy("en").nav.decisionsAria).toBe("Decision views");
    expect(intelligencePageCopy("ja").poller.reconnecting).toContain("再接続中");
    expect(intelligencePageCopy("zh").nav.constellation).toBe("知识关联");
    expect(intelligenceDateLocale("en")).toBe("en-US");
    expect(intelligenceDateLocale("ja")).toBe("ja-JP");
    expect(intelligenceDateLocale("zh")).toBe("zh-CN");
    expect(intelligencePageCopy("ja").nervous.periods["7d"]).toBe("7日");
    expect(intelligencePageCopy("ja").nervous.periods["30d"]).toBe("30日");
    expect(intelligencePageCopy("ja").nervous.filterByCapability).toContain("絞り込む");
  });

  it("falls back to English for an unsupported locale", () => {
    expect(intelligencePageCopy("fr").poller.live).toBe("Live");
    expect(intelligenceDateLocale("fr")).toBe("en-US");
  });
});
