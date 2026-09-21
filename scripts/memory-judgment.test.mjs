import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryJudge, createOpenRouterMemoryTransport, redactJudgmentValue } from "../packages/shared/src/memory-judgment-runtime.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { TaskCommitmentStore } from "../packages/orgbrain-cli/src/lib/task-commitment-store.mjs";
import { createLocalMemoryJudge, openJudgmentDatabase, memoryJudgmentCandidate } from "../packages/orgbrain-cli/src/lib/local-memory-judge.mjs";
import { enqueueJudgmentCapture, drainJudgmentCapture, recoverJudgmentCapture } from "../packages/orgbrain-cli/src/lib/local-memory-judge-queue.mjs";

const candidate = { id: "one", text: "Use a 1200 ms timeout only in staging; never in production.", project_id: "p", version: 1, source_text: "User: Use a 1200 ms timeout only in staging; never in production.", reuse_rule: "staging only", conflicts: [], protected_reasons: [] };
function response(request, override = {}) {
  return { model: "typesafe/jev-1.13", usage: { input_tokens: 100, output_tokens: 10, cost: 0.001 }, answers: Object.fromEntries(Object.keys(request.questions).map((key) => {
    const axis = key.replace(/^c\d+_/u, "");
    return [key, { type: "noul", noul: override[key] ?? override[axis] ?? (["contradiction", "instruction_attack", "needs_verification"].includes(axis) ? 0.01 : 0.99) }];
  })) };
}
const input = (overrides = {}) => ({ stage: "use", context: { project_id: "p", use_context: { conditions: "staging" } }, candidates: [candidate], policy: { mode: "active" }, active_qualified: true, ...overrides });

test("off, unqualified active, empty and protected batches make no network calls", async () => {
  const judge = createMemoryJudge({ transport: () => { throw new Error("must not call"); } });
  assert.equal((await judge(input({ policy: { mode: "off" } }))).request_count, 0);
  assert.equal((await judge(input({ active_qualified: false }))).reason_code, "qualification_required");
  assert.equal((await judge(input({ candidates: [] }))).reason_code, "no_candidates");
  assert.equal((await judge(input({ candidates: [{ ...candidate, protected_reasons: ["constraint"] }] }))).decisions[0].action, "review");
});
test("one batch covers independent axes; cache survives threshold changes but not evidence, scope or version changes", async () => {
  let calls = 0;
  const judge = createMemoryJudge({ transport: async (request) => { calls++; assert.equal(Object.keys(request.questions).length, 6); return response(request); } });
  const first = await judge(input()); assert.equal(first.decisions[0].action, "retain");
  assert.equal(first.provider_cost, 0.001);
  const cached = await judge(input({ policy: { mode: "active", threshold: 0.98 } }));
  assert.equal(cached.cache_hit, true); assert.equal(cached.provider_cost, 0);
  for (const change of [{ version: 2 }, { text: "Use 120 ms only in development." }, { reuse_rule: "production only" }]) await judge(input({ candidates: [{ ...candidate, ...change }] }));
  await judge(input({ context: { project_id: "other" } }));
  assert.equal(calls, 5);
});
test("uncertainty and contradictory evidence stay visible; protected evidence is never offered for removal", async () => {
  const uncertain = createMemoryJudge({ transport: async (request) => response(request, { applicable: 0.5 }) });
  assert.equal((await uncertain(input())).decisions[0].action, "review");
  const contrary = createMemoryJudge({ transport: async (request) => response(request, { applicable: 0.01, contradiction: 0.99 }) });
  assert.equal((await contrary(input())).decisions[0].action, "review");
  const blocked = { ...candidate, id: "constraint", protected_reasons: ["constraint"] };
  const result = await contrary(input({ candidates: [candidate, blocked] }));
  assert.equal(result.decisions[1].action, "review");
});
test("malformed, out-of-range and failed replies restore original decisions without retries", async () => {
  for (const transport of [async () => ({}), async (r) => response(r, { grounded: 1.1 }), async () => { throw new Error("Bearer secret raw response"); }]) {
    const result = await createMemoryJudge({ transport })(input());
    assert.equal(result.applied, false); assert.equal(result.request_count, 1);
    assert.equal(result.decisions[0].action, "review"); assert.doesNotMatch(JSON.stringify(result), /secret raw/u);
  }
});
test("missing conditions require review and conflict preserves both sides", async () => {
  const uncertain = await createMemoryJudge({ transport: async (r) => response(r, { applicable: .01, needs_verification: .99 }) })(input());
  assert.equal(uncertain.decisions[0].action, "review");
  const result = await createMemoryJudge({ transport: async (r) => response(r, { c0_contradiction: .99, c1_applicable: .01 }) })(input({ candidates: [candidate, { ...candidate, id: "two", text: "a different version" }] }));
  assert.deepEqual(result.decisions.map((d) => d.action), ["review", "review"]);
});
test("timeout aborts once and retains the original candidate", async () => {
  let calls = 0, signal;
  const result = await createMemoryJudge({ transport: async (_request, options) => { calls++; signal = options.signal; return new Promise(() => {}); } })(input());
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
  assert.equal(result.reason_code, "timeout"); assert.equal(result.applied, false);
});
test("oversized packets preserve conditions and do not call or truncate", async () => {
  let called = false;
  const result = await createMemoryJudge({ transport: async () => { called = true; } })(input({ candidates: [{ ...candidate, text: "文".repeat(30_000) }] }));
  assert.equal(called, false); assert.equal(result.reason_code, "request_too_large");
});
test("outbound redaction keeps original values and meaning-bearing numeric units", async () => {
  const original = { ...candidate, text: `${candidate.text} api_key=sk-private123456789 user@example.org /Users/alice/private`, evidence: [{ secret: "value" }] };
  await createMemoryJudge({ transport: async (request) => {
    const wire = JSON.stringify(request); assert.doesNotMatch(wire, /sk-private|user@example|Users\/alice|"secret":"value"/u);
    assert.match(wire, /1200 ms/u); assert.match(wire, /never in production/u); return response(request);
  } })(input({ candidates: [original] }));
  assert.match(original.text, /sk-private/u);
  assert.equal(redactJudgmentValue("Bearer token-value"), "Bearer [REDACTED]");
  assert.equal(redactJudgmentValue("xoxb-synthetic-test xoxp-synthetic-test"), "[REDACTED_SECRET] [REDACTED_SECRET]");
});

