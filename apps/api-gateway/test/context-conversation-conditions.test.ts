import { expect, it, vi } from "vitest";
import { memoryD1Fixture } from "./fixtures/memory-d1";
import { retrieveMemoryContext } from "../src/memory-context-service";
import { captureMemoryItems, reviseMemory } from "../src/memory-lifecycle-service";
import { searchMemories } from "../src/memory-search-service";

vi.mock("../src/memory-search-service", () => ({
  searchMemories: vi.fn(),
  bestEffortMarkMemoryResultsAccessed: vi.fn()
}));

const originalBody = "Use the fixture cache policy.";
const correctedBody = "Use the corrected fixture cache policy.";
const rationale = "The policy was reviewed for the fixture environment.";
const reuseRule = "Never use production inputs.";

async function setup(sqlFixture: ReturnType<typeof memoryD1Fixture>, condition = reuseRule) {
  const { env, sql } = sqlFixture;
  const content = `${originalBody}\n理由: ${rationale}\n再利用条件: ${condition}`;
  const captured = await captureMemoryItems(env, {
    tenantId: "fixture",
    source: "conversation-event",
    items: [{
      external_key: "conversation-condition",
      project_id: "project-a",
      kind: "semantic",
      content,
      rationale,
      reuse_rule: condition,
      learning: { conversation_provenance: { evidence_status: "supplied_unverified" } },
      confidence_score: 0.9,
      source_references: [{ type: "conversation", ref: "synthetic:conversation" }]
    }]
  });
  const id = captured.items[0].memory_id;
  const revise = (text: string) => reviseMemory(env, { tenantId: "fixture", memoryId: id, content: text });
  const read = (version: number, taskQuery = false, budget = 3000) => {
    vi.mocked(searchMemories).mockResolvedValueOnce({
      tenant_id: "fixture", project_id: "project-a", q: "cache policy",
      results: [{
        kind: "memory", id, score: 0.9, current_version: version, content_preview: "cache policy",
        created_at: 1, source_references: [{ ref: "synthetic:conversation" }], conflicts: [],
        score_breakdown: { lexical: 1 }
      }],
      meta: {
        returned_count: 1, top_result_ids: [id], top_result_ranks: [0.9],
        retrieval: { generation_id: null, degraded_reasons: [] },
        ...(taskQuery ? { task_query: { applied: true, coverage: "covered" } } : {})
      }
    } as never);
    return retrieveMemoryContext(env, {
      tenant_id: "fixture", project_id: "project-a", q: "cache policy", token_budget: budget
    });
  };
  const storedCondition = () => sql.prepare("SELECT reuse_rule FROM memories WHERE id=?").get(id)?.reuse_rule;
  return { content, read, revise, storedCondition };
}

it.each([
  { taskQuery: false, shadow: false },
  { taskQuery: true, shadow: false },
  { taskQuery: false, shadow: true },
  { taskQuery: true, shadow: true }
])("delivers the corrected body with saved conditions (task query: $taskQuery, shadow: $shadow)", async ({ taskQuery, shadow }) => {
  const fixture = memoryD1Fixture();
  if (shadow) fixture.env.EVIDENCE_DISPOSITION_MODE = "shadow";
  try {
    const { read, revise, storedCondition } = await setup(fixture);
    await revise(correctedBody);
    expect(storedCondition()).toBe(reuseRule);
    const response = await read(2, taskQuery);
    expect(response.evidence_bundle.evidence).toHaveLength(1);
    const evidence = response.evidence_bundle.evidence[0];
    expect(evidence.text).toContain(correctedBody);
    expect(evidence.text).toContain(rationale);
    expect(evidence.text).toContain(reuseRule);
    expect(evidence.text).not.toContain(originalBody);
    expect(evidence).not.toHaveProperty("evidence_basis", "human_confirmed_memory");
    expect(response.meta.usage_items?.[0]?.source_version).toBe(2);
  } finally {
    fixture.sql.close();
  }
});

it("keeps the body unchanged when it already includes the stored reason and condition", async () => {
  const fixture = memoryD1Fixture();
  try {
    const { content, read } = await setup(fixture);
    const response = await read(1, true);
    expect(response.evidence_bundle.evidence[0]?.text).toBe(content);
  } finally {
    fixture.sql.close();
  }
});

it("adds the saved condition when the revised body merely quotes it", async () => {
  const fixture = memoryD1Fixture();
  try {
    const { read, revise } = await setup(fixture);
    const body = `${correctedBody} The old body said "${reuseRule}"`;
    await revise(body);
    const response = await read(2);
    expect(response.evidence_bundle.evidence[0]?.text).toContain(`\nReuse or avoid: ${reuseRule}`);
  } finally {
    fixture.sql.close();
  }
});

it("omits the whole evidence item when its reuse condition cannot fit", async () => {
  const fixture = memoryD1Fixture();
  try {
    const condition = "異常を検知したら停止し、担当者と安全条件を再確認する。".repeat(26) + "最後に本番では使わないこと。";
    const { read, revise } = await setup(fixture, condition);
    await revise(correctedBody);
    const small = await read(2, false, 512);
    expect(small.evidence_bundle.evidence).toEqual([]);
    expect(small.meta.usage_items).toEqual([]);
    const large = await read(2);
    expect(large.evidence_bundle.evidence[0]?.text).toContain(condition);
  } finally {
    fixture.sql.close();
  }
});
