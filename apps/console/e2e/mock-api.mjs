import http from "node:http";
import fs from "node:fs";
import pathModule from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = new Map(
  process.argv.slice(2).flatMap((arg, index, all) => (arg.startsWith("--") ? [[arg.slice(2), all[index + 1]]] : []))
);
const port = Number(args.get("port") ?? process.env.CONSOLE_E2E_API_PORT ?? 19087);
const qualityRunDir = args.get("quality-run-dir") ?? process.env.QUALITY_RUN_DIR ?? "";
const now = Date.UTC(2026, 5, 12, 9, 0, 0);

function loadPrivateQualityRun(runDir) {
  if (!runDir) return null;
  const resolved = pathModule.resolve(runDir);
  const marker = JSON.parse(fs.readFileSync(pathModule.join(resolved, "bundle-marker.json"), "utf8"));
  if (marker.kind !== "orgbrain-memory-quality-private-run" || marker.run_id !== pathModule.basename(resolved)) {
    throw new Error("invalid private quality run marker");
  }
  const report = JSON.parse(fs.readFileSync(pathModule.join(resolved, "report.json"), "utf8"));
  const db = new DatabaseSync(pathModule.join(resolved, "quality.sqlite"), { readOnly: true });
  const dimensions = db.prepare("SELECT axis, numerator, denominator, point_estimate, wilson_lower, hard_violation_count FROM quality_dimensions ORDER BY axis").all();
  const cases = db.prepare("SELECT case_hash, session_hash, project_hash, split, capture_route, expected_route, actual_route, reason_codes_json, hard_violation_count, parity_mismatch FROM quality_cases ORDER BY case_hash").all().map((item) => ({
    ...item,
    lesson_type: null,
    reason_codes: JSON.parse(item.reason_codes_json),
    reason_codes_json: undefined,
    parity_mismatch: item.parity_mismatch === 1
  }));
  db.close();
  const run = {
    id: report.run_id,
    corpus_id: report.ground_truth_basis,
    status: report.status,
    input_source: report.input_source,
    capture_routes: [...new Set(cases.map((item) => item.capture_route))],
    hard_violation_count: dimensions.reduce((sum, item) => sum + Number(item.hard_violation_count), 0),
    started_at: fs.statSync(pathModule.join(resolved, "report.json")).mtimeMs,
    completed_at: fs.statSync(pathModule.join(resolved, "report.json")).mtimeMs,
    counts: report.counts,
    privacy: report.privacy,
    insufficiency_reason: report.insufficiency_reason
  };
  return { run, dimensions: dimensions.map((item) => ({ ...item, cohort: "all" })), cases };
}

const privateQualityRun = loadPrivateQualityRun(qualityRunDir);

const memory = {
  id: "mem_auth_group_acl",
  project_id: "org-brain",
  content: "Login principals and group ACLs decide who can read shared organization memory.",
  summary: "Login principal group ACL design",
  tags: ["auth", "groups", "canonical-memory"],
  source: "e2e",
  external_key: "e2e-login-memory",
  created_at: now,
  kind: "semantic",
  lifecycle_state: "active",
  current_version: 3,
  last_accessed_at: now,
  confidence_score: 0.93,
  utility_score: 0.88
};

const profileItem = {
  id: memory.id,
  project_id: memory.project_id,
  summary: memory.summary,
  content_preview: memory.content,
  source: memory.source,
  created_at: memory.created_at,
  tags: memory.tags,
  memory_kind: memory.kind,
  lifecycle_state: memory.lifecycle_state,
  current_version: memory.current_version,
  last_accessed_at: memory.last_accessed_at,
  confidence_score: memory.confidence_score,
  utility_score: memory.utility_score
};

const traceFixtureProjects = new Set([
  "org-brain",
  "e2e-failure-trace",
  "e2e-missing-trace",
  "e2e-trace-error"
]);

function traceNode(projectId, kind, values = {}) {
  const isDecision = kind === "decision";
  const memoryId = values.memory_id ?? `mem-${projectId}-trace`;
  const decisionId = values.decision_id ?? `rationale-${projectId}`;
  return {
    id: isDecision ? `decision:${decisionId}` : `memory:${memoryId}`,
    node_type: kind,
    memory_id: isDecision ? memoryId : memoryId,
    decision_id: isDecision ? decisionId : null,
    related_memory_id: isDecision ? memoryId : null,
    label: values.label ?? (isDecision ? "Decision trace" : "Trace memory"),
    summary: values.summary ?? values.label ?? "Trace memory",
    project_id: projectId,
    owner_principal: "user:e2e-login-sub",
    created_by_principal: "user:e2e-login-sub",
    reference_count: 3,
    consumer_count: 1,
    used_count: 1,
    utilization_rate: 0.5,
    net_saved_tokens: 120,
    injected_tokens: 40,
    updated_at: now,
    decision_type: isDecision ? values.decision_type ?? "decision" : null,
    confirmation_state: isDecision ? "confirmed" : null,
    confidence_score: 0.95
  };
}

function traceMapFor(projectId) {
  if (!traceFixtureProjects.has(projectId)) projectId = "org-brain";
  const isFailure = projectId === "e2e-failure-trace";
  const isMissing = projectId === "e2e-missing-trace";
  const memoryId = `mem-${projectId}-trace`;
  const rationaleId = isFailure ? "rationale-failure-e2e" : isMissing ? "rationale-missing-e2e" : "rationale-e2e";
  const memoryLabel = isFailure ? "Retry import prevention" : isMissing ? "Incomplete trace fixture" : "Canonical API endpoint decision";
  const projectNode = {
    id: `project:${projectId}`,
    node_type: "project",
    memory_id: null,
    label: projectId,
    summary: projectId,
    project_id: projectId,
    owner_principal: null,
    created_by_principal: null,
    reference_count: 1,
    consumer_count: 0,
    used_count: 0,
    utilization_rate: null,
    net_saved_tokens: 0,
    injected_tokens: 0,
    member_count: 2,
    updated_at: now
  };
  const memoryNode = traceNode(projectId, "memory", { memory_id: memoryId, label: memoryLabel, summary: memoryLabel });
  const decisionNode = traceNode(projectId, "decision", {
    memory_id: memoryId,
    decision_id: rationaleId,
    label: memoryLabel,
    summary: memoryLabel,
    decision_type: isFailure ? "failure_prevention" : "decision"
  });
  return {
    contract_version: "dashboard/v1",
    scope: "org",
    cluster_mode: false,
    total_count: 3,
    visible_count: 3,
    memory_visible_count: 1,
    project_count: 1,
    decision_count: 1,
    related_count: 1,
    relationship_count: 2,
    cross_project_link_count: 0,
    truncated: false,
    nodes: [projectNode, memoryNode, decisionNode],
    links: [
      { id: `project-memory:${projectId}`, source: projectNode.id, target: memoryNode.id, relation: "contains", directed: true },
      { id: `memory-decision:${projectId}`, source: memoryNode.id, target: decisionNode.id, relation: "explains", directed: true }
    ],
    clusters: [{ id: `cluster:${projectId}`, kind: "project", label: projectId, node_ids: [projectNode.id, memoryNode.id, decisionNode.id] }]
  };
}

