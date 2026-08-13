import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  DurableRuleMemoryExtractor,
  extractDurableMemoryDrafts,
  normalizeMemoryPaths,
  screenSensitiveMemory
} from "../src";

describe("memory capture v2 policy", () => {
  it("meets the durable/transient precision and recall gate", async () => {
    const fixtures = JSON.parse(await readFile(
      new URL("./fixtures/memory-capture-quality-labeled.json", import.meta.url),
      "utf8"
    )) as Array<{ id: string; durable: boolean; text: string }>;
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const fixture of fixtures) {
      const predictedDurable = extractDurableMemoryDrafts({
        event_id: fixture.id,
        tenant_id: "default",
        project_id: "org-brain",
        source: "fixture",
        occurred_at: 1_786_000_000_000,
        text: fixture.text
      }).drafts.length > 0;
      if (predictedDurable && fixture.durable) truePositive += 1;
      if (predictedDurable && !fixture.durable) falsePositive += 1;
      if (!predictedDurable && fixture.durable) falseNegative += 1;
    }
    const precision = truePositive / Math.max(1, truePositive + falsePositive);
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });

  it("keeps the harness and ordinary-response compatibility fixture stable", async () => {
    const fixtures = JSON.parse(await readFile(
      new URL("./fixtures/memory-capture-v2.json", import.meta.url),
      "utf8"
    )) as Array<{
      event: Parameters<typeof extractDurableMemoryDrafts>[0];
      expected_kinds: string[];
      maximum_confidence: number;
    }>;
    for (const fixture of fixtures) {
      const result = extractDurableMemoryDrafts(fixture.event);
      expect(result.drafts.map((draft: { kind: string }) => draft.kind)).toEqual(fixture.expected_kinds);
      for (const draft of result.drafts) {
        expect(draft.confidence_score).toBeLessThanOrEqual(fixture.maximum_confidence);
      }
    }
  });

  it("rejects transient completion and command-result messages", () => {
    const result = extractDurableMemoryDrafts({
      event_id: "evt-transient",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      occurred_at: 1_786_000_000_000,
      text: "実装完了しました。`pnpm test` は成功し、commitとpushも完了しました。"
    });
    expect(result.drafts).toEqual([]);
    expect(result.excluded.some((item: { reason: string }) => item.reason === "transient")).toBe(true);
  });

  it("does not turn status tables, schema fragments, or approval nouns into decisions", () => {
    const result = extractDurableMemoryDrafts({
      event_id: "evt-structural-noise",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      occurred_at: 1_786_000_000_000,
      text: [
        "| HermesをMacで常駐 | 動かない | Mac依存 | 対話型エージェント | 不採用 |",
        "`approval_requests`: 誰が何を承認したか",
        "D1: 投稿本文、投稿予定時刻、承認状態、実行結果を保存",
        "Cloudflare OSはGatekeeperによる承認を提供します。",
        "`gpt-5.6-luna`はこのセッションでは利用不可でした。",
        "decision/constraint自動upsertと厳格なblock/review判定"
      ].join("\n")
    });
    expect(result.drafts).toEqual([]);
  });

  it("still recognizes explicit decisions after tightening noun-only matches", () => {
    const result = extractDurableMemoryDrafts({
      event_id: "evt-explicit-decision",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      occurred_at: 1_786_000_000_000,
      text: "ORGBRAIN_API_URLへ統一する方針とする。理由は設定名の二重管理を防ぐため。"
    });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({ kind: "decision" });
  });

  it("keeps evidence local to each ordinary-response candidate", () => {
    const result = extractDurableMemoryDrafts({
      event_id: "evt-local-evidence",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      occurred_at: 1_786_000_000_000,
      text: [
        "Never commit credentials.",
        "We decided to standardize on D1 (https://developers.cloudflare.com/d1/)"
      ].join("\n")
    });
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0].evidence).toEqual([]);
    expect(result.drafts[1].evidence).toEqual([
      expect.objectContaining({ type: "doc", ref: "https://developers.cloudflare.com/d1/" })
    ]);
  });

  it("extracts at most three atomic durable statements", () => {
    const result = extractDurableMemoryDrafts({
      event_id: "evt-durable",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      occurred_at: 1_786_000_000_000,
      text: [
        "API URLはORGBRAIN_API_URLへ統一する方針とする。理由は設定名の二重管理を防ぐため。",
        "新規コードでORGBRAIN_API_BASEを使用してはいけない。",
        "再発時は `pnpm test` を実行し、0 failuresを確認する。",
        "設定の正規ファイルはconfig/orgbrain.jsonに配置されている。"
      ].join("\n\n")
    });
    expect(result.drafts).toHaveLength(3);
    expect(result.drafts.map((item: { kind: string }) => item.kind)).toEqual([
      "decision",
      "constraint",
      "fact"
    ]);
    expect(result.drafts[0].rationale).not.toBe(result.drafts[0].content);
    expect(result.drafts[0].rationale).toContain("設定名の二重管理を防ぐため");
    expect(result.drafts[0].content).not.toContain("設定名の二重管理を防ぐため");
  });

  it("hard-rejects credentials and defaults PII to deny", () => {
    expect(screenSensitiveMemory("api_key=super-secret-value-12345", { mode: "restricted_7d", allowed_principals: ["p1"] })).toMatchObject({
      allowed: false,
      hard_reject: true,
      reason: "credential_detected"
    });
    expect(screenSensitiveMemory("Contact alice@example.com", { mode: "deny", allowed_principals: [] })).toMatchObject({
      allowed: false,
      hard_reject: false,
      reason: "sensitive_default_deny"
    });
  });

  it("allows only redacted restricted PII with principals and a seven-day TTL", () => {
    const occurredAt = 1_786_000_000_000;
    const result = extractDurableMemoryDrafts({
      event_id: "evt-pii",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      occurred_at: occurredAt,
      text: "連絡先はalice@example.comを使用する方針とする。理由は担当窓口を統一するため。"
    }, {
      sensitive_policy: { mode: "restricted_7d", allowed_principals: ["p1"] }
    });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({
      visibility: "restricted",
      allowed_principals: ["p1"],
      valid_until: occurredAt + 7 * 24 * 60 * 60 * 1000
    });
    expect(result.drafts[0].content).toContain("[REDACTED_EMAIL]");
  });

  it("does not treat dates, timestamps, or numeric status ids as phone numbers", () => {
    const value = "2026-08-12 13:45:00 timestamp=1786000000000 https://x.com/user/status/1955555555555555555";
    expect(screenSensitiveMemory(value, { mode: "deny", allowed_principals: [] })).toMatchObject({
      allowed: true,
      counts: { phone_numbers: 0 }
    });
  });

  it("uses harness sections and caps uncertain decisions below the block threshold", async () => {
    const extractor = new DurableRuleMemoryExtractor();
    const result = await extractor.extract({
      event_id: "evt-harness",
      tenant_id: "default",
      project_id: "org-brain",
      source: "codex",
      occurred_at: 1_786_000_000_000,
      text: [
        "## Conclusion",
        "ORGBRAIN_API_URLを正規変数として採用することにした。",
        "",
        "## Reason",
        "互換aliasとの二重管理を防ぐため。",
        "",
        "## Evidence",
        "docs/SPEC.md と `pnpm test`（0 failures）",
        "",
        "## Gaps",
        "外部利用者の移行状況は未確認。"
      ].join("\n")
    });
    expect(result.extractor).toBe("durable-rules-v2");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].confidence_score).toBeLessThanOrEqual(0.89);
    expect(result.candidates[0].evidence.some((item) => item.type === "file")).toBe(true);
  });

  it("removes UI directives and stores only repo-relative paths", () => {
    const normalized = normalizeMemoryPaths(
      "::git-stage{cwd=\"/Users/me/projects/org-brain\"}\n/Users/me/projects/org-brain/packages/shared/src/index.ts を使用する。\n/Users/other/private.txt",
      "/Users/me/projects/org-brain"
    );
    expect(normalized).not.toContain("::git-stage");
    expect(normalized).toContain("packages/shared/src/index.ts");
    expect(normalized).toContain("[external-path]");
    expect(normalized).not.toContain("/Users/");
    expect(normalizeMemoryPaths("See /home/other/private.txt and /tmp/session/output.log")).toBe(
      "See [external-path] and [external-path]"
    );
  });
});
