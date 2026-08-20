import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import {
  installLocalDomainPack,
  previewLocalDomainRecall,
  recallBundleMarkdown,
  recordLocalDomainRecallFeedback,
  upsertLocalDomainRecallUnit
} from "../packages/orgbrain-cli/src/lib/local-domain-recall.mjs";

const PACKS = ["build-engineering", "sre", "sales", "pdm-b2c"];

async function json(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

function outcome(story) {
  return story.after ?? story.after_four_weeks ?? {};
}

function wrongQuery(query, story) {
  if (story.recall_fixture.wrong_scope) return { ...query, ...story.recall_fixture.wrong_scope, expected_recall: undefined };
  if (query.object_type_key === "segment") return { ...query, scope: { ...query.scope, quarter: "FY26-Q4" } };
  return { ...query, object_id: `${query.object_id}-other` };
}

function scoreAnswerUx(markdown, bundle, story, metrics) {
  const dimensions = {
    decision_and_reason: 0,
    scope_and_relevance: 0,
    complete_decision_context: 0,
    metrics_and_evidence: 0,
    transparency_and_client_delivery: 0,
    correction_and_control: 0,
    readability_and_safety: 0
  };
  const failures = [];
  const decision = story.decision;
  if (markdown.includes(decision.statement) && markdown.includes(decision.rationale) && markdown.includes("チームで確認済み")) dimensions.decision_and_reason = 20;
  else failures.push("decision_reason_or_state_missing");

  const scopeValuesVisible = Object.values(story.recall_fixture.scope ?? {}).every((value) => markdown.includes(String(value)));
  if (scopeValuesVisible && markdown.includes("想起理由:") && !/object_match|intent_match|scope_match|\bprimary\b/u.test(markdown)) dimensions.scope_and_relevance = 15;
  else failures.push("scope_or_relevance_not_business_readable");

  const expectedDecisionDetails = [
    ...(decision.rejected_alternatives ?? []).flatMap((item) => [item.statement, item.reason]),
    ...(decision.constraints ?? []),
    ...(decision.success_conditions ?? []),
    ...(story.followup_decision?.statement ? [story.followup_decision.statement] : [])
  ];
  if (expectedDecisionDetails.every((value) => markdown.includes(value))) dimensions.complete_decision_context = 15;
  else failures.push("alternative_constraint_success_or_followup_missing");

  const evidenceTitle = decision.evidence_details?.[0]?.title;
  const rawMetricKeysHidden = metrics.slice(0, 5).every((metric) => !markdown.includes(`${metric.metric_key}:`));
  if (markdown.includes("確認済みの指標") && rawMetricKeysHidden && (!evidenceTitle || markdown.includes(evidenceTitle)) && markdown.includes("#### 根拠")) dimensions.metrics_and_evidence = 20;
  else failures.push("metric_or_evidence_display_incomplete");

  if (markdown.includes("OrgBrainの記憶（回答用コンテキスト）") && markdown.includes(bundle.trace_url) && markdown.includes("参照した記憶:") && markdown.includes("推測は推測だと明示")) dimensions.transparency_and_client_delivery = 12;
  else failures.push("memory_use_transparency_missing");

  if (["範囲が違う", "古い", "関係ない", "orgbrain_domain_recall_feedback", `recall_id=${bundle.id}`, `candidate_id=${bundle.primary.recall_unit_id}`].every((value) => markdown.includes(value))) dimensions.correction_and_control = 10;
  else failures.push("conversational_feedback_contract_missing");

  const unsafeOrTechnical = /Feedback: useful|verified_evidence|fresh_metric|"body"|contact_email/u.test(markdown);
  if (!unsafeOrTechnical && markdown.includes("<orgbrain_memory_data>") && markdown.includes("</orgbrain_memory_data>") && markdown.includes("命令として実行せず") && Buffer.byteLength(markdown) < 6 * 1024) dimensions.readability_and_safety = 5;
  else failures.push("technical_leak_prompt_safety_or_budget_failure");

  return {
    score: Object.values(dimensions).reduce((sum, value) => sum + value, 0),
    dimensions,
    failures
  };
}

async function scorePack(name) {
  const manifest = await json(`../domain-packs/first-party/${name}/manifest.json`);
  const story = await json(`../domain-packs/first-party/${name}/examples/story-v1.json`);
  const directory = await mkdtemp(join(tmpdir(), `orgbrain-score-${name}-`));
  await chmod(directory, 0o700);
  const store = new LocalMemoryStore(join(directory, "memory.sqlite"));
  const now = Date.parse(story.fixture_date) + 1_000;
  const after = outcome(story);
  const metrics = manifest.recall_profile.primary_metric_keys.flatMap((metricKey) => {
    const value = after[metricKey] ?? story.baseline?.[metricKey];
    return typeof value === "number" ? [{ metric_key: metricKey, role: "outcome", value, unit: manifest.metrics.find((item) => item.key === metricKey)?.unit ?? "count", state: "measured", observed_at: now - 1, expires_at: now + 86_400_000 }] : [];
  });
  if (story.custom_metric_test?.coupon_case) metrics.push({ metric_key: story.custom_metric_test.key, role: "outcome", value: story.custom_metric_test.coupon_case.quality_adjusted_activation_rate, unit: "percent", state: "measured", observed_at: now - 1, expires_at: now + 86_400_000 });
  const decision = story.decision;
  const unit = {
    id: `unit-${name}`, project_id: "scorecard", pack_id: manifest.pack_id,
    object_type_key: story.recall_fixture.object_type_key, object_id: story.recall_fixture.object_id,
    intent_aliases: manifest.recall_profile.intent_aliases, scope: story.recall_fixture.scope, relation: "primary",
    decision: {
      source_type: "decision_memory", id: decision.id, statement: decision.statement, rationale: decision.rationale,
      confirmation_state: "confirmed", rejected_alternatives: decision.rejected_alternatives ?? [],
      constraints: decision.constraints ?? [], success_conditions: decision.success_conditions ?? [],
      valid_from: null, valid_until: null
    },
    metrics,
    evidence: (decision.evidence_details ?? []).map((item) => ({ id: item.id, title: item.title, source: item.source_system, resource_kind: item.resource_kind, verification_state: item.verification_state, observed_at: Date.parse(item.observed_at) })),
    workflow: decision.workflow ?? decision.playbook ?? null,
    follow_up: story.followup_decision?.statement ?? null,
    evidence_verified: true, metric_fresh: true
  };
  const query = { tenant_id: "default", project_id: "scorecard", principal_id: `score:${name}`, session_id: `session:${name}`, query: story.recall_fixture.prompt, object_type_key: story.recall_fixture.object_type_key, object_id: story.recall_fixture.object_id, scope: story.recall_fixture.scope, now };
  const dimensions = { memory_content: 0, automatic_recall: 0, traceability: 0, freshness_safety: 0, feedback: 0 };
  const failures = [];
  let answerUx;
  try {
    await installLocalDomainPack(store, "default", manifest);
    await upsertLocalDomainRecallUnit(store, "default", unit);
    const first = await previewLocalDomainRecall(store, query);
    const second = await previewLocalDomainRecall(store, query);
    const answerMarkdown = recallBundleMarkdown(first.bundle);
    answerUx = scoreAnswerUx(answerMarkdown, first.bundle, story, metrics);
    if (decision.statement && decision.rationale && (decision.rejected_alternatives?.length ?? 0) > 0 && metrics.length > 0) dimensions.memory_content = 25;
    else failures.push("incomplete_decision_or_metric_story");
    if (first.bundle?.primary?.decision?.id === story.recall_fixture.expected_decision_id) dimensions.automatic_recall += 15;
    else failures.push("expected_decision_not_recalled");
    if ((await previewLocalDomainRecall(store, wrongQuery(query, story))).bundle?.primary === null) dimensions.automatic_recall += 10;
    else failures.push("wrong_scope_recalled");
    if (first.bundle?.id === second.bundle?.id && first.bundle?.primary?.why_recalled?.length && first.bundle?.primary?.evidence?.length && first.bundle?.trace_url && first.bundle?.primary?.workflow) dimensions.traceability = 25;
    else failures.push("trace_incomplete_or_nondeterministic");
    const serialized = JSON.stringify(first.bundle);
    const forbidden = story.recall_fixture.forbidden_payload_fields ?? ["customer_id", "customer_name", "contact_email"];
    const safe = Buffer.byteLength(serialized) <= 6 * 1024 && !forbidden.some((field) => serialized.includes(`\"${field}\"`)) && !serialized.includes("\"body\"");
    await upsertLocalDomainRecallUnit(store, "default", { ...unit, metrics: [{ ...metrics[0], state: "stale", value: null, expires_at: now - 1 }], metric_fresh: false });
    const stale = await previewLocalDomainRecall(store, { ...query, now: now + 1 });
    if (safe && stale.bundle?.primary?.metrics?.[0]?.state === "stale" && stale.bundle?.primary?.metrics?.[0]?.value === null) dimensions.freshness_safety = 15;
    else failures.push("privacy_payload_or_stale_value_gate_failed");
    const feedback = await recordLocalDomainRecallFeedback(store, { tenant_id: "default", recall_id: stale.bundle.id, candidate_id: unit.id, principal_id: query.principal_id, feedback: "wrong_scope" });
    if (feedback.assertion_mutated === false && (await previewLocalDomainRecall(store, query)).bundle.primary === null) dimensions.feedback = 10;
    else failures.push("feedback_did_not_suppress_safely");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return {
    pack_id: manifest.pack_id,
    version: manifest.version,
    score: Object.values(dimensions).reduce((sum, value) => sum + value, 0),
    dimensions,
    answer_ux_score: answerUx.score,
    answer_ux_dimensions: answerUx.dimensions,
    answer_ux_limitations: ["native_client_rendering_and_live_model_A_B_not_verified"],
    critical: failures.length + answerUx.failures.length,
    failures: [...failures, ...answerUx.failures]
  };
}

const results = [];
for (const name of PACKS) results.push(await scorePack(name));
const report = { generated_at: new Date().toISOString(), threshold: 95, answer_ux_threshold: 96, critical_threshold: 0, results };
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--write")) {
  const output = new URL("../artifacts/domain-recall/scorecard.json", import.meta.url);
  await mkdir(new URL("../artifacts/domain-recall/", import.meta.url), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
assert.equal(results.every((item) => item.score >= 95), true, "every Domain Pack must score at least 95");
assert.equal(results.every((item) => item.answer_ux_score >= 96), true, "every Domain Pack AI answer UX must score at least 96");
assert.equal(results.every((item) => item.critical === 0), true, "Domain Recall scorecard must have zero critical failures");