function traceResource(projectId, role, language, title, kind, uri, locator) {
  const resourceId = `resource-${projectId}-${role}`;
  const versionId = `${resourceId}-v1`;
  return {
    link: {
      role,
      resource_version_id: versionId,
      locator: { heading: locator },
      note: language === "ja" ? `${locator}の確認済み抜粋` : `Confirmed excerpt from ${locator}`,
      confirmation_state: "confirmed",
      excerpt_digest: `${resourceId}-digest`
    },
    resource: {
      id: resourceId,
      tenant_id: "default",
      project_id: projectId,
      resource_kind: kind,
      canonical_uri: uri,
      title,
      source_system: "e2e-trace-fixture",
      media_type: "text/plain",
      visibility: "project",
      permissions: [],
      current_version_id: versionId,
      lifecycle_state: "active",
      created_at: now,
      updated_at: now
    },
    version: {
      id: versionId,
      source_version: "v1",
      content_hash: `${resourceId}-content-hash`,
      captured_at: now,
      extraction_state: "ready",
      pinned: true
    },
    freshness: "active",
    availability: "readable"
  };
}

function tracePayloadFor(projectId, language) {
  const isFailure = projectId === "e2e-failure-trace";
  const isMissing = projectId === "e2e-missing-trace";
  const japanese = language === "ja";
  const memoryId = `mem-${projectId}-trace`;
  const rationaleId = isFailure ? "rationale-failure-e2e" : isMissing ? "rationale-missing-e2e" : "rationale-e2e";
  const decision = isFailure
    ? (japanese ? "external_keyをcase_idから安定生成する" : "Generate external_key from the immutable case_id")
    : (japanese ? "ORGBRAIN_API_URLを正規の接続先として採用する" : "Adopt ORGBRAIN_API_URL as the canonical endpoint");
  const reason = isFailure
    ? (japanese ? "リトライ番号をキーに含めると、同じ失敗の再実行で重複メモリが作られるため。" : "Including the retry number in the key creates duplicate memories when the same failure is replayed.")
    : (japanese ? "接続先を一つに固定すると設定ドリフトを防ぎ、hookとconnectorが同じAPI境界を使えるため。" : "A single endpoint prevents configuration drift and keeps hooks and connectors on the same API boundary.");
  const alternative = isFailure
    ? (japanese ? "リトライ番号をexternal_keyに含める" : "Include the retry number in external_key")
    : (japanese ? "ORGBRAIN_API_BASEを主経路にする" : "Use ORGBRAIN_API_BASE as the primary endpoint");
  const alternativeReason = isFailure
    ? (japanese ? "再実行のたびに別キーとなり、同じ失敗を重複保存するため。" : "Each replay gets a different key and stores the same failure twice.")
    : (japanese ? "互換エイリアスを主経路にすると新旧設定が分岐し、設定ドリフトを防げないため。" : "Making the compatibility alias primary splits old and new configuration and does not prevent drift.");
  const evidence = isMissing ? [] : isFailure
    ? [
        { id: "evidence-failure-command", evidence_type: "command", evidence_ref: "pnpm memories:seed-ingestion-local --retry 2", relation: "supports:symptom", note: japanese ? "exit_code=1: リトライごとに試行キーが変わった" : "exit_code=1: the retry changed the attempt key", weight_score: 1, content_hash: "failure-command", observed_at: now, attestation_ref: "attestation-failure-command" },
        { id: "evidence-success-command", evidence_type: "command", evidence_ref: "pnpm memories:seed-ingestion-local --stable-key", relation: "supports:verified_outcome", note: japanese ? "exit_code=0: 同じセッションを再実行しても1件だけ保存" : "exit_code=0: replaying the session kept one stored memory", weight_score: 1, content_hash: "success-command", observed_at: now, attestation_ref: "attestation-success-command" },
        { id: "evidence-failure-file", evidence_type: "file", evidence_ref: "packages/orgbrain-cli/src/codex-session-import.mjs", relation: "supports:root_cause", note: japanese ? "external_keyの生成箇所" : "The external_key generation site", weight_score: 1, content_hash: "failure-file", observed_at: now, attestation_ref: "attestation-failure-file" }
      ]
    : [
        { id: "evidence-api-file", evidence_type: "file", evidence_ref: "apps/api-gateway/src/config.ts", relation: "supports:decision,rationale", note: japanese ? "正規API環境変数の読み取り" : "Reads the canonical API environment variable", weight_score: 1, content_hash: "api-file", observed_at: now, attestation_ref: "attestation-api-file" },
        { id: "evidence-user-statement", evidence_type: "user_statement", evidence_ref: "ORGBRAIN_API_URLを唯一の正規API環境変数として採用する", relation: "supports:decision", note: japanese ? "ユーザーが明示した採用方針" : "The user explicitly selected the policy", weight_score: 1, content_hash: "api-user", observed_at: now, attestation_ref: "attestation-api-user" }
      ];
  const resources = isMissing ? { sources: [], artifacts: [] } : {
    sources: [traceResource(
      projectId,
      "rationale_source",
      language,
      isFailure ? (japanese ? "重複メモリ事故のレビュー記録" : "Duplicate-memory incident review") : (japanese ? "API接続方針の判断記録" : "Canonical API endpoint decision record"),
      "document",
      `orgbrain://e2e/${projectId}/rationale`,
      japanese ? "判断理由" : "Rationale"
    )],
    artifacts: [
      traceResource(
        projectId,
        "implementation_artifact",
        language,
        isFailure ? (japanese ? "安定キー生成の実装" : "Stable key generation implementation") : (japanese ? "正規API URLの実装" : "Canonical API URL implementation"),
        "build",
        "https://example.com/orgbrain/implementation",
        japanese ? "実装" : "Implementation"
      ),
      traceResource(
        projectId,
        "verification_artifact",
        language,
        isFailure ? (japanese ? "重複なし再実行テスト" : "Duplicate-free replay test") : (japanese ? "API URL設定の検証結果" : "API URL configuration verification"),
        "test_result",
        `orgbrain://e2e/${projectId}/verification`,
        japanese ? "検証" : "Verification"
      )
    ]
  };
  const derived = isFailure ? {
    lesson_type: "failure",
    trigger: japanese ? "同じセッションをリトライした" : "The same session was retried",
    question: japanese ? "なぜ重複メモリが作られたのか" : "Why did the replay create a duplicate memory?",
    decision_key: "stable_external_key",
    decision,
    selected_value: decision,
    rationale: reason,
    alternatives: [{ alternative, reason_rejected: alternativeReason }],
    constraints: [japanese ? "同じ入力の再実行は同じメモリを更新する" : "Replaying the same input must update the same memory"],
    reuse_when: japanese ? "セッションを再実行するとき" : "When a session is replayed",
    outcome: japanese ? "同じセッションの再実行で新規メモリは0件になった" : "Replaying the same session created zero new memories",
    symptom: japanese ? "リトライで試行キーが変わり重複メモリが作られた" : "The retry changed the attempt key and created a duplicate memory",
    failed_approach: alternative,
    root_cause: japanese ? "リトライカウンタをexternal_keyに含めていた" : "The retry counter was included in external_key",
    correction: japanese ? "external_keyをcase_idから安定生成するよう修正した" : "Generate external_key from the immutable case_id",
    verified_outcome: japanese ? "同じセッションを2回取り込んでも1件だけ保存された" : "Importing the same session twice kept one stored memory",
    avoidance_rule: japanese ? "再実行可能な取込ではexternal_keyを不変のcase_idから生成し、リトライ番号を含めない" : "For replayable ingestion, derive external_key from the immutable case_id and never include the retry number"
  } : {
    lesson_type: "decision",
    trigger: japanese ? "複数の接続先環境変数が存在した" : "Multiple endpoint environment variables existed",
    question: japanese ? "どのAPI環境変数を正規とするか" : "Which API environment variable should be canonical?",
    decision_key: "canonical_api_url",
    decision,
    selected_value: "ORGBRAIN_API_URL",
    rationale: reason,
    alternatives: [{ alternative, reason_rejected: alternativeReason }],
    constraints: [japanese ? "ORGBRAIN_API_BASEは互換エイリアスとしてのみ扱う" : "Keep ORGBRAIN_API_BASE only as a compatibility alias"],
    reuse_when: japanese ? "connectorまたはhookの接続先を追加するとき" : "When adding a connector or hook endpoint",
    outcome: japanese ? "hookとconnectorが同じ正規API境界を参照する" : "Hooks and connectors reference the same canonical API boundary",
    symptom: null,
    failed_approach: null,
    root_cause: null,
    correction: null,
    verified_outcome: null,
    avoidance_rule: null
  };
  return {
    contract_version: "memory-map-trace/v1",
    selected: { node_type: "decision", id: rationaleId, memory_id: memoryId, decision_rationale_id: rationaleId },
    memory: {
      id: memoryId,
      project_id: projectId,
      kind: isFailure ? "pitfall" : "decision",
      summary: isFailure ? (japanese ? "リトライ時の重複メモリを防ぐ" : "Prevent duplicate memories during replay") : (japanese ? "正規API URLを選ぶ" : "Choose the canonical API URL"),
      lifecycle_state: "active",
      verification_state: isMissing ? "partial" : "verified",
      verified_at: isMissing ? null : now,
      reuse_rule: derived.reuse_when,
      learning: derived,
      versions: [{ version: 1, operation: "capture", summary: "Trace fixture", kind: isFailure ? "pitfall" : "decision", lifecycle_state: "active", actor_type: "system", actor_id: "e2e", created_at: now }]
    },
    selected_rationale_id: rationaleId,
    rationales: [{
      id: rationaleId,
      decision_type: isFailure ? "failure_prevention" : "decision",
      conclusion: decision,
      reason_summary: isMissing ? "" : reason,
      status: isFailure ? "resolved" : "adopted",
      confirmation_state: isMissing ? "unconfirmed" : "confirmed",
      confidence_score: isMissing ? 0.4 : 0.95,
      created_at: now,
      confirmed_at: isMissing ? null : now,
      derived,
      evidence,
      resources
    }],
    completeness: {
      rationale_count: 1,
      evidence_count: evidence.length,
      source_count: resources.sources.length,
      artifact_count: resources.artifacts.length,
      missing: isMissing ? ["alternative", "evidence", "artifact", "verification"] : [],
      partial: isMissing,
      truncated: false
    }
  };
}

