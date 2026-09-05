import assert from "node:assert/strict";
import test from "node:test";
import {
  isSanitizedMemoryExtractionReviewText,
  sanitizeMemoryExtractionReviewText
} from "../packages/shared/src/memory-extraction-review-text-runtime.mjs";

test("removes Japanese-adjacent filenames and single-component private paths", () => {
  const sanitized = sanitizeMemoryExtractionReviewText([
    "Dockerfileを更新し、.envを確認してconfig.tsを修正しました。",
    "~/secret と C:\\secret は参照しません。",
    "/rules 画面の改善は完了しました。"
  ].join("\n"));
  for (const secret of ["Dockerfile", ".env", "config.ts", "~/secret", "C:\\secret"]) {
    assert.equal(sanitized.includes(secret), false, secret);
  }
  assert.match(sanitized, /\/rules 画面/u);
  assert.equal(isSanitizedMemoryExtractionReviewText(sanitized), true);
});

test("removes citation tags, markdown file links, and code fences idempotently", () => {
  const sanitized = sanitizeMemoryExtractionReviewText([
    "<proposed_plan>",
    "[秘密設定](<docs/My File/config> \"internal\")は使いません。",
    "```text",
    "SQLiteを採用しました。",
    "```",
    "</proposed_plan>",
    "<oai-mem-citation><citation_entries>MEMORY.md:1-2</citation_entries></oai-mem-citation>"
  ].join("\n"));
  assert.equal(sanitized, "既存資料は使いません。\n\nSQLiteを採用しました。");
  assert.equal(sanitizeMemoryExtractionReviewText(sanitized), sanitized);
});
