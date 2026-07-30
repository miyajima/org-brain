import { performance } from "node:perf_hooks";

const CATEGORY_COUNT = 20;
const PERSONAL_CATEGORIES = ["coding", "preference", "staleness", "contradiction", "temporal"];
const ORGANIZATION_CATEGORIES = ["decision", "permission", "cross_tenant", "evidence", "policy"];
const PERSONAL_SCORE_WEIGHTS = {
  search_quality: 30,
  setup_and_daily_ux: 20,
  privacy_and_offline: 15,
  automatic_extraction: 15,
  latency_and_context: 10,
  interoperability: 10
};
const ORGANIZATION_SCORE_WEIGHTS = {
  security_and_governance: 25,
  search_and_update_quality: 20,
  availability_and_recovery: 15,
  decision_and_collaboration: 15,
  integration_ease: 10,
  operability: 10,
  cost: 5
};

function token(prefix, index) {
  return `${prefix}${String(index + 1).padStart(3, "0")}`;
}

function baseRecord(task, id, content, overrides = {}) {
  return {
    id,
    tenant_id: task.tenant_id,
    project_id: task.project_id,
    kind: "fact",
    lifecycle_state: "active",
    scope_type: "project",
    scope_key: task.project_id,
    content,
    summary: content,
    tags: [task.category],
    entities: [],
    source: "competitive-benchmark",
    source_references: [{ type: "benchmark", ref: task.id }],
    external_key: `${task.id}:${id}`,
    actor_type: "benchmark",
    actor_id: "dataset",
    valid_from: null,
    valid_until: null,
    confidence_score: 0.9,
    utility_score: 0.9,
    rationale: null,
    evidence: [],
    conflicts: [],
    permissions: [],
    ...overrides
  };
}

function personalTask(category, index) {
  const marker = token(`p${category}`, index);
  const task = {
    id: `personal-${category}-${index + 1}`,
    mode: "personal",
    category,
    dataset_family: index % 2 === 0 ? "longmemeval_style" : "locomo_style",
    tenant_id: `personal-${index + 1}`,
    project_id: "personal-memory",
    principal_id: `user:personal-${index + 1}`,
    query: `${marker} durable answer`,
    expected_ids: [`${marker}-expected`],
    forbidden_ids: [],
    memories: []
  };
  const expected = baseRecord(
    task,
    `${marker}-expected`,
    `${marker} durable answer is value-${index + 1}.`
  );
  const distractor = baseRecord(
    task,
    `${marker}-distractor`,
    `${marker} historical draft did not contain the durable answer.`
  );

  if (category === "coding") {
    expected.kind = "constraint";
    expected.content = `${marker} durable answer: run backend validation with TZ=UTC-${index + 1}.`;
    expected.summary = expected.content;
  } else if (category === "preference") {
    expected.kind = "preference";
    expected.content = `${marker} durable answer: prefer compact output style ${index + 1}.`;
    expected.summary = expected.content;
  } else if (category === "staleness") {
    distractor.content = `${marker} durable answer was obsolete-value-${index + 1}.`;
    distractor.summary = distractor.content;
    distractor.valid_until = 1_700_000_000_000;
  } else if (category === "contradiction") {
    expected.kind = "decision";
    expected.conflicts = [`${marker}-distractor`];
    distractor.kind = "decision";
    distractor.lifecycle_state = "suppressed";
  } else if (category === "temporal") {
    distractor.valid_from = 4_102_444_800_000;
    distractor.content = `${marker} durable answer becomes future-value-${index + 1}.`;
    distractor.summary = distractor.content;
  }
  task.memories = [
    distractor,
    expected,
    baseRecord(task, `${marker}-noise`, `Unrelated note ${index + 1} about another topic.`)
  ];
  return task;
}