const dashboardActivity = {
  contract_version: "dashboard/v1",
  events: [
    {
      id: "usage:evt-1",
      type: "memory.read",
      occurred_at: now - 18 * 60_000,
      project_id: "org-brain",
      task_id: "task-e2e",
      trace_id: "trace-e2e",
      actor: { id: "agent:codex", label: "Codex", kind: "agent" },
      subject: { type: "memory", id: memory.id, label: memory.summary },
      target: { type: "task", id: "task-e2e", label: "Dashboard implementation" },
      severity: "info",
      status: "used",
      summary: "Codex read Login principal group ACL design",
      metadata: { access_path: "context", request_source: "api", model: "gpt-5" }
    },
    {
      id: "task:evt-2",
      type: "task.failed",
      occurred_at: now - 9 * 60_000,
      project_id: "org-brain",
      task_id: "task-failed",
      trace_id: "trace-failed",
      actor: { id: "system:cap-runner", label: "Capability runner", kind: "system" },
      subject: { type: "task", id: "task-failed", label: "Index parity check" },
      target: null,
      severity: "critical",
      status: "failed",
      summary: "Task failed: Index parity check",
      metadata: { capability: "memory_measurement", event_kind: "failed" }
    }
  ],
  observed_agents: [
    { id: "agent:codex", label: "Codex", model: "gpt-5", state: "active", last_seen_at: now - 18 * 60_000, active_task_count: 1, read_count: 4, write_count: 2, failure_count: 0 },
    { id: "agent:ops", label: "Ops Agent", model: null, state: "active", last_seen_at: now - 2 * 60 * 60_000, active_task_count: 0, read_count: 2, write_count: 1, failure_count: 1 }
  ],
  attention: [
    { id: "task_failed:task-failed", kind: "task_failed", severity: "critical", detected_at: now - 9 * 60_000, subject_type: "task", subject_id: "task-failed", reason: "A task failed and needs review" }
  ],
  oldest_cursor: "eyJ2IjoxLCJhdCI6MSwia2V5Ijoib2xkIn0",
  newest_cursor: "eyJ2IjoxLCJhdCI6Miwia2V5IjoibmV3In0",
  has_more: false,
  generated_at: now
};