test("protected corrections are visible to the remaining candidates' questions", async () => {
  await createMemoryJudge({ transport: async (request) => {
    assert.equal(request.state.protected_evidence[0].text, "Correction: production must not use this setting");
    assert.equal(request.state.candidates.length, 1);
    return response(request, { contradiction: .99 });
  } })(input({ candidates: [candidate, { ...candidate, id: "correction", text: "Correction: production must not use this setting", protected_reasons: ["user_correction"] }] }));
});

test("capture aliases preserve source and validity, and held jobs recover without provider retries", async () => {
  const record = { projectId: "p", content: "source evidence", sourceReferences: [{ ref: "fixture" }], validUntil: Date.now() + 60_000 };
  const canonical = memoryJudgmentCandidate(record, "a");
  assert.deepEqual(canonical.source_references, record.sourceReferences);
  assert.equal(canonical.valid_until, record.validUntil);
  await withStore(async (_store, dbPath) => {
    const job = await enqueueJudgmentCapture({ dbPath, tenantId: "default", projectId: "p", source: "test", records: [record], env: { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_CAPTURE_MODE: "active" } });
    await drainJudgmentCapture({ dbPath, projectId: "p", judge: async () => { throw new Error("crashed"); } });
    let saves = 0;
    const restored = await recoverJudgmentCapture({ dbPath, projectId: "p", id: job.id, capture: async (_s, _t, records) => { saves++; return records; } });
    assert.equal(restored.captured, 1); assert.equal(restored.request_count, 0); assert.equal(saves, 1);
    await assert.rejects(recoverJudgmentCapture({ dbPath, projectId: "p", id: job.id }), /held_job_required/u);
  });
});
test("transport uses Decisions endpoint and never retries HTTP errors", async () => {
  let calls = 0;
  const transport = createOpenRouterMemoryTransport({ apiKey: "test-only", fetcher: async (url, options) => {
    calls++; assert.equal(url, "https://openrouter.ai/api/alpha/decisions"); assert.equal(options.method, "POST"); return { ok: false };
  } });
  const result = await createMemoryJudge({ transport })(input());
  assert.equal(calls, 1); assert.equal(result.reason_code, "provider_unavailable");
});

