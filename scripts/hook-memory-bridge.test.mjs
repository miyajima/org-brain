import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyMemoryRecord,
  normalizeRecord,
  prepareMemoryRecordForUpsert,
  resolveApiBase,
  resolveProjectNameForWorkspace
} from "./hook-memory-bridge.mjs";
import { resolveMemoryMode } from "./lib/memory-mode.mjs";

describe("hook-memory-bridge promotion", () => {
  it("keeps Cloudflare memory disabled by default", () => {
    expect(resolveMemoryMode({})).toMatchObject({
      cloudMemoryEnabled: false,
      orgSharingEnabled: false,
      scope: "local",
      cloudWritesAllowed: false,
      sharedWrite: false
    });
  });

  it("separates personal portable cloud memory from organization sharing", () => {
    expect(resolveMemoryMode({ ORGBRAIN_ENABLE_CLOUD_MEMORY: "true" })).toMatchObject({
      cloudMemoryEnabled: true,
      orgSharingEnabled: false,
      scope: "personal_cloud",
      cloudWritesAllowed: true,
      sharedWrite: false
    });

    expect(
      resolveMemoryMode({
        ORGBRAIN_ENABLE_CLOUD_MEMORY: "true",
        ORGBRAIN_ENABLE_ORG_SHARING: "true"
      })
    ).toMatchObject({
      cloudMemoryEnabled: true,
      orgSharingEnabled: true,
      scope: "organization",
      cloudWritesAllowed: true,
      sharedWrite: true
    });
  });

  it("does not allow organization sharing without Cloudflare memory", () => {
    expect(resolveMemoryMode({ ORGBRAIN_ENABLE_ORG_SHARING: "true" })).toMatchObject({
      cloudMemoryEnabled: false,
      orgSharingEnabled: true,
      scope: "local",
      cloudWritesAllowed: false,
      sharedWrite: false,
      configurationError: "ORGBRAIN_ENABLE_ORG_SHARING requires ORGBRAIN_ENABLE_CLOUD_MEMORY"
    });
  });

  it("uses ORGBRAIN_API_BASE as a fallback alias when canonical URL is absent", () => {
    expect(resolveApiBase({ ORGBRAIN_API_BASE: "https://legacy.example.test" })).toBe("https://legacy.example.test");
    expect(
      resolveApiBase({
        ORGBRAIN_API_URL: "https://canonical.example.test",
        ORGBRAIN_API_BASE: "https://legacy.example.test"
      })
    ).toBe("https://canonical.example.test");
  });

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
      cwd: "/tmp/workspaces/org-brain",
      "last-assistant-message":
        "原因は `wrangler` 本体ではなく、Cloudflare OAuth ログイン未完了でした。\n\n今回やったこと:\n- `wrangler login` を実行\n- OAuth 認証完了を確認\n- `wrangler whoami` と `pnpm usage:status` を再実行\n\n結果として D1 クエリは成功し、再発時は最初に `wrangler login` を確認する方針です。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.summary).toContain("org-brain |");
    expect(prepared.record.tags).toContain("promoted");
    expect(prepared.record.tags).toContain("diagnosis");
    expect(prepared.record.content).toContain("# Reusable Memory");
    expect(prepared.record.content).toContain("## Reuse Rule");
    expect(prepared.record.content).not.toContain("## Raw Payload");
  });

  it("promotes command and result pairs", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/tmp/workspaces/org-brain",
      "last-assistant-message":
        "調査のため `wrangler d1 execute open-brain --remote --json` を実行し、その後 `pnpm usage:status` も再実行しました。どちらも成功し、remote D1 へ届くことを確認できました。次回も同じ症状ならこの順で確認します。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.tags).toContain("command-result");
  });

  it("uses concrete takeaway details instead of vague Japanese completion titles", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/tmp/workspaces/omopay",
      "last-assistant-message":
        "3件とも修正しました。\n\n- `Payment` に `staff` と `store` の整合性バリデーションを追加しました。\n- `Merchant::DistributionSnapshotBuilder` は finalized 期間を再集計しません。\n- `bundle exec rspec spec/models/payment_spec.rb` を実行し、11 examples, 0 failures でした。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.summary).toContain("omopay | command-result | Payment");
    expect(prepared.record.summary).not.toContain("3件とも修正しました");
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
      cwd: "/tmp/workspaces/org-brain",
      "turn-id": "turn-123",
      "input-messages": ["現在の利用状況をレポートして"],
      "last-assistant-message": "原因は認証不足です。対処として `wrangler login` を実行しました。"
    });

    const record = normalizeRecord("codex", payload);
    expect(record.externalKey).toBe("codex:turn-123");
    expect(record.projectId).toBe("org-brain");
    expect(classifyMemoryRecord(record).action).toBe("skip");
  });

  it("respects explicit global project scope from payload", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/tmp/dot-agents",
      project_id: null,
      "last-assistant-message":
        "原因は、このMacでは再生成可能な大きいローカル成果物が複数の定位置に蓄積することです。対処として `df -h ~` で確認し、Chrome の OptGuideOnDeviceModel、Docker の未使用 image/build cache、Atomic Chat モデルを優先して削除します。結果として空き容量を回復でき、再発時も同じ順序で確認できます。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.projectId).toBeNull();
    expect(prepared.record.summary).toContain("(global) | diagnosis");
  });

  it("prompts once per workspace and persists the chosen project name", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "org-brain-project-map-"));
    const file = path.join(dir, "project-names.json");
    const record = {
      cwd: "/tmp/workspaces/org-brain",
      projectId: "org-brain"
    };

    const selected = await resolveProjectNameForWorkspace(record, {
      file,
      prompt: async (cwd, fallback) => {
        expect(cwd).toBe("/tmp/workspaces/org-brain");
        expect(fallback).toBe("org-brain");
        return "client-workspace";
      }
    });

    expect(selected).toBe("client-workspace");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved["/tmp/workspaces/org-brain"]).toBe("client-workspace");

    const reused = await resolveProjectNameForWorkspace(record, {
      file,
      prompt: async () => {
        throw new Error("prompt should not be called for saved workspaces");
      }
    });
    expect(reused).toBe("client-workspace");
  });

  it("falls back to basename(cwd) when the first prompt is left blank", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "org-brain-project-map-"));
    const file = path.join(dir, "project-names.json");

    const selected = await resolveProjectNameForWorkspace(
      {
        cwd: "/tmp/workspaces/demo-app",
        projectId: "demo-app"
      },
      {
        file,
        prompt: async () => ""
      }
    );

    expect(selected).toBe("demo-app");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved["/tmp/workspaces/demo-app"]).toBe("demo-app");
  });

  it("promotes structured project facts from learning-loop payloads", () => {
    const payload = JSON.stringify({
      type: "learning-loop",
      action: "record",
      context: {
        workspaceDir: "/tmp/workspaces/org-brain",
        messageId: "learning-loop:LRN-20260421-001",
        sessionKey: "learning-loop",
        bodyForAgent: "Canonical harness project fact."
      },
      memory_entry: {
        id: "LRN-20260421-001",
        type: "project-fact",
        tags: "toolchain,command,deploy",
        trigger: "org-brain workspace command confirmed",
        action: "use pnpm wrangler deploy from apps/api-gateway",
        result: "api-gateway deploy succeeds only when run from the worker directory",
        reuse: "reuse for this workspace until deploy wiring changes",
        source: "manual"
      }
    });

    const prepared = prepareMemoryRecordForUpsert("openclaw", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.tags).toContain("project-fact");
    expect(prepared.record.tags).toContain("curated-memory");
    expect(prepared.record.tags).toContain("toolchain");
    expect(prepared.record.content).toContain("# Project Fact");
    expect(prepared.record.content).toContain("## Decision");
    expect(prepared.record.content).toContain("## Reason");
    expect(prepared.record.content).toContain("## Evidence");
    expect(prepared.record.content).toContain("## Result");
    expect(prepared.record.content).toContain("## Validity");
    expect(prepared.record.actorId).toContain("openclaw:");
  });
});
