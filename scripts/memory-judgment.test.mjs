import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryJudge, createOpenRouterMemoryTransport, redactJudgmentValue } from "../packages/shared/src/memory-judgment-runtime.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { TaskCommitmentStore } from "../packages/orgbrain-cli/src/lib/task-commitment-store.mjs";
import { createLocalMemoryJudge, createLearningCandidateJudge, openJudgmentDatabase, memoryJudgmentCandidate } from "../packages/orgbrain-cli/src/lib/local-memory-judge.mjs";
import { enqueueJudgmentCapture, drainJudgmentCapture, recoverJudgmentCapture } from "../packages/orgbrain-cli/src/lib/local-memory-judge-queue.mjs";

const candidate = { id: "one", text: "Use a 1200 ms timeout only in staging; never in production.", project_id: "p", version: 1, source_text: "User: Use a 1200 ms timeout only in staging; never in production.", reuse_rule: "staging only", conflicts: [], protected_reasons: [] };
function response(request, override = {}) {
  return { model: "typesafe/jev-1.13", usage: { input_tokens: 100, output_tokens: 10, cost: 0.001 }, answers: Object.fromEntries(Object.keys(request.questions).map((key) => {
    const axis = key.replace(/^c\d+_/u, "");
    return [key, { type: "noul", noul: override[key] ?? override[axis] ?? (["contradiction", "instruction_attack", "needs_verification"].includes(axis) ? 0.01 : 0.99) }];
  })) };
}
// Contract fixtures, not a semantic model or evidence of Japanese accuracy.
function assessmentResponse(request, override = {}) {
  const result = response(request, override);
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === "choice") result.answers[key] = {
      type: "choice", choice: "success", confidence: 0.99,
      probabilities: { decision: 0.005, success: 0.99, failure: 0.003, unknown: 0.002 }
    };
    if (question.type === "score") result.answers[key] = {
      type: "score", score: 2.99, confidence: 0.99,
      probabilities: { "0": 0, "1": 0, "2": 0.01, "3": 0.99 }
    };
  }
  return result;
}
const input = (overrides = {}) => ({ stage: "use", context: { project_id: "p", use_context: { conditions: "staging" } }, candidates: [candidate], policy: { mode: "active" }, active_qualified: true, ...overrides });
const assessmentInput = (overrides = {}) => input({ stage: "capture",
  policy: { mode: "shadow", capture_assessment_mode: "shadow" }, ...overrides });

test("capture accepts independently rounded API probabilities and score, but rejects larger errors", async () => {
  for (const [score, probabilities, accepted] of [
    [2.07, { "0": 0, "1": 0, "2": .92, "3": .08 }, true],
    [2.07, { "0": .01, "1": .01, "2": .88, "3": .10 }, true],
    [2.20, { "0": 0, "1": 0, "2": .92, "3": .08 }, false],
    [2.07, { "0": 0, "1": 0, "2": .82, "3": .08 }, false]
  ]) {
    const result = await createMemoryJudge({ transport: async (request) => {
      const raw = assessmentResponse(request);
      raw.answers.c0_lesson_type.probabilities = { decision: .01, success: .98, failure: .01, unknown: .01 };
      raw.answers.c0_utility = { type: "score", score, probabilities, confidence: .92 };
      return raw;
    } })(assessmentInput());
    assert.equal(result.reason_code === "invalid_response", !accepted);
    if (accepted) assert.equal(result.decisions[0].capture_assessment.utility.score, score);
  }
});

test("capture assessment requires explicit shadow opt-in and cannot alter active/use requests", async () => {
  const judge = createMemoryJudge({ transport: async (r) => {
    assert.equal(Object.keys(r.questions).length, 6);
    return response(r);
  } });
  for (const request of [input(), assessmentInput({ policy: { mode: "shadow" } }),
    assessmentInput({ policy: { mode: "active", capture_assessment_mode: "shadow" } }),
    assessmentInput({ stage: "use" })]) {
    const result = await judge(request);
    assert.equal(result.status, "judged");
    assert.equal(result.capture_assessment_mode, "off");
    assert.equal(result.decisions[0].capture_assessment, undefined);
  }
  assert.equal((await judge(assessmentInput({ policy: { mode: "off", capture_assessment_mode: "shadow" } }))).request_count, 0);
});