async function withStore(fn, memoryJudge) {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-jev-test-"));
  const dbPath = join(directory, "memory.sqlite");
  const store = new LocalMemoryStore(dbPath, { memoryJudge, denseEmbeddingProvider: null, env: {} });
  try { await store.init(); await fn(store, dbPath); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function seed(store, key, content, extra = {}) {
  return store.capture({ tenant_id: "default", project_id: "p", kind: "fact", lifecycle_state: "active", scope_type: "project", scope_key: "p", content, summary: content,
    tags: [], entities: [], source: "test", source_references: [{ type: "file", ref: "fixture.txt" }], external_key: key,
    rationale: "Observed source", reuse_rule: "staging only", evidence: [{ type: "file", ref: "fixture.txt" }], conflicts: [], permissions: [], ...extra });
}
const query = { tenant_id: "default", project_id: "p", query: "timeout staging", top_k: 5, token_budget: 8000 };

test("local active filters both response surfaces and preserves full reuse conditions", async () => {
  await withStore(async (store) => {
    await seed(store, "keep", "timeout staging requires 1200 ms");
    await seed(store, "omit", "timeout staging OBSOLETE noisy output");
    const result = await store.retrieveContext(query);
    assert.equal(result.results.length, 1); assert.equal(result.evidence_bundle.evidence.length, 1);
    assert.doesNotMatch(JSON.stringify(result.results), /OBSOLETE/u);
    assert.match(result.evidence_bundle.evidence[0].text, /staging only/u);
  }, async ({ candidates }) => ({ mode: "active", applied: true, decisions: candidates.map((c) => ({ id: c.id, action: c.text.includes("OBSOLETE") ? "omit" : "retain", requires_review: false })) }));
});
test("local shadow leaves retrieval text unchanged, active rechecks revoked ACL after inference", async () => {
  await withStore(async (store) => {
    await seed(store, "one", "timeout staging source");
    const fixedQuery = { ...query, at: Date.now() };
    const baseline = await store.retrieveContext(fixedQuery);
    store.memoryJudge = async ({ candidates }) => ({ mode: "shadow", applied: false, decisions: candidates.map((c) => ({ id: c.id, action: "omit" })) });
    const shadow = await store.retrieveContext(fixedQuery);
    assert.deepEqual(shadow.results, baseline.results); assert.deepEqual(shadow.evidence_bundle, baseline.evidence_bundle);
    store.memoryJudge = async ({ candidates }) => {
      const db = store.open(); try { db.prepare("UPDATE memories SET permissions_json=? WHERE id=?").run(JSON.stringify([{ principal_id: "other", permissions: ["read"] }]), candidates[0].id); } finally { db.close(); }
      return { mode: "active", applied: true, decisions: candidates.map((c) => ({ id: c.id, action: "retain" })) };
    };
    const revoked = await store.retrieveContext({ ...query, principal_id: "local" });
    assert.equal(revoked.results.length, 0); assert.equal(revoked.meta.memory_judgment.reason_code, "source_changed");
  });
});
test("disk cache has no source text and serves another local judge instance", async () => {
  await withStore(async (_store, dbPath) => {
    let calls = 0;
    const options = { dbPath, env: { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_USE_MODE: "shadow" }, transport: async (r) => { calls++; return response(r); } };
    const request = { stage: "use", context: { project_id: "p" }, candidates: [candidate] };
    await createLocalMemoryJudge(options)(request);
    assert.equal((await createLocalMemoryJudge(options)(request)).cache_hit, true); assert.equal(calls, 1);
    assert.doesNotMatch((await readFile(`${dbPath}.jev.sqlite`)).toString(), /Use a 1200/u);
  });
});
test("capture queue never judges in Stop; shadow never persists again; failures restore baseline", async () => {
  await withStore(async (_store, dbPath) => {
    const records = [{ projectId: "p", content: "Reusable evidence", externalKey: "event", tags: [] }];
    let saves = 0;
    for (const mode of ["shadow", "active"]) {
      const env = { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_CAPTURE_MODE: mode };
      assert.equal((await enqueueJudgmentCapture({ dbPath, tenantId: "default", projectId: "p", source: "test", records, env })).queued, true);
      const result = await drainJudgmentCapture({ dbPath, projectId: "p", env,
        judge: async ({ candidates }) => ({ applied: false, status: "fallback", decisions: candidates.map((c) => ({ id: c.id, action: "review" })) }),
        capture: async (_source, _tenant, retained) => { saves++; assert.deepEqual(retained, records); return retained; } });
      assert.equal(result.processed, 1);
    }
    assert.equal(saves, 1);
    const db = await openJudgmentDatabase(dbPath); try { assert.equal(db.prepare("SELECT count(*) AS n FROM capture_queue WHERE status='completed'").get().n, 2); } finally { db.close(); }
  });
});

test("existing learning maintenance keeps omitted candidates quarantined and preserves consensus for retained candidates", async () => {
  await withStore(async (_store, dbPath) => {
    const store = new TaskCommitmentStore(dbPath);
    await store.saveLearningCandidates({ tenantId: "default", projectId: "p", candidates: [
      { external_key: "jev:omit", item: { content: "temporary" } }, { external_key: "jev:keep", item: { content: "durable" } }
    ] });
    let evaluations = 0, promotions = 0;
    const result = await store.maintainLearningCandidates({
      judgeBatch: async (rows) => ({ reports: [{ applied: true }], omitted: rows.filter((r) => r.external_key === "jev:omit").map((r) => r.id) }),
      evaluate: async () => { evaluations++; return { route: "active", verified: false, consensus_pass: false }; },
      promote: async () => { promotions++; return { ok: true }; }
    });
    assert.equal(evaluations, 1); assert.equal(promotions, 0); assert.equal(result.promoted, 0);
    const db = store.open();
    try { assert.equal(db.prepare("SELECT status FROM memory_learning_candidates WHERE external_key='jev:omit'").get().status, "quarantine"); }
    finally { db.close(); }
  });
});