const strataSummary = {
  id: "decision:decision-e2e",
  type: "decision",
  source_type: "decision_memory",
  source_id: "decision-e2e",
  title: "Use authenticated principals for shared memory",
  project_id: "org-brain",
  current_state: "active",
  confidence: 0.9,
  valid_from: now - 30 * 86_400_000,
  valid_until: null,
  changed_at: now - 2 * 86_400_000,
  partial: false,
  revision_count: 3,
  source_count: 2,
  attention: []
};

const canonicalStrataSummary = {
  ...strataSummary,
  id: `memory:${memory.id}`,
  type: "canonical",
  source_type: "memory",
  source_id: memory.id,
  title: memory.summary,
  current_state: "promoted",
  confidence: 0.93,
  changed_at: now,
  revision_count: 3
};

const dashboardStrata = {
  contract_version: "dashboard/v1",
  chains: [
    canonicalStrataSummary,
    strataSummary
  ],
  oldest_cursor: "eyJ2IjoxLCJhdCI6MSwia2V5Ijoic3RyYXRhIn0",
  has_more: false,
  generated_at: now,
  truncated: false
};

const dashboardStrataDetail = {
  contract_version: "dashboard/v1",
  chain: {
    ...strataSummary,
    revisions: [
      { id: "decision-version-1", operation: "create", recorded_at: now - 30 * 86_400_000, valid_from: now - 30 * 86_400_000, valid_until: null, actor_id: "user:e2e-login-sub", state: "proposed", summary: "Initial access decision", partial: false, snapshot: { status: "proposed", confirmation_state: "inferred_unconfirmed" } },
      { id: "decision-version-2", operation: "confirm", recorded_at: now - 2 * 86_400_000, valid_from: now - 30 * 86_400_000, valid_until: null, actor_id: "user:e2e-login-sub", state: "active", summary: "Confirmed after ACL review", partial: false, snapshot: { status: "active", confirmation_state: "user_confirmed" } }
    ],
    relations: [{ relation: "derived_from", target_type: "memory", target_id: memory.id, valid_from: now - 30 * 86_400_000, valid_until: null }],
    sources: [{ resource_id: "resource-e2e", resource_version_id: "resource-version-e2e", title: "ACL design note", relation: "conclusion_source", captured_at: now - 31 * 86_400_000, locator: { heading: "Access model" }, unresolved: false }]
  },
  truncated: { revisions: false, sources: false }
};

const dashboardCanonicalStrataDetail = {
  contract_version: "dashboard/v1",
  chain: {
    ...canonicalStrataSummary,
    revisions: [
      { id: "memory-version-1", operation: "capture", recorded_at: now - 30 * 86_400_000, valid_from: now - 30 * 86_400_000, valid_until: null, actor_id: "agent:codex", state: "active", summary: "Captured ACL guidance", partial: false, snapshot: { lifecycle_state: "active", kind: "semantic" } },
      { id: "memory-version-2", operation: "promote", recorded_at: now, valid_from: now - 30 * 86_400_000, valid_until: null, actor_id: "user:e2e-login-sub", state: "promoted", summary: memory.summary, partial: false, snapshot: { lifecycle_state: "promoted", kind: "semantic" } }
    ],
    relations: [{ relation: "supports", target_type: "decision_memory", target_id: "decision-e2e", valid_from: now - 30 * 86_400_000, valid_until: null }],
    sources: [{ resource_id: "resource-e2e", resource_version_id: "resource-version-e2e", title: "ACL design note", relation: "source_ref", captured_at: now - 31 * 86_400_000, locator: { heading: "Access model" }, unresolved: false }]
  },
  truncated: { revisions: false, sources: false }
};

const denseActivity = {
  ...dashboardActivity,
  events: Array.from({ length: 250 }, (_, index) => ({
    ...dashboardActivity.events[index % dashboardActivity.events.length],
    id: `dense-event-${index}`,
    occurred_at: now - index * 1_000,
    summary: `Dense activity ${index + 1}`
  })),
  observed_agents: Array.from({ length: 24 }, (_, index) => ({
    ...dashboardActivity.observed_agents[index % dashboardActivity.observed_agents.length],
    id: `agent:dense-${index}`,
    label: `Dense Agent ${index + 1}`,
    last_seen_at: now - index * 1_000
  })),
  has_more: true
};

const denseStrata = {
  ...dashboardStrata,
  chains: Array.from({ length: 100 }, (_, index) => ({
    ...strataSummary,
    id: index === 0 ? strataSummary.id : `memory:dense-${index}`,
    type: index === 0 ? "decision" : index % 9 === 0 ? "assumption" : index % 5 === 0 ? "learning" : "canonical",
    source_type: index === 0 ? "decision_memory" : "memory",
    source_id: index === 0 ? strataSummary.source_id : `dense-${index}`,
    title: index === 0 ? strataSummary.title : `Dense lineage ${index + 1}`,
    changed_at: now - index * 60_000
  })),
  has_more: true,
  truncated: true
};