test("one capture request batches selection, lesson classification and utility without changing labels or actions", async () => {
  const source = { ...candidate, lesson_type: "decision", text: "検証した手順を次回の障害調査で再利用する。" };
  const before = structuredClone(source);
  let calls = 0;
  const result = await createMemoryJudge({ transport: async (request) => {
    calls++;
    assert.equal(Object.keys(request.questions).length, 8);
    assert.equal(request.questions.c0_lesson_type.type, "choice");
    assert.deepEqual(Object.keys(request.questions.c0_lesson_type.criteria), ["decision", "success", "failure", "unknown"]);
    assert.equal(request.questions.c0_utility.type, "score");
    for (const question of Object.values(request.questions)) assert.match(question.instructions, /state\.candidates\[0\]/u);
    return assessmentResponse(request);
  } })(assessmentInput({ candidates: [source] }));
  assert.equal(calls, 1);
  assert.equal(result.applied, false);
  assert.equal(result.decisions[0].action, "retain");
  const assessment = result.decisions[0].capture_assessment;
  assert.equal(assessment.basis, "prediction");
  assert.equal(assessment.applied, false);
  assert.equal(assessment.classification.effective_label, "success");
  assert.equal(assessment.classification.matches_existing, false);
  assert.equal(assessment.utility.value, 2.99);
  assert.deepEqual(assessment.registration.reason_codes, ["lesson_type_disagreement"]);
  assert.deepEqual(source, before);
});

test("uncertain classification/utility stay unknown, while low confident utility only suggests review", async () => {
  for (const uncertain of [true, false]) {
    const result = await createMemoryJudge({ transport: async (r) => {
      const raw = assessmentResponse(r);
      raw.answers.c0_lesson_type.confidence = uncertain ? .5 : .99;
      raw.answers.c0_utility = { type: "score", score: 0, confidence: uncertain ? .5 : .99,
        probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 } };
      return raw;
    } })(assessmentInput());
    const assessment = result.decisions[0].capture_assessment;
    assert.equal(assessment.classification.effective_label, uncertain ? "unknown" : "success");
    assert.equal(assessment.utility.value, uncertain ? null : 0);
    assert.equal(assessment.registration.action, "review");
    assert.equal(result.decisions[0].action, "retain");
  }
});

test("high utility cannot override missing evidence, contradiction, non-durability or protected memory", async () => {
  for (const [axis, score, action] of [["grounded", .2, "review"], ["contradiction", .99, "review"],
    ["durable", .01, "omit"], ["incremental", .01, "omit"], ["instruction_attack", .99, "omit"]]) {
    const result = await createMemoryJudge({ transport: async (r) => assessmentResponse(r, { [axis]: score }) })(assessmentInput());
    assert.equal(result.decisions[0].capture_assessment.registration.action, action);
    assert.equal(result.applied, false);
  }
  const protectedMemory = { ...candidate, id: "protected", protected_reasons: ["explicit_save"] };
  const result = await createMemoryJudge({ transport: async (r) => {
    assert.equal(r.state.candidates.length, 1);
    return assessmentResponse(r, { contradiction: .99 });
  } })(assessmentInput({ candidates: [candidate, protectedMemory] }));
  assert.equal(result.decisions[0].capture_assessment.registration.action, "review");
  assert.equal(result.decisions[1].action, "review");
  assert.equal(result.decisions[1].capture_assessment, undefined);
});

test("capture cache isolates the new question set, reuses thresholds, and invalidates changed evidence", async () => {
  let calls = 0;
  const judge = createMemoryJudge({ transport: async (r) => { calls++; return assessmentResponse(r); } });
  await judge(assessmentInput({ policy: { mode: "shadow" } }));
  await judge(assessmentInput());
  const cached = await judge(assessmentInput({ policy: { mode: "shadow", capture_assessment_mode: "shadow", threshold: .98 } }));
  assert.equal(calls, 2);
  assert.equal(cached.cache_hit, true);
  assert.equal(cached.provider_cost, 0);
  assert.equal(cached.decisions[0].capture_assessment.registration.action, "retain");
  await judge(assessmentInput({ candidates: [{ ...candidate, source_text: "Changed evidence" }] }));
  assert.equal(calls, 3);
});

