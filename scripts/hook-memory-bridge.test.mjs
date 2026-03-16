import { describe, expect, it } from "vitest";
import { classifyMemoryRecord, normalizeRecord, prepareMemoryRecordForUpsert } from "./hook-memory-bridge.mjs";

describe("hook-memory-bridge promotion", () => {
  it("skips generic agent-turn-complete messages", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/tmp/org-brain",
      "last-assistant-message": "必要な作業は終わっています。ほかに進める内容があれば、そのまま書いてください。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("skip");
  });

  it("promotes Japanese diagnosis and fix memories", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/Users/miya/projects/org-brain",
      "last-assistant-message":
        "原因は `wrangler` 本体ではなく、Cloudflare OAuth ログイン未完了でした。\n\n今回やったこと:\n- `wrangler login` を実行\n- OAuth 認証完了を確認\n- `wrangler whoami` と `pnpm usage:status` を再実行\n\n結果として D1 クエリは成功し、再発時は最初に `wrangler login` を確認する方針です。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.summary).toContain("promoted-memory");
    expect(prepared.record.tags).toContain("promoted");
    expect(prepared.record.tags).toContain("diagnosis");
    expect(prepared.record.content).toContain("# Reusable Memory");
    expect(prepared.record.content).toContain("## Reuse Rule");
    expect(prepared.record.content).not.toContain("## Raw Payload");
  });

  it("promotes command and result pairs", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/Users/miya/projects/org-brain",
      "last-assistant-message":
        "調査のため `wrangler d1 execute open-brain --remote --json` を実行し、その後 `pnpm usage:status` も再実行しました。どちらも成功し、remote D1 へ届くことを確認できました。次回も同じ症状ならこの順で確認します。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.tags).toContain("command-result");
  });

  it("skips payloads without project id", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      "last-assistant-message":
        "原因は認証不足です。対処として `wrangler login` を実行し、再発防止として最初に認証確認を入れます。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("skip");
  });

  it("extracts normalized codex records", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/Users/miya/projects/org-brain",
      "turn-id": "turn-123",
      "input-messages": ["現在の利用状況をレポートして"],
      "last-assistant-message": "原因は認証不足です。対処として `wrangler login` を実行しました。"
    });

    const record = normalizeRecord("codex", payload);
    expect(record.externalKey).toBe("codex:turn-123");
    expect(record.projectId).toBe("org-brain");
    expect(classifyMemoryRecord(record).action).toBe("skip");
  });
});