const decisionMemory = {
  id: "decision-e2e",
  tenantId: "default",
  projectId: "org-brain",
  domain: "architecture",
  title: "Use authenticated principals for shared memory",
  decision: "Only authenticated principals may read restricted organization memory.",
  rationale: "ACL checks must run before dashboard projections are assembled.",
  constraints: ["Do not accept actor identity from request payloads."],
  knownPitfalls: ["Historical rows may have no actor attribution."],
  sourceRefs: [{ type: "resource", id: "resource-e2e", title: "ACL design note" }],
  ownerRefs: [{ type: "user", id: "user:e2e-login-sub", name: "E2E Login User" }],
  reviewerRefs: [{ type: "user", id: "user:e2e-login-sub", name: "E2E Login User" }],
  validFrom: now - 30 * 86_400_000,
  validUntil: null,
  status: "active",
  supersededBy: null,
  confidence: 0.9,
  visibility: "tenant",
  confirmationState: "user_confirmed",
  confirmationNote: "Reviewed in E2E",
  confirmedAt: now - 2 * 86_400_000,
  createdAt: now - 30 * 86_400_000,
  updatedAt: now - 2 * 86_400_000,
  trustSignals: {
    confidence: 0.9,
    confirmationState: "user_confirmed",
    humanConfirmed: true,
    sourceAuthority: 0.9,
    sourceCount: 1,
    ownerCount: 1,
    reviewerCount: 1,
    freshness: "fresh",
    conflictCount: 0,
    visibility: "tenant",
    permissionFilteredSourceCount: 0
  }
};

const decisionContext = {
  decisionMemory,
  whyTrustThis: {
    trustSignals: decisionMemory.trustSignals,
    provenance: {
      decidedBy: decisionMemory.ownerRefs,
      reviewedBy: decisionMemory.reviewerRefs,
      sourceRefs: decisionMemory.sourceRefs,
      createdAt: decisionMemory.createdAt,
      updatedAt: decisionMemory.updatedAt,
      confirmedAt: decisionMemory.confirmedAt,
      confirmationNote: decisionMemory.confirmationNote,
      applicableContext: {
        domain: decisionMemory.domain,
        projectId: decisionMemory.projectId,
        validFrom: decisionMemory.validFrom,
        validUntil: decisionMemory.validUntil,
        status: decisionMemory.status,
        constraints: decisionMemory.constraints,
        knownPitfalls: decisionMemory.knownPitfalls
      }
    },
    conflicts: [],
    versions: [
      {
        id: "decision-version-2",
        operation: "confirm",
        snapshot: {
          title: decisionMemory.title,
          decision: decisionMemory.decision,
          rationale: decisionMemory.rationale,
          confirmationState: "user_confirmed",
          status: "active",
          validFrom: decisionMemory.validFrom,
          validUntil: decisionMemory.validUntil,
          supersededBy: null
        },
        actorRefs: decisionMemory.ownerRefs,
        reviewerRefs: decisionMemory.reviewerRefs,
        note: "Reviewed in E2E",
        createdAt: decisionMemory.updatedAt
      },
      {
        id: "decision-version-1",
        operation: "create",
        snapshot: {
          title: decisionMemory.title,
          decision: decisionMemory.decision,
          rationale: decisionMemory.rationale,
          confirmationState: "inferred_unconfirmed",
          status: "uncertain",
          validFrom: decisionMemory.validFrom,
          validUntil: decisionMemory.validUntil,
          supersededBy: null
        },
        actorRefs: decisionMemory.ownerRefs,
        reviewerRefs: [],
        note: "Created from the initial proposal",
        createdAt: decisionMemory.createdAt
      }
    ]
  },
  related: []
};

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function ok(data) {
  return { ok: true, data };
}

function taskFixtures(tenantId, projectId) {
  if (projectId === "e2e-task-dense") {
    return Array.from({ length: 21 }, (_, index) => ({
      id: "task-dense-" + (index + 1),
      tenant_id: tenantId,
      project_id: projectId,
      capability: index % 2 === 0 ? "memory_measurement" : "knowledge_graph",
      status: index % 3 === 0 ? "failed" : "succeeded",
      updated_at: now - index * 60_000
    }));
  }
  return [
    {
      id: "task-e2e",
      tenant_id: tenantId,
      project_id: projectId || "org-brain",
      capability: "memory_measurement",
      status: "succeeded",
      updated_at: now
    },
    {
      id: "task-failed",
      tenant_id: tenantId,
      project_id: projectId || "org-brain",
      capability: "knowledge_graph",
      status: "failed",
      updated_at: now - 9 * 60_000
    }
  ];
}

