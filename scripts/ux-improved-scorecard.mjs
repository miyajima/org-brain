#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const definitions = [
  {
    id: "local_setup", label: "ローカル初回セットアップ", weight: 0.15, evidence: ["L-01", "L-02"],
    labels: ["Local / Cloudflare / Managedの選択しやすさ", "Node・pnpmなど前提条件のわかりやすさ", "インストール手順の短さと成功率", "init と doctor の案内・結果の理解しやすさ", "初回メモリ登録から検索成功まで", "Codex接続のdry-run、適用、確認のしやすさ", "Time to First Value", "成功状態と次に何をすべきかの明確さ", "Node不一致、権限、古いCLI、設定競合からの復旧", "DB保存場所、プライバシー、バックアップへの安心感", "Codex再起動、hook信頼、保守・更新方法の理解しやすさ"],
    scores: [90, 90, 90, 95, 90, 85, 85, 95, 90, 95, 85]
  },
  {
    id: "cloudflare_setup", label: "Cloudflare初回セットアップ", weight: 0.20, evidence: ["CF-01"],
    labels: ["必要なCloudflare知識と権限の理解しやすさ", "最小権限トークンの作りやすさ", "envとWrangler設定の準備", "cf doctor と cf doctor --live の診断品質", "cf provision dry-runの読みやすさ", "provisioning実行中の進捗表示", "再実行時の冪等性と部分失敗からの復旧", "デプロイ順序と依存関係の理解しやすさ", "Consoleへの初回ログイン", "Remote MCPのOAuth接続", "Cloud hookの登録コード発行・秘密入力・承認・確認", "最初の共有メモリを別ユーザーが利用できるまで", "認証失敗・期限切れ登録コード・接続障害からの復旧", "デプロイ後のsmoke testと運用準備の明確さ"],
    scores: [null, null, 90, 90, 95, 85, 90, 90, null, null, null, null, null, null]
  },
  {
    id: "ai_safety", label: "AI提案・失敗回避UX", weight: 0.30, evidence: ["AI-01"],
    labels: ["OrgBrainの提案が表示されるタイミング", "検索・提案内容の関連性", "不要な提案やノイズの少なさ", "次の行動に変換できる具体性", "なぜこの提案かの説明", "根拠・参照元・日時・メモリIDの追跡可能性", "信頼度・不足情報の伝わりやすさ", "根拠不足時に回答を控える挙動", "競合・期限切れ・低信頼度メモリの警告", "過去の失敗パターンを事前に提示できるか", "失敗回避チェックリストの具体性", "tenant/project/権限境界の安全性", "MCP・認証・検索失敗時の復旧UX", "提案の簡潔さとコンテキスト消費量", "3回実行時の一貫性", "LocalとCloudflareの意味的な一致", "提案を採用した結果の記録・確認しやすさ"],
    scores: [85, 90, 90, 90, 90, 95, 90, 95, 95, 90, 90, 100, 80, 90, 100, null, 90]
  },
  {
    id: "console_personal", label: "管理画面・一人利用", weight: 0.15, evidence: ["UI-01", "UI-02"],
    labels: ["初回表示で製品状態を理解できるか", "ナビゲーションと情報設計", "Dashboardが示す次の行動", "メモリ検索と結果比較", "メモリ詳細・根拠・履歴の理解", "作成・改訂・抑制・復元のしやすさ", "Decision・Task・Memory間の移動", "Profileとクライアント接続管理", "空・読込中・部分取得・エラー状態", "操作数・スクロール量・移動距離", "モバイル・200%相当ズーム・横スクロール", "キーボード・フォーカス・VoiceOver・コントラスト", "信頼度・利用状況・影響範囲の説明", "個人利用に対する管理項目の過剰さ"],
    scores: [85, 85, 80, 85, 85, 85, 80, 85, 90, 85, 90, 75, 85, 85]
  },
  {
    id: "console_team", label: "管理画面・チーム利用", weight: 0.20, evidence: ["UI-01", "UI-02", "FX-01"],
    labels: ["Organization初期設定", "招待から初回ログインまで", "owner/admin/memberの役割理解", "ユーザー状態と権限変更", "グループ作成と所属管理", "tenant/projectスコープの現在地", "共有範囲とアクセス権の可視性", "所有者・登録元・根拠の追跡", "Decisionのレビューと責任所在", "Task・handoff・失敗の共有", "クライアント登録コードと資格情報のライフサイクル", "操作履歴・障害・停滞の発見", "複数ユーザー・グループから目的対象を探す効率", "危険操作の確認・取消・復旧", "空・部分取得・権限拒否・エラー状態", "モバイル・200%相当ズーム・横スクロール", "キーボード・VoiceOver・axeによるA/AAリスク", "日本語の用語統一と非技術ユーザーへの理解しやすさ", "一人利用時とのUI差分が適切か"],
    scores: [85, 85, 90, 90, 85, 90, 90, 85, 85, 80, 90, 85, 80, 85, 90, 90, 75, 80, 85]
  }
];

function category(definition) {
  const items = definition.labels.map((label, index) => {
    const score = definition.scores[index];
    return {
      id: `${definition.id}.${index + 1}`,
      label,
      score,
      verification: score === null ? "not_verified" : definition.id === "cloudflare_setup" ? "local_dry_run_only" : "local_checked",
      evidence: definition.evidence,
      evidence_constraint: score === null ? "監査環境でfreshな実操作を完遂できず推測採点しない" : undefined
    };
  });
  const measured = items.filter((item) => item.score !== null);
  const raw = measured.reduce((total, item) => total + item.score, 0) / measured.length;
  const coverage = measured.length / items.length;
  return {
    id: definition.id,
    label: definition.label,
    weight: definition.weight,
    score: Math.round(raw * 10) / 10,
    measured_items: measured.length,
    total_items: items.length,
    coverage: Math.round(coverage * 10_000) / 10_000,
    provisional: coverage < 0.9,
    items
  };
}

export function buildScorecard() {
  const categories = definitions.map(category);
  const score = categories.reduce((total, item) => total + item.score * item.weight, 0);
  const measuredItems = categories.reduce((total, item) => total + item.measured_items, 0);
  const totalItems = categories.reduce((total, item) => total + item.total_items, 0);
  return {
    audit: {
      date: "2026-08-22",
      state: "improved-state",
      basis: "fresh local implementation checks, synthetic fixtures, and Playwright mock-backed UI checks",
      cloud_live_verified: false,
      voiceover_manually_verified: false
    },
    categories,
    overall: {
      formula: "sum(category.score * category.weight)",
      score: Math.round(score * 10) / 10,
      coverage: Math.round((measuredItems / totalItems) * 10_000) / 10_000,
      provisional: true,
      completion_accepted: false,
      reason: "Cloudflare領域のcoverageが90%未満で、Managed OAuth・cloud hook・別ユーザー共有のlive実証が未完了。VoiceOverも未実査。",
      risk_overrides: [{ priority: "P0", finding: "新MCPホストと明示的Access policy IDが未提供のため、Remote MCPのlive OAuth境界は未検証。平均点で完了扱いしない。" }]
    }
  };
}

const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
  const output = resolve(process.argv[outputIndex + 1]);
  const scorecard = buildScorecard();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(scorecard, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, overall: scorecard.overall })}\n`);
}