test("invalid mixed-type replies fail closed without caching or leaking extra provider fields", async () => {
  const mutations = [
    (r) => { delete r.answers.c0_lesson_type; },
    (r) => { r.answers.c0_lesson_type.choice = "evidence"; },
    (r) => { r.answers.c0_lesson_type.choice = "failure"; },
    (r) => { r.answers.c0_lesson_type.probabilities.success = .2; },
    (r) => { r.answers.c0_lesson_type.probabilities.extra = 0; },
    (r) => { r.answers.c0_lesson_type.confidence = NaN; },
    (r) => { r.answers.c0_utility.type = "noul"; },
    (r) => { r.answers.c0_utility.score = 4; },
    (r) => { r.answers.c0_utility.score = 1; },
    (r) => { r.answers.c0_utility.probabilities["3"] = Infinity; },
    (r) => { r.answers.c0_utility.confidence = -1; }
  ];
  for (const mutate of mutations) {
    const cache = new Map();
    const result = await createMemoryJudge({ cache, transport: async (r) => {
      const raw = assessmentResponse(r); mutate(raw); return raw;
    } })(assessmentInput());
    assert.equal(result.status, "fallback");
    assert.equal(result.reason_code, "invalid_response");
    assert.equal(result.applied, false);
    assert.equal(result.decisions[0].capture_assessment, undefined);
    assert.equal(cache.size, 0);
  }
  const cache = new Map();
  const result = await createMemoryJudge({ cache, transport: async (r) => {
    const raw = assessmentResponse(r);
    raw.answers.c0_lesson_type.reason = "untrusted provider explanation";
    raw.answers.c0_utility.legend = { "0": "untrusted provider explanation" };
    return raw;
  } })(assessmentInput());
  assert.equal(result.status, "judged");
  assert.doesNotMatch(JSON.stringify([result, [...cache.values()]]), /untrusted provider explanation/u);
});

test("exact duplicate assessment preserves the local omission recommendation", async () => {
  const result = await createMemoryJudge({ transport: async (r) => {
    assert.equal(Object.keys(r.questions).length, 8);
    return assessmentResponse(r);
  } })(assessmentInput({ candidates: [candidate, { ...candidate, id: "two" }] }));
  assert.equal(result.decisions[1].capture_assessment.registration.action, "omit");
  assert.deepEqual(result.decisions[1].capture_assessment.registration.reason_codes, ["exact_duplicate"]);
});