function organizationTask(category, index) {
  const marker = token(`o${category}`, index);
  const task = {
    id: `organization-${category}-${index + 1}`,
    mode: "organization",
    category,
    dataset_family: "state_bench_style",
    tenant_id: `org-${index + 1}`,
    project_id: "organization-memory",
    principal_id: `user:member-${index + 1}`,
    query: `${marker} governed answer`,
    expected_ids: [`${marker}-expected`],
    forbidden_ids: [],
    memories: []
  };
  const expected = baseRecord(
    task,
    `${marker}-expected`,
    `${marker} governed answer is approved-value-${index + 1}.`,
    {
      kind: category === "policy" ? "constraint" : "decision",
      rationale: `Approved because benchmark evidence ${index + 1} is authoritative.`,
      evidence: [{ type: "benchmark", ref: `${task.id}:evidence` }]
    }
  );
  const distractor = baseRecord(
    task,
    `${marker}-distractor`,
    `${marker} governed answer is an unapproved draft.`
  );

  if (category === "permission") {
    expected.permissions = [{
      principal_type: "principal",
      principal_id: task.principal_id,
      permissions: ["read"]
    }];
    distractor.permissions = [{
      principal_type: "principal",
      principal_id: "user:other",
      permissions: ["read"]
    }];
    task.forbidden_ids.push(distractor.id);
  } else if (category === "cross_tenant") {
    const foreign = baseRecord(
      task,
      `${marker}-foreign`,
      `${marker} governed answer contains foreign-secret-${index + 1}.`,
      { tenant_id: `foreign-${index + 1}` }
    );
    task.forbidden_ids.push(foreign.id);
    task.memories.push(foreign);
  } else if (category === "evidence") {
    expected.source_references = [
      { type: "document", ref: `docs/evidence-${index + 1}.md` },
      { type: "task", ref: `task-${index + 1}` }
    ];
  } else if (category === "policy") {
    expected.tags.push("policy");
    expected.content = `${marker} governed answer: deployment requires approval gate ${index + 1}.`;
    expected.summary = expected.content;
  }

  task.memories.push(
    distractor,
    expected,
    baseRecord(task, `${marker}-noise`, `Unrelated organization note ${index + 1}.`)
  );
  return task;
}

