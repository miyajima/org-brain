// Synthetic repository-maintenance lessons from the published live-study fixtures.
// This replay measures retrieval, not the historical claims in those lessons.
import { readFile } from "node:fs/promises";

export const fixtureSource = "artifacts/memory-efficiency/2026-09-23/live-codex/manifest.json";
const manifest = JSON.parse(await readFile(new URL(`../../${fixtureSource}`, import.meta.url), "utf8"));
export const memories = manifest.tasks.flatMap((task) => task.lessons.map((lesson, index) => ({
  ...lesson, key: `${task.id}-${index}`
})));
memories.push({ key: "cloudflare", content: "Cloudflareのデプロイ後は、稼働中APIの応答を確認する。",
  summary: "デプロイ後の稼働確認", rationale: "ローカルでのビルド成功だけでは、稼働中の構成や応答の正しさを証明できない。",
  reuse_rule: "公開先が承認済みのプロジェクトと一致する場合だけ実施し、別のプロジェクトなら停止する。",
  source_references: [{ type: "file", ref: "scripts/memory-efficiency-evaluate.mjs" }] });
memories.push({ key: "sqlite", content: "Run SQLite diagnostics sequentially to avoid database lock errors.",
  summary: "Serialize SQLite diagnostics", rationale: "Concurrent writers contend on the same SQLite database.",
  reuse_rule: "Only serialize diagnostics sharing one local database; independent databases can run concurrently.",
  source_references: [{ type: "file", ref: "scripts/memory-efficiency-evaluate.mjs" }] });

export const positiveCases = [
  ...manifest.tasks.map((task) => ({ id: `${task.id}-original-full`, category: "original-full",
    query: task.question, expected: task.lessons.map((_, i) => `${task.id}-${i}`) })),
  ...manifest.tasks.map((task) => ({ id: `${task.id}-curated`, category: "curated",
    query: task.query, expected: task.lessons.map((_, i) => `${task.id}-${i}`) })),
  { id: "workspace-en", category: "natural", query: "Please investigate Git worktree workspace mapping in this repository and explain what to check.", expected: ["workspace-0", "workspace-1"] },
  { id: "usage-en", category: "natural", query: "Could you investigate memory usage history in this project and explain it?", expected: ["usage-0", "usage-1"] },
  { id: "capture-en", category: "natural", query: "Please investigate eager capture with opaque tool wrappers in this repository.", expected: ["capture-0"] },
  { id: "workspace-ja", category: "natural", query: "Git worktreeのworkspace mappingについて、このプロジェクトで調査して説明してください。", expected: ["workspace-0", "workspace-1"] },
  { id: "usage-ja", category: "natural", query: "memory usage historyについて、このリポジトリで確認して説明してください。", expected: ["usage-0", "usage-1"] },
  { id: "capture-ja", category: "natural", query: "eager captureとopaque tool wrappersについて調査してください。", expected: ["capture-0"] },
  { id: "cloudflare-curated", category: "curated", query: "Cloudflare デプロイ API 応答", expected: ["cloudflare"] },
  { id: "cloudflare-ja", category: "natural", query: "CloudflareのデプロイとAPIの応答について調査してください。", expected: ["cloudflare"] },
  { id: "sqlite-en", category: "natural", query: "Please investigate SQLite diagnostics and database lock errors in this repository.", expected: ["sqlite"] }
];

export const negativeCases = [
  { id: "unrelated", query: "Please investigate galactic bakery payroll reconciliation in this repository." },
  { id: "partial-topic", query: "Please investigate Git worktree payroll reconciliation in this repository." },
  { id: "multi-topic", query: "Please investigate Git worktree workspace mapping and galactic bakery payroll reconciliation." },
  { id: "japanese-partial", query: "Cloudflareのデプロイと給与計算について調査してください。" },
  { id: "unknown-identifier", query: "Please investigate SQLite diagnostics database lock ErrorXYZ732." },
  { id: "tenant-boundary", query: positiveCases[6].query, tenant_id: "other" },
  { id: "project-boundary", query: positiveCases[6].query, project_id: "other" },
  { id: "conflict", query: positiveCases[14].query, isolated: "conflict" },
  { id: "permissions", query: positiveCases[6].query, isolated: "permissions" },
  ...["suppressed", "future", "invalid", "expired"].map((state) => ({
    id: state, query: positiveCases[9].query, isolated: state
  }))
];

export async function seedRecallFixture(store, isolated = null) {
  const selected = isolated === "conflict" ? memories.filter((m) => m.key === "sqlite")
    : isolated ? memories.filter((m) => m.key.startsWith("workspace-")) : memories;
  const ids = new Map();
  for (const memory of selected) {
    const { key, ...fields } = memory;
    const saved = await store.capture({ ...fields, tenant_id: "recall", project_id: "fixture",
      kind: "pitfall", work_type: "implementation", source: "synthetic-query-fixture", external_key: key,
      confidence_score: 0.9, utility_score: 0.8,
      ...(isolated === "conflict" ? { conflicts: ["Procedure revoked pending investigation."] } : {}),
      ...(isolated === "permissions" ? { permissions: [{ principal_type: "principal", principal_id: "owner", permissions: ["read"] }] } : {}),
      ...(isolated === "suppressed" ? { lifecycle_state: "suppressed" } : {}),
      ...(isolated === "future" ? { valid_from: Date.now() + 86_400_000 } : {}),
      ...(isolated === "invalid" ? { valid_until: Date.now() - 86_400_000 } : {}),
      ...(isolated === "expired" ? { expires_at: Date.now() - 86_400_000 } : {}) });
    ids.set(saved.memory_id, key);
  }
  return ids;
}