function operationsStatus(tenantId) {
  return {
    tenant_id: tenantId,
    generated_at: now,
    scheduled_jobs: [{ job_name: "memory_measurement", latest_status: "succeeded", stale: false, last_success_at: now, success_age_ms: 3_600_000, next_expected_at: now + 3_600_000 }],
    retention_queue: { pending: 2, overdue: 0, failed: 0, manual_review: 0 },
    memories: { total: 12, conflicting: 1, expired: 0 },
    decision_review: { unconfirmed: 2, low_confidence: 1 },
    tasks: { active: 1, failed: 1, stuck: 0, failed_items: [{ id: "task-failed", capability: "knowledge_graph", status: "failed", updated_at: now - 9 * 60_000 }] },
    audit: { events_24h: 24, denied_24h: 1, failed_24h: 1 },
    authorization: { roles: [{ role: "tenant_admin", permissions: ["memory:read", "task:replay"], assignments: 1, principals: 1 }] },
    retrieval: { searches_24h: 18, hit_rate_24h: 0.9, fallback_rate_24h: 0.1, average_latency_ms_24h: 42, semantic_configured: true, lexical: "ready", graph: "ready" },
    scoped_tokens: { active: 1 },
    retention: { legal_holds: 0 },
    slo_targets: { rpo_minutes: 15, rto_minutes: 60 }
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (path === "/health") {
    json(response, 200, { ok: true });
    return;
  }

  if (path === "/v1/tasks" && request.method === "GET") {
    const projectId = url.searchParams.get("project_id") || "org-brain";
    if (projectId === "e2e-task-error") {
      json(response, 503, { ok: false, error: { code: "task_unavailable", message: "Task fixture unavailable" } });
      return;
    }
    const tenantId = url.searchParams.get("tenant_id") || "default";
    const query = (url.searchParams.get("q") || "").toLowerCase();
    const status = url.searchParams.get("status") || "";
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const limit = Math.max(1, Number(url.searchParams.get("limit") || 50));
    const tasks = taskFixtures(tenantId, projectId)
      .filter((task) => !status || task.status === status)
      .filter((task) => !query || (" " + task.id + " " + task.capability + " " + task.project_id).toLowerCase().includes(query));
    json(response, 200, ok(tasks.slice(offset, offset + limit)));
    return;
  }

  const taskEventsMatch = path.match(/^\/v1\/tasks\/([^/]+)\/events$/u);
  if (taskEventsMatch && request.method === "GET") {
    const taskId = decodeURIComponent(taskEventsMatch[1]);
    const projectId = url.searchParams.get("project_id") || "org-brain";
    if (projectId === "e2e-task-events-error") {
      json(response, 503, { ok: false, error: { code: "task_events_unavailable", message: "Task events fixture unavailable" } });
      return;
    }
    const task = taskFixtures(url.searchParams.get("tenant_id") || "default", projectId).find((item) => item.id === taskId);
    if (!task) {
      json(response, 404, { ok: false, error: { code: "task_not_found", message: "Task not found" } });
      return;
    }
    json(response, 200, ok([
      { id: `${taskId}-created`, kind: "created", payload: { capability: task.capability, project_id: task.project_id }, created_at: task.updated_at - 60_000 },
      ...(task.status === "failed" ? [{ id: `${taskId}-failed`, kind: "task.failed", payload: { reason: "Fixture failure" }, created_at: task.updated_at }] : [])
    ]));
    return;
  }

  const taskDetailMatch = path.match(/^\/v1\/tasks\/([^/]+)$/u);
  if (taskDetailMatch && request.method === "GET") {
    const taskId = decodeURIComponent(taskDetailMatch[1]);
    const projectId = url.searchParams.get("project_id") || "org-brain";
    if (projectId === "e2e-task-detail-error") {
      json(response, 503, { ok: false, error: { code: "task_unavailable", message: "Task detail fixture unavailable" } });
      return;
    }
    const task = taskFixtures(url.searchParams.get("tenant_id") || "default", projectId).find((item) => item.id === taskId);
    if (!task) {
      json(response, 404, { ok: false, error: { code: "task_not_found", message: "Task not found" } });
      return;
    }
    json(response, 200, ok({ ...task, priority: 0, created_at: task.updated_at - 60_000 }));
    return;
  }

  if (path === "/v1/ops/status" && request.method === "GET") {
    const tenantId = url.searchParams.get("tenant_id") || "default";
    json(response, 200, ok(operationsStatus(tenantId)));
    return;
  }

  if (path.startsWith("/v1/ops/tasks/") && path.endsWith("/replay") && request.method === "POST") {
    const body = await readJson(request);
    const tenantId = body.tenant_id || "default";
    json(response, 201, ok({ task_id: "replayed-" + tenantId, tenant_id: tenantId }));
    return;
  }

  if (path === "/v1/dashboard/activity" && request.method === "GET") {
    const state = url.searchParams.get("project_id");
    if (state === "e2e-error") {
      json(response, 503, { ok: false, error: { code: "dashboard_unavailable", message: "Dashboard fixture unavailable" } });
      return;
    }
    if (state === "e2e-empty") {
      json(response, 200, ok({
        ...dashboardActivity,
        events: [],
        observed_agents: [],
        attention: [],
        oldest_cursor: null,
        newest_cursor: null
      }));
      return;
    }
    if (url.searchParams.has("after")) {
      json(response, 200, ok({
        ...dashboardActivity,
        events: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more: false,
        generated_at: Date.now()
      }));
      return;
    }
    if (state === "e2e-sparse") {
      json(response, 200, ok({
        ...dashboardActivity,
        events: dashboardActivity.events.slice(0, 1),
        observed_agents: dashboardActivity.observed_agents.slice(0, 1),
        attention: []
      }));
      return;
    }
    if (state === "e2e-dense") {
      json(response, 200, ok(denseActivity));
      return;
    }
    json(response, 200, ok(dashboardActivity));
    return;
  }

  if (path === "/v1/dashboard/memory-map" && request.method === "GET") {
    const projectId = url.searchParams.get("project_id") || "org-brain";
    json(response, 200, ok(traceMapFor(projectId)));
    return;
  }

  if (path === "/v1/dashboard/memory-map/trace" && request.method === "GET") {
    const projectId = url.searchParams.get("project_id") || "org-brain";
    if (projectId === "e2e-trace-error") {
      json(response, 503, { ok: false, error: { code: "trace_unavailable", message: "Decision trace fixture unavailable" } });
      return;
    }
    const language = url.searchParams.get("lang") === "en" ? "en" : "ja";
    json(response, 200, ok(tracePayloadFor(projectId, language)));
    return;
  }

  if (path === "/v1/dashboard/strata" && request.method === "GET") {
    const state = url.searchParams.get("project_id");
    if (state === "e2e-empty") {
      json(response, 200, ok({ ...dashboardStrata, chains: [], oldest_cursor: null }));
      return;
    }
    if (state === "e2e-sparse") {
      json(response, 200, ok({ ...dashboardStrata, chains: dashboardStrata.chains.slice(0, 1) }));
      return;
    }
    if (state === "e2e-dense") {
      json(response, 200, ok(denseStrata));
      return;
    }
    json(response, 200, ok(state === "e2e-truncated"
      ? { ...dashboardStrata, has_more: true, truncated: true }
      : dashboardStrata));
    return;
  }

  if (path.startsWith("/v1/dashboard/strata/") && request.method === "GET") {
    const state = url.searchParams.get("project_id");
    if (state === "e2e-partial-error") {
      json(response, 503, { ok: false, error: { code: "detail_unavailable", message: "Strata detail fixture unavailable" } });
      return;
    }
    const detail = path.includes("/strata/memory/")
      ? dashboardCanonicalStrataDetail
      : dashboardStrataDetail;
    json(response, 200, ok(state === "e2e-truncated"
      ? { ...detail, truncated: { revisions: true, sources: true } }
      : detail));
    return;
  }

  if (path === "/v1/decision-memories/search" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 200, ok({
      tenant_id: body.tenant_id ?? "default",
      project_id: body.project_id ?? null,
      q: body.q ?? "",
      results: [decisionMemory]
    }));
    return;
  }

  if (path === `/v1/decision-memories/${decisionMemory.id}/context` && request.method === "GET") {
    json(response, 200, ok(decisionContext));
    return;
  }

  if (path.startsWith("/v1/decisions/") && path.endsWith("/resources") && request.method === "GET") {
    const projectId = url.searchParams.get("project_id") || "org-brain";
    const language = url.searchParams.get("lang") === "en" ? "en" : "ja";
    const trace = tracePayloadFor(projectId, language);
    const rationale = trace.rationales[0];
    json(response, 200, ok({
      decision: {
        decision_ref: { source_type: "decision_rationale", source_id: rationale.id },
        conclusion: rationale.conclusion,
        reason_summary: rationale.reason_summary
      },
      artifacts: rationale.resources.artifacts,
      artifacts_by_role: {
        implementation_artifact: rationale.resources.artifacts.filter((item) => item.link.role === "implementation_artifact"),
        output_artifact: [],
        verification_artifact: rationale.resources.artifacts.filter((item) => item.link.role === "verification_artifact")
      },
      coverage: { proposed_excluded: true, truncated: false, related_included: false }
    }));
    return;
  }

  if (
    (path === `/v1/decision-memories/${decisionMemory.id}/revise` ||
      path === `/v1/decision-memories/${decisionMemory.id}/confirm`) &&
    request.method === "POST"
  ) {
    await readJson(request);
    json(response, 200, ok({ decisionMemory }));
    return;
  }

  if (path === "/v1/auth/me" && request.method === "GET") {
    json(response, 200, ok({
      tenant_id: url.searchParams.get("tenant_id") || "default",
      auth: {
        principal: "user:e2e-login-sub",
        source: "access-jwt",
        allowed_tenants: ["default"],
        email: "e2e@example.com",
        display_name: "E2E Login User"
      },
      profile: {
        display_name: "E2E Login User",
        full_name: "E2E Full Name",
        email: "e2e@example.com",
        company_name: "Example Holdings",
        organization_name: "Platform Lab",
        avatar_url: "https://example.com/avatar.png"
      },
      groups: []
    }));
    return;
  }

  if (path === "/v1/auth/me/profile" && request.method === "PUT") {
    const body = await readJson(request);
    json(response, 200, ok({
      tenant_id: body.tenant_id ?? "default",
      profile: {
        display_name: body.display_name ?? null,
        full_name: body.full_name ?? null,
        email: body.email ?? null,
        company_name: body.company_name ?? null,
        organization_name: body.organization_name ?? null,
        avatar_url: body.avatar_url ?? null
      }
    }));
    return;
  }

  if (path === "/v1/organization" && request.method === "GET") {
    json(response, 200, ok({ tenant_id: "default", slug: "default", display_name: "E2E Organization", allowed_email_domains: ["example.com"], email_self_registration_enabled: true }));
    return;
  }
  if (path === "/v1/organization" && request.method === "PATCH") {
    json(response, 200, ok(await readJson(request)));
    return;
  }
  if (path === "/v1/users" && request.method === "GET") {
    json(response, 200, ok({ users: [{ principal: "user:e2e-login-sub", display_name: "E2E Login User", full_name: "E2E Full Name", email: "e2e@example.com", status: "active", provision_source: "legacy", full_name_source: "legacy", role: "tenant_admin" }] }));
    return;
  }
  if (path === "/v1/users" && request.method === "POST") {
    json(response, 201, ok({ ...(await readJson(request)), principal: "user:invited", status: "invited" }));
    return;
  }
  if (path.startsWith("/v1/users/") && request.method === "PATCH") {
    json(response, 200, ok(await readJson(request)));
    return;
  }
  if (path === "/v1/directory" && request.method === "GET") {
    json(response, 200, ok({ users: [{ principal: "user:e2e-login-sub", display_name: "E2E Login User", avatar_url: null, status: "active" }] }));
    return;
  }
  if (path === "/v1/groups" && request.method === "GET") {
    json(response, 200, ok({ tenant_id: "default", groups: [{ id: "group-e2e", slug: "reviewers", name: "Reviewers", description: "Local review group", source: "local", role: "owner", updated_at: now }] }));
    return;
  }
  if (path === "/v1/groups" && request.method === "POST") {
    json(response, 201, ok({ group: { ...(await readJson(request)), id: "group-created", source: "local" } }));
    return;
  }
  if (path === "/v1/groups/group-e2e" && request.method === "GET") {
    json(response, 200, ok({ group: { id: "group-e2e", slug: "reviewers", name: "Reviewers", description: "Local review group", source: "local", role: "owner" }, members: [{ principal: "user:e2e-login-sub", role: "owner", source: "local" }] }));
    return;
  }
  if (path.startsWith("/v1/groups/group-e2e") && ["POST", "PATCH", "DELETE"].includes(request.method)) {
    json(response, 200, ok({ updated: true }));
    return;
  }
  if (path === "/v1/business-categories" && request.method === "GET") {
    json(response, 200, ok([{ id: "category-e2e", tenant_id: "default", slug: "engineering", label: "Engineering", description: "Build work", is_active: true, created_at: now, updated_at: now }]));
    return;
  }
  if ((path === "/v1/business-categories" && request.method === "POST") || (path.startsWith("/v1/business-categories/") && request.method === "PATCH")) {
    json(response, request.method === "POST" ? 201 : 200, ok(await readJson(request)));
    return;
  }

  if (path === "/v1/memories" && request.method === "GET") {
    json(response, 200, ok({
      tenant_id: url.searchParams.get("tenant_id") || "default",
      project_id: url.searchParams.get("project_id") || null,
      source: null,
      items: [memory],
      meta: {
        limit: 20,
        offset: 0,
        total: 1,
        has_next: false,
        has_prev: false,
        canonical_count: 1,
        digest_count: 0,
        compacted_count: 0
      }
    }));
    return;
  }

  if (path === "/v1/dashboard/memory-analytics" && request.method === "GET") {
    json(response, 200, ok({
      scope: url.searchParams.get("scope") === "org" ? "org" : "mine",
      perspective: url.searchParams.get("perspective") === "spread" ? "spread" : "work",
      period: {
        from: Number(url.searchParams.get("from")) || now - 30 * 24 * 60 * 60 * 1000,
        to: Number(url.searchParams.get("to")) || now
      },
      summary: {
        reference_count: 12,
        used_count: 9,
        consumer_count: 4,
        net_saved_tokens: 1840,
        injected_tokens: 720,
        utilization_rate: 0.75,
        effective_utilization_rate: 0.75,
        org_reuse_rate: 0.5,
        token_efficiency: 0.72,
        measurement_coverage: 1,
        measurement_state: "verified"
      },
      trend: [
        { day: "2026-08-16", reference_count: 4, net_saved_tokens: 480, measurement_state: "verified" },
        { day: "2026-08-17", reference_count: 8, net_saved_tokens: 1360, measurement_state: "verified" }
      ],
      rankings: {
        memories: [{ id: memory.id, label: memory.summary, project_id: "org-brain", reference_count: 12, measurement_state: "verified" }],
        owners: [{ id: "owner-e2e", label: "Console operators", reference_count: 12, measurement_state: "verified" }],
        projects: [{ id: "org-brain", label: "Org Brain", reference_count: 12, measurement_state: "verified" }],
        consumers: [{ id: "consumer-e2e", label: "Administration team", reference_count: 9, measurement_state: "verified" }]
      },
      diagnostics: [],
      definitions: {
        utilization_rate: "Runs with at least one used memory divided by evaluated runs.",
        measurement_coverage: "Terminal reports divided by eligible runs."
      }
    }));
    return;
  }

  if (path === "/v1/memory-quality/runs" && request.method === "GET") {
    if (privateQualityRun) {
      json(response, 200, ok({ tenant_id: "default", items: [privateQualityRun.run], meta: { returned_count: 1 } }));
      return;
    }
    json(response, 200, ok({ tenant_id: "default", items: [{ id: "quality-e2e", corpus_id: "v3", status: "passed", input_source: "synthetic", capture_routes: ["realtime_hook", "initial_import"], hard_violation_count: 0, started_at: now, completed_at: now }], meta: { returned_count: 1 } }));
    return;
  }

  if (privateQualityRun && path === `/v1/memory-quality/runs/${privateQualityRun.run.id}` && request.method === "GET") {
    const route = url.searchParams.get("route");
    const actualRoute = url.searchParams.get("actual_route");
    const issue = url.searchParams.get("issue");
    const projectHash = url.searchParams.get("project_hash");
    const parity = url.searchParams.get("parity_mismatch");
    const cases = privateQualityRun.cases.filter((item) =>
      (!route || item.capture_route === route) &&
      (!actualRoute || item.actual_route === actualRoute) &&
      (!issue || item.reason_codes.includes(issue)) &&
      (!projectHash || item.project_hash === projectHash) &&
      (!parity || item.parity_mismatch === (parity === "1"))
    );
    json(response, 200, ok({
      tenant_id: "default",
      run: privateQualityRun.run,
      dimensions: privateQualityRun.dimensions,
      cases,
      meta: { returned_count: cases.length }
    }));
    return;
  }

  if (path === "/v1/memory-quality/runs/quality-e2e" && request.method === "GET") {
    const empty = url.searchParams.get("project_hash") === "empty";
    json(response, 200, ok({
      tenant_id: "default",
      run: { id: "quality-e2e", corpus_id: "v3", status: "passed", input_source: "synthetic", capture_routes: ["realtime_hook", "initial_import"], hard_violation_count: 0, started_at: now, completed_at: now },
      dimensions: ["semantic_completeness", "evidence_support", "rationale_quality", "future_reuse", "scope_specificity", "freshness_validity", "atomicity"].map((axis) => ({ axis, cohort: "all", numerator: 100, denominator: 100, point_estimate: 1, wilson_lower: 0.964, hard_violation_count: 0 })),
      cases: empty ? [] : [
        { id: "case-active", case_hash: "active-hash", project_hash: "project-hash", split: "locked_test", lesson_type: "decision", capture_route: "realtime_hook", expected_route: "active", actual_route: "active", reason_codes: [], hard_violation_count: 0, parity_mismatch: false, memory_id: memory.id, summary: "Login principal group ACL design" },
        { id: "case-excluded", case_hash: "excluded-hash", project_hash: "project-hash", split: "locked_test", lesson_type: null, capture_route: "initial_import", expected_route: "excluded", actual_route: "excluded", reason_codes: ["credential_detected"], hard_violation_count: 1, parity_mismatch: false, memory_id: null, summary: null }
      ],
      meta: { returned_count: empty ? 0 : 2 }
    }));
    return;
  }

  if (path === "/v1/memories/profile" && request.method === "POST") {
    json(response, 200, ok({
      tenant_id: "default",
      project_id: "org-brain",
      durable: [profileItem],
      recent: [profileItem],
      search_results: [profileItem],
      meta: {
        durable_count: 1,
        recent_count: 1
      }
    }));
    return;
  }

  if (path === "/v1/memories/search" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 200, ok({
      tenant_id: body.tenant_id ?? "default",
      project_id: body.project_id ?? null,
      q: body.q ?? "",
      rewrite_query: Boolean(body.rewrite_query),
      search_mode: body.search_mode ?? "hybrid",
      include_history: Boolean(body.include_history),
      results: [{
        kind: "memory",
        id: memory.id,
        summary: memory.summary,
        content_preview: memory.content,
        score: 0.987,
        source: memory.source,
        created_at: memory.created_at,
        memory_kind: memory.kind,
        lifecycle_state: memory.lifecycle_state,
        current_version: memory.current_version
      }],
      meta: {
        search_strategy: "mock-hybrid",
        matched_count: 1,
        returned_count: 1,
        fallback_used: false,
        variant_count: 1
      }
    }));
    return;
  }

  if (path === `/v1/memories/${memory.id}/details` && request.method === "GET") {
    json(response, 200, ok({
      tenant_id: url.searchParams.get("tenant_id") || "default",
      memory_id: memory.id,
      versions: [{
        version: 3,
        operation: "upsert",
        summary: memory.summary,
        kind: memory.kind,
        lifecycle_state: memory.lifecycle_state,
        actor_type: "principal",
        actor_id: "user:e2e-login-sub",
        created_at: now
      }],
      rationales: [{
        id: "rat_e2e",
        decision_type: "policy",
        conclusion: "Use login principal for shared memory access.",
        reason_summary: "The UI should show provenance and management actions for authenticated memory owners.",
        status: "accepted",
        confirmation_state: "user_confirmed",
        confidence_score: 0.9,
        created_at: now,
        confirmed_at: now,
        evidence: []
      }]
    }));
    return;
  }

  if (path === "/v1/memories/refresh" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 200, ok({ memory_id: body.memory_id, refreshed: true }));
    return;
  }

  if (path === "/v1/memories/suppress" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 200, ok({ memory_id: body.memory_id, suppressed: true }));
    return;
  }

  json(response, 404, { ok: false, error: { code: "not_found", message: `${request.method} ${path}` } });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock api listening on http://127.0.0.1:${port}`);
});