test("independent capture classifications remain attached to their own candidate including unknown", async () => {
  const labels = ["decision", "success", "failure", "unknown"];
  const texts = ["利用条件を確認して採用した方針", "同じ入力で成功を検証した手順", "失敗原因と回避条件を整理した教訓", "参考資料のURLだけ"];
  const result = await createMemoryJudge({ transport: async (r) => {
    assert.equal(Object.keys(r.questions).length, 32);
    const raw = assessmentResponse(r);
    labels.forEach((label, index) => {
      raw.answers[`c${index}_lesson_type`] = { type: "choice", choice: label, confidence: 1,
        probabilities: Object.fromEntries(labels.map((option) => [option, option === label ? 1 : 0])) };
    });
    return raw;
  } })(assessmentInput({ candidates: texts.map((text, index) => ({ ...candidate, id: `item-${index}`, text })) }));
  assert.equal(result.request_count, 1);
  assert.deepEqual(result.decisions.map((d) => d.capture_assessment.classification.effective_label), labels);
  assert.deepEqual(result.decisions.map((d) => d.capture_assessment.registration.action), ["retain", "retain", "retain", "review"]);
});

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
test("local capture assessment preserves lesson evidence, caches across instances and logs predictions only", async () => {
  const learning = { lesson_type: "success", procedure: "検証済みの再起動手順", observed_outcome: "同じ条件で再実行が成功した",
    why_it_worked: "一時状態を解消した", arbitrary_private_field: "must-not-be-copied" };
  const canonical = memoryJudgmentCandidate({ id: "fixture-id", kind: "fact", content: "次回も同じ条件で適用する。",
    learning_json: JSON.stringify(learning) }, "fixture-id", { includeCaptureAssessment: true });
  const baselineCandidate = memoryJudgmentCandidate({ id: "fixture-id", learning });
  assert.equal(baselineCandidate.lesson_type, undefined);
  assert.equal(baselineCandidate.lesson_context, undefined);
  assert.equal(canonical.lesson_type, "success");
  assert.equal(canonical.lesson_context.procedure, learning.procedure);
  assert.equal(canonical.lesson_context.observed_outcome, learning.observed_outcome);
  assert.equal(canonical.lesson_context.arbitrary_private_field, undefined);
  assert.equal(memoryJudgmentCandidate({ kind: "pitfall", learning_json: "invalid" }).protected_reasons.includes("unresolved_failure"), true);
  await withStore(async (_store, dbPath) => {
    let calls = 0;
    const options = { dbPath, env: { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_CAPTURE_MODE: "shadow",
      ORGBRAIN_JEV_CAPTURE_ASSESSMENT_MODE: "shadow" }, transport: async (r) => {
      calls++;
      assert.equal(r.state.candidates[0].lesson_context.procedure, learning.procedure);
      return assessmentResponse(r);
    } };
    const request = { stage: "capture", context: { project_id: "p" }, candidates: [canonical] };
    const first = await createLocalMemoryJudge(options)(request);
    assert.equal(first.decisions[0].capture_assessment.classification.matches_existing, true);
    assert.equal(first.decisions[0].capture_assessment.registration.action, "retain");
    assert.equal((await createLocalMemoryJudge(options)(request)).cache_hit, true);
    assert.equal(calls, 1);
    const traces = (await readFile(`${dbPath}.jev-metrics.jsonl`, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(traces[0].decisions[0].capture_assessment.utility.value, 2.99);
    assert.equal(traces[0].decisions[0].capture_assessment.basis, "prediction");
    assert.equal(traces[1].request_count, 0);
    assert.equal(traces[0].telemetry_version, "memory-judgment-telemetry/v2");
    assert.ok(Number.isFinite(traces[0].recorded_at));
    assert.notEqual(traces[0].event_id, traces[1].event_id);
    assert.match(traces[0].project_hash, /^[a-f0-9]{64}$/);
    assert.match(traces[0].policy_hash, /^[a-f0-9]{64}$/);
    assert.equal(traces[0].decisions[0].candidate_snapshot_hash, traces[1].decisions[0].candidate_snapshot_hash);
    for (const text of [JSON.stringify(traces), (await readFile(`${dbPath}.jev.sqlite`)).toString()]) {
      assert.doesNotMatch(text, /検証済みの再起動手順|同じ条件で再実行が成功した|fixture-id|must-not-be-copied/u);
    }
    const denied = await createLocalMemoryJudge(options)({ ...request, context: { project_id: "other" } });
    assert.equal(denied.request_count, 0);
    assert.equal(denied.capture_assessment_mode, "off");
  });
});

test("shadow queue stores assessment report without changing or saving the original record", async () => {
  await withStore(async (_store, dbPath) => {
    const env = { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_CAPTURE_MODE: "shadow", ORGBRAIN_JEV_CAPTURE_ASSESSMENT_MODE: "shadow" };
    const records = [{ projectId: "p", content: "再利用する手順", kind: "fact", externalKey: "assessment-only",
      learning: { lesson_type: "success", procedure: "原因を確認して設定を修正する", observed_outcome: "再実行で検証した" } }];
    const before = structuredClone(records);
    const queued = await enqueueJudgmentCapture({ dbPath, tenantId: "default", projectId: "p", source: "test", records, env });
    const judge = createLocalMemoryJudge({ dbPath, env, transport: async (r) => assessmentResponse(r, { durable: .01 }) });
    let saves = 0;
    const result = await drainJudgmentCapture({ dbPath, projectId: "p", env, judge, capture: async () => { saves++; return []; } });
    assert.equal(result.processed, 1);
    assert.equal(saves, 0);
    assert.equal(result.captured, 0);
    assert.equal(result.judgments[0].decisions[0].capture_assessment.registration.action, "omit");
    assert.deepEqual(records, before);
    const db = await openJudgmentDatabase(dbPath);
    try {
      const job = db.prepare("SELECT records_json, judgment_json FROM capture_queue WHERE id=?").get(queued.id);
      assert.deepEqual(JSON.parse(job.records_json), before);
      assert.equal(JSON.parse(job.judgment_json).decisions[0].capture_assessment.applied, false);
    } finally { db.close(); }
  });
});
test("learning maintenance carries opt-in assessment data but never omits or relabels in shadow", async () => {
  await withStore(async (_store, dbPath) => {
    const rows = [{ id: "learning-row", project_id: "p", expires_at: Date.now() + 60_000,
      payload_json: JSON.stringify({ item: { content: "再利用する手順", kind: "fact" },
        learning: { lesson_type: "success", procedure: "失敗しない手順を検証した", observed_outcome: "再実行が成功した" } }) }];
    const before = structuredClone(rows);
    const judge = createLearningCandidateJudge({ dbPath,
      env: { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_CAPTURE_MODE: "shadow", ORGBRAIN_JEV_CAPTURE_ASSESSMENT_MODE: "shadow" },
      transport: async (r) => {
        assert.equal(r.state.candidates[0].lesson_type, "success");
        assert.equal(r.state.candidates[0].lesson_context.observed_outcome, "再実行が成功した");
        return assessmentResponse(r, { durable: .01 });
      } });
    const result = await judge(rows, "default");
    assert.equal(result.reports[0].status, "judged");
    assert.equal(result.reports[0].decisions[0].capture_assessment.registration.action, "omit");
    assert.deepEqual(result.omitted, []);
    assert.deepEqual(rows, before);
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