export function buildCompetitiveTasks() {
  const tasks = [];
  for (const category of PERSONAL_CATEGORIES) {
    for (let index = 0; index < CATEGORY_COUNT; index += 1) tasks.push(personalTask(category, index));
  }
  for (const category of ORGANIZATION_CATEGORIES) {
    for (let index = 0; index < CATEGORY_COUNT; index += 1) tasks.push(organizationTask(category, index));
  }
  return tasks;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function estimateTokens(results) {
  return results.reduce(
    (sum, result) => sum + Math.ceil(JSON.stringify(result.memory ?? result).length / 4),
    0
  );
}

function hasProvenance(result) {
  const memory = result?.memory ?? result;
  return Array.isArray(memory?.source_references) && memory.source_references.length > 0;
}

function normalizeSearchResponse(response, adapterName) {
  if (Array.isArray(response)) {
    return {
      results: response,
      usage: {
        turns: 1,
        cost_usd: adapterName.startsWith("orgbrain-local") ? 0 : null
      }
    };
  }
  const results = Array.isArray(response?.results) ? response.results : [];
  const turns = Number(response?.usage?.turns);
  const cost = Number(response?.usage?.cost_usd);
  return {
    results,
    usage: {
      turns: Number.isFinite(turns) && turns > 0 ? turns : 1,
      cost_usd: Number.isFinite(cost) && cost >= 0 ? cost : null
    }
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function categoryCompletion(taskResults, categories) {
  const selected = taskResults.filter((task) => categories.includes(task.category));
  if (selected.length === 0) return null;
  return Number((
    selected.filter((task) => task.attempts[0].task_completed).length /
    selected.length *
    100
  ).toFixed(2));
}

function scorecard(weights, components) {
  const entries = Object.entries(weights).map(([name, weight]) => {
    const component = components[name];
    const rawScore = typeof component === "object" && component !== null
      ? component.score
      : component;
    const evidence =
      typeof component === "object" && component !== null &&
      Array.isArray(component.evidence)
        ? component.evidence.filter((item) => typeof item === "string" && item.trim().length > 0)
        : [];
    const score = Number.isFinite(rawScore) && evidence.length > 0
      ? Math.max(0, Math.min(100, Number(rawScore)))
      : null;
    return {
      name,
      weight,
      score,
      evidence
    };
  });
  const measured = entries.filter((entry) => Number.isFinite(entry.score));
  const measuredWeight = measured.reduce((sum, entry) => sum + entry.weight, 0);
  const weightedPoints = measured.reduce(
    (sum, entry) => sum + entry.weight * entry.score / 100,
    0
  );
  return {
    components: Object.fromEntries(entries.map((entry) => [
      entry.name,
      { weight: entry.weight, score: entry.score, evidence: entry.evidence }
    ])),
    measured_weight: measuredWeight,
    partial_weighted_score: Number(weightedPoints.toFixed(2)),
    weighted_score: measuredWeight === 100 ? Number(weightedPoints.toFixed(2)) : null,
    ranking_eligible: measuredWeight === 100,
    missing_components: entries.filter((entry) => entry.score === null).map((entry) => entry.name)
  };
}

export async function runCompetitiveBenchmark(adapter, tasks = buildCompetitiveTasks(), options = {}) {
  const repeat = Math.max(1, Number(options.repeat ?? 5));
  const harness = options.harness ?? {};
  const capabilities = typeof adapter.describe === "function"
    ? await adapter.describe()
    : {};
  await adapter.reset();
  for (const task of tasks) {
    for (const memory of task.memories) await adapter.capture(memory);
  }

  const taskResults = [];
  const latencies = [];
  let contextTokens = 0;
  let top1Hits = 0;
  let recallAt5Hits = 0;
  let pass5 = 0;
  let leakageCount = 0;
  let decisionGradeCount = 0;
  let provenanceCount = 0;
  let totalTurns = 0;
  let totalCostUsd = 0;
  let costSamples = 0;
  let unknownCostSamples = 0;

  for (const task of tasks) {
    const attempts = [];
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      const started = performance.now();
      const searchResponse = normalizeSearchResponse(await adapter.search({
        tenant_id: task.tenant_id,
        project_id: task.project_id,
        principal_id: task.principal_id,
        query: task.query,
        limit: 5,
        at: Date.now()
      }), adapter.name);
      const latencyMs = performance.now() - started;
      const { results, usage } = searchResponse;
      latencies.push(latencyMs);
      if (attempt === 0) contextTokens += estimateTokens(results);
      const ids = results.map((result) => (result.memory ?? result).id);
      const top1 = task.expected_ids.includes(ids[0]);
      const recallAt5 = task.expected_ids.some((id) => ids.includes(id));
      const leaked = task.forbidden_ids.some((id) => ids.includes(id));
      const taskCompleted = top1 && !leaked;
      totalTurns += usage.turns;
      if (usage.cost_usd === null) {
        unknownCostSamples += 1;
      } else {
        totalCostUsd += usage.cost_usd;
        costSamples += 1;
      }
      attempts.push({
        top1,
        recall_at_5: recallAt5,
        leaked,
        task_completed: taskCompleted,
        provenance: hasProvenance(results[0]),
        ids,
        turns: usage.turns,
        cost_usd: usage.cost_usd,
        latency_ms: latencyMs
      });
    }
    const first = attempts[0];
    if (first.top1) top1Hits += 1;
    if (first.recall_at_5) recallAt5Hits += 1;
    if (first.leaked) leakageCount += 1;
    if (attempts.every((attempt) => attempt.top1 && !attempt.leaked)) pass5 += 1;

    if (["decision", "evidence", "policy"].includes(task.category)) {
      decisionGradeCount += 1;
      if (first.provenance) provenanceCount += 1;
    }
    taskResults.push({
      id: task.id,
      mode: task.mode,
      category: task.category,
      dataset_family: task.dataset_family,
      attempts
    });
  }

  const count = tasks.length;
  const personal = taskResults.filter((result) => result.mode === "personal");
  const organization = taskResults.filter((result) => result.mode === "organization");
  const summarizeSubset = (items) => ({
    tasks: items.length,
    accuracy: items.length
      ? Number((items.filter((item) => item.attempts[0].top1).length / items.length * 100).toFixed(2))
      : 0,
    recall_at_5: items.length
      ? Number((items.filter((item) => item.attempts[0].recall_at_5).length / items.length * 100).toFixed(2))
      : 0,
    pass_5: items.length
      ? Number((items.filter((item) => item.attempts.every((attempt) => attempt.top1 && !attempt.leaked)).length / items.length * 100).toFixed(2))
      : 0,
    task_completion_rate: items.length
      ? Number((items.filter((item) => item.attempts[0].task_completed).length / items.length * 100).toFixed(2))
      : 0,
    average_turns: items.length
      ? Number(average(items.map((item) => item.attempts[0].turns)).toFixed(2))
      : 0,
    average_cost_usd: items.length &&
      items.every((item) => item.attempts[0].cost_usd !== null)
      ? Number(average(items.map((item) => item.attempts[0].cost_usd)).toFixed(8))
      : null
  });
  const overallAccuracy = Number((top1Hits / count * 100).toFixed(2));
  const overallRecall = Number((recallAt5Hits / count * 100).toFixed(2));
  const p95Latency = Number(percentile(latencies, 95).toFixed(2));
  const averageContextTokens = Number((contextTokens / count).toFixed(2));
  const taskCompletionRate = Number((
    taskResults.filter((item) => item.attempts[0].task_completed).length /
    count *
    100
  ).toFixed(2));
  const personalSummary = summarizeSubset(personal);
  const organizationSummary = summarizeSubset(organization);
  const personalScorecard = scorecard(PERSONAL_SCORE_WEIGHTS, {
    ...(capabilities?.personal ?? {}),
    search_quality: {
      score: Number(((personalSummary.accuracy + personalSummary.recall_at_5) / 2).toFixed(2)),
      evidence: ["competitive-memory-v1 personal accuracy and recall@5"]
    },
    latency_and_context: {
      score:
        p95Latency <= COMPETITIVE_ACCEPTANCE_TARGETS.maximum_local_100k_p95_ms &&
        averageContextTokens <= COMPETITIVE_ACCEPTANCE_TARGETS.maximum_average_context_tokens
          ? 100
          : 0,
      evidence: ["competitive-memory-v1 measured p95 latency and average context"]
    }
  });
  const organizationScorecard = scorecard(ORGANIZATION_SCORE_WEIGHTS, {
    ...(capabilities?.organization ?? {}),
    security_and_governance: {
      score: leakageCount === 0
        ? categoryCompletion(taskResults, ["permission", "cross_tenant"])
        : 0,
      evidence: ["competitive-memory-v1 permission and cross-tenant leakage tasks"]
    },
    search_and_update_quality: {
      score: Number((
        organizationSummary.accuracy + organizationSummary.recall_at_5
      ) / 2),
      evidence: ["competitive-memory-v1 organization accuracy and recall@5"]
    },
    decision_and_collaboration: {
      score: Number(average([
        categoryCompletion(taskResults, ["decision", "evidence", "policy"]) ?? 0,
        decisionGradeCount ? provenanceCount / decisionGradeCount * 100 : 0
      ]).toFixed(2)),
      evidence: ["competitive-memory-v1 decision, evidence, policy, and provenance tasks"]
    },
    cost: {
      score: unknownCostSamples === 0 && costSamples > 0 && totalCostUsd === 0 ? 100 : null,
      evidence: unknownCostSamples === 0 ? ["adapter-reported benchmark cost"] : []
    }
  });

  return {
    adapter: adapter.name,
    generated_at: new Date().toISOString(),
    settings: {
      repeat,
      task_turn_definition: "one adapter search interaction; pass^5 repeats are independent trials",
      cost_definition: "adapter-reported search cost in USD; local offline retrieval is zero",
      result_limit: 5,
      task_count: count,
      personal_task_count: personal.length,
      organization_task_count: organization.length,
      dataset_version: "competitive-memory-v1",
      harness
    },
    metrics: {
      accuracy: overallAccuracy,
      recall_at_5: overallRecall,
      pass_5: Number((pass5 / count * 100).toFixed(2)),
      task_completion_rate: taskCompletionRate,
      average_turns: Number((totalTurns / (count * repeat)).toFixed(2)),
      total_cost_usd: unknownCostSamples === 0 ? Number(totalCostUsd.toFixed(8)) : null,
      average_cost_per_attempt_usd: unknownCostSamples === 0
        ? Number((totalCostUsd / costSamples).toFixed(8))
        : null,
      cost_samples: costSamples,
      unknown_cost_samples: unknownCostSamples,
      cross_tenant_or_permission_leakage_count: leakageCount,
      decision_grade_provenance_rate: decisionGradeCount
        ? Number((provenanceCount / decisionGradeCount * 100).toFixed(2))
        : 0,
      average_context_tokens: averageContextTokens,
      search_latency_p50_ms: Number(percentile(latencies, 50).toFixed(2)),
      search_latency_p95_ms: p95Latency
    },
    personal: personalSummary,
    organization: organizationSummary,
    scorecards: {
      personal: personalScorecard,
      organization: organizationScorecard
    },
    capability_evidence: capabilities ?? {},
    ranking: {
      eligible: personalScorecard.ranking_eligible && organizationScorecard.ranking_eligible,
      first_place_claim_allowed: false,
      reason: personalScorecard.ranking_eligible && organizationScorecard.ranking_eligible
        ? "same-harness competitor results are required before ranking"
        : "one or more weighted dimensions are unmeasured"
    },
    categories: Object.fromEntries(
      [...new Set(taskResults.map((result) => result.category))].map((category) => [
        category,
        summarizeSubset(taskResults.filter((result) => result.category === category))
      ])
    ),
    task_results: taskResults
  };
}

export const COMPETITIVE_ACCEPTANCE_TARGETS = {
  minimum_tasks_per_mode: 100,
  minimum_accuracy: 97.22,
  minimum_recall_at_5: 91.67,
  maximum_average_context_tokens: 713.25,
  maximum_local_100k_p95_ms: 500,
  maximum_cross_tenant_leakage_count: 0,
  minimum_decision_grade_provenance_rate: 100
};

const REQUIRED_ADAPTERS = [
  "orgbrain-local",
  "supermemory",
  "gbrain",
  "cognee",
  "mem0",
  "mempalace",
  "agentmemory"
];
const CRITICAL_COMPONENTS = {
  personal: ["search_quality", "privacy_and_offline", "automatic_extraction"],
  organization: [
    "security_and_governance",
    "search_and_update_quality",
    "availability_and_recovery",
    "decision_and_collaboration"
  ]
};

export function evaluateCompetitiveRanking(results, unavailable = [], harness = {}) {
  const byAdapter = new Map(results.map((result) => [result.adapter, result]));
  const blockers = [];
  for (const adapter of REQUIRED_ADAPTERS) {
    if (!byAdapter.has(adapter)) blockers.push(`missing adapter result: ${adapter}`);
  }
  for (const item of unavailable) blockers.push(`${item.adapter}: ${item.reason}`);
  for (const field of ["model_id", "budget_usd", "hardware_id"]) {
    if (harness[field] === null || harness[field] === undefined || harness[field] === "") {
      blockers.push(`same-harness declaration missing: ${field}`);
    }
  }
  for (const result of results) {
    for (const field of ["model_id", "budget_usd", "hardware_id"]) {
      if (result.settings?.harness?.[field] !== harness[field]) {
        blockers.push(`${result.adapter} harness mismatch: ${field}`);
      }
    }
    for (const mode of ["personal", "organization"]) {
      if (!result.scorecards?.[mode]?.ranking_eligible) {
        blockers.push(`${result.adapter} ${mode} scorecard is incomplete`);
      }
    }
  }
  const orgbrain = byAdapter.get("orgbrain-local");
  const competitors = REQUIRED_ADAPTERS
    .filter((adapter) => adapter !== "orgbrain-local")
    .map((adapter) => byAdapter.get(adapter))
    .filter(Boolean);
  const modeWins = {};
  if (orgbrain && competitors.length === REQUIRED_ADAPTERS.length - 1) {
    for (const mode of ["personal", "organization"]) {
      const ownScore = orgbrain.scorecards?.[mode]?.weighted_score;
      const competitorScores = competitors.map((result) => result.scorecards?.[mode]?.weighted_score);
      modeWins[mode] =
        Number.isFinite(ownScore) &&
        competitorScores.every(Number.isFinite) &&
        ownScore > Math.max(...competitorScores);
      if (!modeWins[mode]) blockers.push(`orgbrain-local is not the strict ${mode} weighted-score leader`);
      for (const component of CRITICAL_COMPONENTS[mode]) {
        const ownComponent = orgbrain.scorecards?.[mode]?.components?.[component]?.score;
        const competitorComponents = competitors.map(
          (result) => result.scorecards?.[mode]?.components?.[component]?.score
        );
        if (
          !Number.isFinite(ownComponent) ||
          !competitorComponents.every(Number.isFinite) ||
          ownComponent < Math.max(...competitorComponents)
        ) {
          blockers.push(`orgbrain-local trails or lacks critical ${mode}.${component}`);
        }
      }
    }
  }
  const uniqueBlockers = [...new Set(blockers)];
  return {
    eligible: uniqueBlockers.length === 0,
    first_place_claim_allowed: uniqueBlockers.length === 0,
    required_adapters: REQUIRED_ADAPTERS,
    mode_wins: modeWins,
    blockers: uniqueBlockers
  };
}
