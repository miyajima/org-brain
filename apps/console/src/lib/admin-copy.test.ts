import { describe, expect, it } from "vitest";
import { groupAdminCopy, userAdminCopy } from "./admin-copy";
import { isKnownMemoryAttentionReason, memoryAttentionReasonLabel, memoryDetailCopy } from "./console-locale";

describe("admin confirmation copy", () => {
  it("keeps every destructive-action explanation localized in Chinese", () => {
    const copy = groupAdminCopy("zh");
    const messages = [
      copy.addImpact("发布组"),
      copy.addRecovery,
      copy.removeRecovery,
      copy.archiveImpact,
      copy.archiveRecovery,
      copy.removeAria("王小明")
    ];

    expect(messages.join(" ")).not.toMatch(/Adds|Membership|user can|Removes|current API|Remove/u);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining("发布组"),
      expect.stringContaining("重新添加"),
      expect.stringContaining("共享访问")
    ]));
  });

  it("keeps user invitation and access-change confirmations localized in Chinese", () => {
    const copy = userAdminCopy("zh");
    const messages = [copy.inviteImpact, copy.inviteRecovery, copy.updateImpact, copy.updateRecovery];

    expect(messages.join(" ")).not.toMatch(/Invites|Status|role|effective access/u);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining("邀请"),
      expect.stringContaining("实际访问权限")
    ]));
  });

  it("keeps memory technical fields consistently localized", () => {
    const copies = [memoryDetailCopy("en"), memoryDetailCopy("ja"), memoryDetailCopy("zh")];

    expect(copies.map((copy) => Object.keys(copy))).toEqual([
      Object.keys(copies[0]),
      Object.keys(copies[0]),
      Object.keys(copies[0])
    ]);
    expect(copies.map((copy) => copy.technical)).toEqual(["Technical information", "技術情報", "技术信息"]);
    expect(copies.map((copy) => copy.answerImpact)).toEqual(["Answer impact", "回答への影響", "对回答的影响"]);
    expect(memoryAttentionReasonLabel("en", "future_internal_code")).toBe("Other review reason");
    expect(memoryAttentionReasonLabel("ja", "future_internal_code")).toBe("その他の確認理由");
    expect(memoryAttentionReasonLabel("zh", "future_internal_code")).toBe("其他检查原因");
    for (const inheritedKey of ["toString", "constructor", "__proto__"]) {
      expect(isKnownMemoryAttentionReason("en", inheritedKey)).toBe(false);
      expect(memoryAttentionReasonLabel("en", inheritedKey)).toBe("Other review reason");
    }
    expect(["toString", "constructor", "__proto__"].filter((reason) => !isKnownMemoryAttentionReason("en", reason)))
      .toEqual(["toString", "constructor", "__proto__"]);
    expect(isKnownMemoryAttentionReason("en", "conflicted")).toBe(true);
    expect(memoryAttentionReasonLabel("en", "conflicted")).toBe("Conflicting evidence");
  });
});
