#!/usr/bin/env node
import { readFileSync } from "node:fs";

function usage() {
  console.error("Usage: node ./scripts/analyze-answer-failures.mjs <answer-failures.jsonl>");
}

function increment(map, key) {
  const normalized = key === undefined || key === null || key === "" ? "none" : String(key);
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function topEntries(map) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => ({ key, count }));
}

const path = process.argv[2];
if (!path) {
  usage();
  process.exit(1);
}

const entries = readFileSync(path, "utf8")
  .split(/\n+/u)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const byFailureKind = new Map();
const byCategory = new Map();
const byDeterministicReason = new Map();
const byAnswerTextHit = new Map();
const byCategoryAndKind = new Map();

for (const entry of entries) {
  const failureKind = entry.failure_kind ?? entry.answer_failure_kind ?? "unknown";
  const category = entry.category ?? "unknown";
  increment(byFailureKind, failureKind);
  increment(byCategory, category);
  increment(byDeterministicReason, entry.deterministic_reason ?? entry.answer_worksheet?.deterministic_reason ?? "none");
  increment(byAnswerTextHit, String(entry.answer_text_hit_at_5));
  increment(byCategoryAndKind, `${category}:${failureKind}`);
}

console.log(JSON.stringify({
  failure_count: entries.length,
  by_failure_kind: topEntries(byFailureKind),
  by_category: topEntries(byCategory),
  by_deterministic_reason: topEntries(byDeterministicReason),
  by_answer_text_hit_at_5: topEntries(byAnswerTextHit),
  by_category_and_failure_kind: topEntries(byCategoryAndKind)
}, null, 2));
