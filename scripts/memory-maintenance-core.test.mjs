import assert from "node:assert/strict";
import test from "node:test";
import { planMemoryMaintenance } from "./lib/memory-maintenance-core.mjs";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 30, 12, 0, 0);

function hookRow(index, overrides = {}) {
  return {
    id: `mem_${index}`,
    project_id: "proj",
    source: "codex",
    kind: "semantic",
    summary: `Root cause: stale cache in pkg${index}. Fix: run \`pnpm test --filter pkg${index}\` and it succeeded`,
    content: `Root cause: stale cache in pkg${index}. Fix: run \`pnpm test --filter pkg${index}\` and it succeeded`,
    tags_json: JSON.stringify(["hook"]),
    created_at: NOW - 10 * DAY + index * 1000,
    ...overrides
  };
}

test("a digest group is emitted once it reaches the minimum size", () => {
  const plan = planMemoryMaintenance([1, 2, 3, 4].map((i) => hookRow(i)), { now: NOW });
  assert.equal(plan.digests.length, 1);
  assert.equal(plan.stats.digested_memory_count, 4);
});

test("a digest group below DIGEST_GROUP_MIN is not emitted", () => {
  const plan = planMemoryMaintenance([1, 2, 3].map((i) => hookRow(i)), { now: NOW });
  assert.equal(plan.digests.length, 0);
  assert.equal(plan.compactions.length, 0);
});

test("a low-signal row is not digested or counted", () => {
  const rows = [1, 2, 3].map((i) => hookRow(i));
  rows.push(hookRow(4, { tags_json: JSON.stringify(["hook", "message"]) }));
  const plan = planMemoryMaintenance(rows, { now: NOW });
  assert.equal(plan.stats.scanned_count, 3);
  assert.equal(plan.digests.length, 0);
  assert.ok(!plan.compactions.some((item) => item.id === "mem_4"));
});

test("a route=inline row is low-signal even when it mentions a fix", () => {
  const routeText = (i) => `route=inline/current-agent root cause stale cache in pkg${i}, fix run \`pnpm test --filter pkg${i}\` and it succeeded`;
  const rows = [1, 2, 3].map((i) => hookRow(i));
  rows.push(hookRow(4, { summary: routeText(4), content: routeText(4) }));
  const plan = planMemoryMaintenance(rows, { now: NOW });
  assert.equal(plan.stats.scanned_count, 3);
  assert.equal(plan.digests.length, 0);
});

test("episodic rows are not digested", () => {
  const rows = [1, 2, 3, 4].map((i) => hookRow(i, { kind: "episodic" }));
  const plan = planMemoryMaintenance(rows, { now: NOW });
  assert.equal(plan.digests.length, 0);
});

test("custom digest and duplicate cutoffs are honored", () => {
  const rows = [1, 2, 3, 4].map((i) => hookRow(i, { created_at: NOW - 10 * DAY + i * 1000 }));
  assert.equal(planMemoryMaintenance(rows, { now: NOW, digestOlderThanDays: 11 }).digests.length, 0);
  assert.equal(planMemoryMaintenance(rows, { now: NOW, digestOlderThanDays: 9 }).digests.length, 1);

  const dupes = [1, 2].map((i) => hookRow(i, { summary: "Root cause: stale cache. Fix: run `pnpm test` and it succeeded", content: "Root cause: stale cache. Fix: run `pnpm test` and it succeeded", created_at: NOW - 20 * DAY + i * 1000, tags_json: "[]" }));
  assert.equal(planMemoryMaintenance(dupes, { now: NOW, duplicateOlderThanDays: 21 }).compactions.length, 0);
  const plan = planMemoryMaintenance(dupes, { now: NOW, duplicateOlderThanDays: 14 });
  assert.equal(plan.stats.duplicate_compaction_count, 1);
});
