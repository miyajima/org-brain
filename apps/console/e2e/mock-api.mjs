import http from "node:http";
import fs from "node:fs";
import pathModule from "node:path";
import { DatabaseSync } from "node:sqlite";
import { domainPackCatalog, workspaceFor } from "./domain-workspace-fixtures.mjs";

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

function knowledgeMapNode(id, nodeType, projectId, values = {}) {
  const isMemory = nodeType === "memory";
  const isDecision = nodeType === "decision";
  const isProject = nodeType === "project";
  const isEntity = nodeType === "entity";
  return {
    id,
    node_type: nodeType,
    memory_id: values.memory_id ?? (isMemory ? id.replace(/^memory:/u, "") : null),
    decision_id: isDecision ? values.decision_id ?? id.replace(/^decision:/u, "") : null,
    related_memory_id: isDecision ? values.memory_id ?? null : null,
    entity_id: isEntity ? values.entity_id ?? id.replace(/^entity:/u, "") : null,
    entity_type: isEntity ? values.entity_type ?? "concept" : null,
    tenant_id: "default",
    label: values.label ?? id,
    summary: values.summary ?? values.label ?? id,
    project_id: projectId,
    owner_principal: isMemory || isDecision ? "user:e2e-login-sub" : null,
    created_by_principal: isMemory || isDecision ? "user:e2e-login-sub" : null,
    reference_count: values.reference_count ?? (isProject ? 6 : isEntity ? 4 : 2),
    consumer_count: values.consumer_count ?? (isMemory ? 2 : 0),
    used_count: values.used_count ?? (isMemory ? 3 : 0),
    utilization_rate: isMemory ? values.utilization_rate ?? 0.62 : null,
    net_saved_tokens: values.net_saved_tokens ?? (isMemory ? 180 : 0),
    injected_tokens: values.injected_tokens ?? (isMemory ? 52 : 0),
    member_count: values.member_count ?? (isProject ? 3 : undefined),
    entity_link_count: isEntity ? values.entity_link_count ?? 3 : undefined,
    updated_at: now,
    decision_type: isDecision ? values.decision_type ?? "decision" : null,
    confirmation_state: isDecision ? values.confirmation_state ?? "confirmed" : null,
    confidence_score: isDecision ? values.confidence_score ?? 0.92 : null
  };
}

function allKnowledgeMapFor(projectId) {
  if (projectId && projectId !== "org-brain") return traceMapFor(projectId);
  const project = "org-brain";
  const sharedProject = "delivery-ops";
  const nodes = [
    knowledgeMapNode("tenant:default", "tenant", null, { label: "Org Brain workspace", summary: "All readable knowledge", member_count: 3, reference_count: 12 }),
    knowledgeMapNode("project:org-brain", "project", project, { label: "Org Brain · org-brain", summary: "Decision-first workspace", member_count: 3, reference_count: 8 }),
    knowledgeMapNode("project:delivery-ops", "project", sharedProject, { label: "Delivery Ops", summary: "Shared delivery knowledge", member_count: 2, reference_count: 6 }),
    knowledgeMapNode("memory:auth-acl", "memory", project, { label: "Login principal group ACL design", summary: "Authenticated principals can read shared organization memory", memory_id: "mem_auth_group_acl", reference_count: 5, net_saved_tokens: 260 }),
    knowledgeMapNode("memory:canonical-api", "memory", project, { label: "Canonical API endpoint decision", summary: "Use one canonical endpoint to prevent configuration drift", memory_id: "mem-orgbrain-api", reference_count: 4, net_saved_tokens: 220 }),
    knowledgeMapNode("memory:skill-publish", "memory", project, { label: "Publish skills as private drafts", summary: "Generated skills stay private until an owner publishes them", memory_id: "mem-skill-publish", reference_count: 3, net_saved_tokens: 190 }),
    knowledgeMapNode("memory:agent-loadout", "memory", sharedProject, { label: "ACL-first agent loadout", summary: "Resolve agent context only after access checks", memory_id: "mem-agent-loadout", reference_count: 4, net_saved_tokens: 240 }),
    knowledgeMapNode("memory:review-loop", "memory", sharedProject, { label: "Review before release", summary: "A review gate catches stale decisions before rollout", memory_id: "mem-review-loop", reference_count: 3, net_saved_tokens: 150 }),
    knowledgeMapNode("decision:rationale-e2e", "decision", project, { label: "Canonical API endpoint decision", summary: "Adopt ORGBRAIN_API_URL as the canonical endpoint", memory_id: "mem_auth_group_acl", decision_id: "rationale-e2e" }),
    knowledgeMapNode("decision:skill-publish", "decision", project, { label: "Skill publish boundary", summary: "Publish only after owner verification", memory_id: "mem-skill-publish", decision_id: "rationale-skill-publish" }),
    knowledgeMapNode("decision:review-loop", "decision", sharedProject, { label: "Release review gate", summary: "Keep a human review gate before rollout", memory_id: "mem-review-loop", decision_id: "rationale-review-loop" }),
    knowledgeMapNode("entity:acl-policy", "entity", project, { label: "ACL-first access", summary: "Shared access policy concept", entity_id: "acl-policy", reference_count: 7, entity_link_count: 4 }),
    knowledgeMapNode("entity:release-gate", "entity", sharedProject, { label: "Release gate", summary: "Review and verification concept", entity_id: "release-gate", reference_count: 5, entity_link_count: 3 })
  ];
  const extraProjects = [
    { id: "context-lab", label: "Context Lab", summary: "Reusable context patterns" },
    { id: "support-ops", label: "Support Ops", summary: "Support response knowledge" },
    { id: "product-research", label: "Product Research", summary: "Validated product learning" },
    { id: "governance", label: "Governance", summary: "Review and access controls" }
  ];
  const projectIds = [project, sharedProject, ...extraProjects.map((item) => item.id)];
  for (const item of extraProjects) {
    nodes.push(knowledgeMapNode(`project:${item.id}`, "project", item.id, {
      label: item.label,
      summary: item.summary,
      member_count: 0,
      reference_count: 0
    }));
  }
  const extraEntitySpecs = [
    ["policy-boundary", "Policy boundary", "Access and lifecycle boundary"],
    ["evidence-loop", "Evidence loop", "Reviewable evidence chain"],
    ["context-window", "Context window", "Bounded context selection"],
    ["owner-review", "Owner review", "Human publish gate"],
    ["freshness-check", "Freshness check", "Staleness detection" ]
  ];
  for (const [id, label, summary] of extraEntitySpecs) {
    nodes.push(knowledgeMapNode(`entity:${id}`, "entity", project, {
      label,
      summary,
      entity_id: id,
      entity_link_count: 0,
      reference_count: 0
    }));
  }
  for (let index = 1; index <= 32; index += 1) {
    const projectId = projectIds[(index - 1) % projectIds.length];
    const memoryKey = `fixture-${String(index).padStart(2, "0")}`;
    nodes.push(knowledgeMapNode(`memory:${memoryKey}`, "memory", projectId, {
      memory_id: `mem-${memoryKey}`,
      label: `Fixture knowledge ${String(index).padStart(2, "0")}`,
      summary: `Synthetic shared knowledge for ${projectId} · scenario ${index}`,
      reference_count: 2 + (index % 6),
      net_saved_tokens: 90 + index * 11,
      utilization_rate: 0.35 + (index % 6) * 0.08
    }));
    if (index % 4 === 0) {
      nodes.push(knowledgeMapNode(`decision:fixture-${String(index).padStart(2, "0")}`, "decision", projectId, {
        memory_id: `mem-${memoryKey}`,
        decision_id: `rationale-fixture-${String(index).padStart(2, "0")}`,
        label: `Fixture decision ${String(index).padStart(2, "0")}`,
        summary: "Synthetic decision with a reviewable rationale"
      }));
    }
  }
  const link = (id, source, target, relation, values = {}) => ({ id, source, target, relation, directed: values.directed ?? true, inferred: values.inferred ?? false, weight: values.weight ?? 1, confidence: values.confidence ?? 0.94, cross_project: values.cross_project ?? false });
  const links = [
    link("tenant-project:org-brain", "tenant:default", "project:org-brain", "contains"),
    link("tenant-project:delivery-ops", "tenant:default", "project:delivery-ops", "contains"),
    link("project-memory:auth-acl", "project:org-brain", "memory:auth-acl", "contains"),
    link("project-memory:canonical-api", "project:org-brain", "memory:canonical-api", "contains"),
    link("project-memory:skill-publish", "project:org-brain", "memory:skill-publish", "contains"),
    link("project-memory:agent-loadout", "project:delivery-ops", "memory:agent-loadout", "contains"),
    link("project-memory:review-loop", "project:delivery-ops", "memory:review-loop", "contains"),
    link("memory-decision:api", "memory:canonical-api", "decision:rationale-e2e", "explains"),
    link("memory-decision:skill", "memory:skill-publish", "decision:skill-publish", "explains"),
    link("memory-decision:review", "memory:review-loop", "decision:review-loop", "explains"),
    link("memory-entity:auth", "memory:auth-acl", "entity:acl-policy", "references"),
    link("memory-entity:loadout", "memory:agent-loadout", "entity:acl-policy", "references", { cross_project: true }),
    link("memory-entity:release", "memory:review-loop", "entity:release-gate", "references"),
    link("decision-entity:skill", "decision:skill-publish", "entity:acl-policy", "supports"),
    link("decision-entity:review", "decision:review-loop", "entity:release-gate", "supports"),
    link("inferred:api-review", "decision:rationale-e2e", "decision:review-loop", "related", { inferred: true, confidence: 0.58, cross_project: true })
  ];
  for (const projectId of extraProjects.map((item) => item.id)) {
    links.push(link(`tenant-project:${projectId}`, "tenant:default", `project:${projectId}`, "contains"));
  }
  for (let index = 1; index <= 32; index += 1) {
    const projectId = projectIds[(index - 1) % projectIds.length];
    const memoryKey = `fixture-${String(index).padStart(2, "0")}`;
    const memoryNodeId = `memory:${memoryKey}`;
    links.push(link(`project-memory:${memoryKey}`, `project:${projectId}`, memoryNodeId, "contains"));
    if (index > 1) {
      const previousKey = `fixture-${String(index - 1).padStart(2, "0")}`;
      links.push(link(`memory-related:${previousKey}:${memoryKey}`, `memory:${previousKey}`, memoryNodeId, "related", {
        directed: false,
        inferred: index % 3 === 0,
        confidence: index % 3 === 0 ? 0.64 : 0.88,
        cross_project: projectIds[(index - 2) % projectIds.length] !== projectId
      }));
    }
    const entityId = extraEntitySpecs[(index - 1) % extraEntitySpecs.length][0];
    links.push(link(`memory-entity:${memoryKey}`, memoryNodeId, `entity:${entityId}`, "references", {
      inferred: index % 5 === 0,
      confidence: index % 5 === 0 ? 0.61 : 0.9,
      cross_project: projectId !== project
    }));
    if (index % 4 === 0) {
      const decisionId = `decision:fixture-${String(index).padStart(2, "0")}`;
      links.push(link(`memory-decision:${memoryKey}`, memoryNodeId, decisionId, "explains"));
      links.push(link(`decision-entity:${memoryKey}`, decisionId, `entity:${entityId}`, "supports", { cross_project: projectId !== project }));
    }
  }
  for (const projectNode of nodes.filter((node) => node.node_type === "project")) {
    const memberCount = nodes.filter((node) => node.project_id === projectNode.project_id && node.node_type !== "project").length;
    projectNode.member_count = memberCount;
    projectNode.reference_count = memberCount;
  }
  nodes[0].member_count = projectIds.length;
  nodes[0].reference_count = nodes.filter((node) => node.node_type === "memory").length;
  return {
    contract_version: "dashboard/v1",
    scope: "org",
    cluster_mode: false,
    total_count: nodes.length,
    visible_count: nodes.length,
    memory_visible_count: nodes.filter((node) => node.node_type === "memory").length,
    project_count: nodes.filter((node) => node.node_type === "project").length,
    entity_count: nodes.filter((node) => node.node_type === "entity").length,
    decision_count: nodes.filter((node) => node.node_type === "decision").length,
    related_count: nodes.length - 1,
    relationship_count: links.length,
    cross_project_link_count: links.filter((item) => item.cross_project).length,
    truncated: false,
    nodes,
    links,
    clusters: projectIds.map((projectId) => ({
      id: `cluster:${projectId}`,
      kind: "project",
      label: projectId,
      node_ids: nodes.filter((node) => node.project_id === projectId).map((node) => node.id)
    }))
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

const consoleDecisionId = "decision-console-e2e";
const consolePolicy = (resourceType, resourceId, storageLocation = "d1") => ({
  id: `policy:${resourceType}:${resourceId}`,
  tenant_id: "default",
  resource_type: resourceType,
  resource_id: resourceId,
  scope: "project",
  owner_principal: "user:e2e-login-sub",
  project_id: "org-brain",
  group_ids: [],
  restricted_subjects: [],
  storage_location: storageLocation,
  policy_version: 1,
  created_at: now,
  updated_at: now
});
const consoleBriefing = {
  contract_version: "decision-console/v1",
  generated_at: now,
  counts: { new: 1, changed: 1, expired: 0, unconfirmed: 0, artifact_missing: 0, share_pending: 0 },
  items: [{
    id: consoleDecisionId,
    project_id: "org-brain",
    title: "Keep decision context visible",
    decision: "Keep the active decision visible while people inspect evidence and apply it.",
    reason_summary: "This makes the decision and its rationale understandable before implementation details.",
    status: "active",
    confidence: 0.94,
    confirmation_state: "user_confirmed",
    valid_until: null,
    updated_at: now,
    artifact_count: 1,
    flags: ["new", "changed"],
    next_action: { label: "Open trace", action: "open", href: `/decisions/${consoleDecisionId}` }
  }],
  truncated: false
};

function consoleTrace(includeInferred = false) {
  const nodes = [
    { id: `decision:${consoleDecisionId}`, type: "decision", stage: "decision", label: "Keep decision context visible", summary: "Keep the active decision visible while people inspect evidence and apply it.", status: "active", deep_link: `/decisions/${consoleDecisionId}`, metadata: { version_hash: "e2e-source-hash" } },
    { id: `reason:${consoleDecisionId}`, type: "reason", stage: "reason", label: "Reason", summary: "This makes the decision and its rationale understandable before implementation details.", status: "user_confirmed", deep_link: null, metadata: {} },
    { id: "evidence:e2e", type: "evidence", stage: "evidence", label: "Verified usability note", summary: "Observed in moderated review", status: "active", deep_link: "/resources?selected=evidence-e2e", metadata: { version_hash: "evidence-hash" } },
    { id: "artifact:e2e", type: "artifact", stage: "artifact", label: "Console release checklist", summary: "Implementation artifact", status: "active", deep_link: "/resources?selected=artifact-e2e", metadata: {} },
    { id: "skill:skill-e2e", type: "skill", stage: "skill", label: "Decision rollout checklist", summary: "Apply the verified rollout safely", status: "published", deep_link: "/skills?skill_id=skill-e2e", metadata: {} },
    { id: "agent:agent-e2e", type: "agent", stage: "agent", label: "Release reviewer", summary: "Reviews a rollout before release", status: "active", deep_link: "/agents?agent_id=agent-e2e", metadata: {} },
    { id: "result:result-e2e", type: "result", stage: "result", label: "Validation passed", summary: "Release reviewer", status: "outcome", deep_link: null, metadata: { context_tokens: 72 } },
    ...(includeInferred ? [{ id: "inferred:e2e", type: "evidence", stage: "evidence", label: "Suggested follow-up", summary: "Proposed relationship", status: "proposal", deep_link: null, metadata: { confidence: 0.72 } }] : [])
  ];
  const edges = [
    { id: "decision-reason", source: `decision:${consoleDecisionId}`, target: `reason:${consoleDecisionId}`, relation: "explained_by", inferred: false },
    { id: "reason-evidence", source: `reason:${consoleDecisionId}`, target: "evidence:e2e", relation: "rationale_source", inferred: false },
    { id: "reason-artifact", source: `reason:${consoleDecisionId}`, target: "artifact:e2e", relation: "output_artifact", inferred: false },
    { id: "decision-skill", source: `decision:${consoleDecisionId}`, target: "skill:skill-e2e", relation: "generated_skill", inferred: false },
    { id: "skill-agent", source: "skill:skill-e2e", target: "agent:agent-e2e", relation: "bound:always", inferred: false },
    { id: "agent-result", source: "agent:agent-e2e", target: "result:result-e2e", relation: "usage_result", inferred: false },
    ...(includeInferred ? [{ id: "reason-inferred", source: `reason:${consoleDecisionId}`, target: "inferred:e2e", relation: "rationale_source", inferred: true }] : [])
  ];
  const stageNames = ["decision", "reason", "evidence", "artifact", "skill", "agent", "result"];
  return {
    contract_version: "decision-console/v1",
    generated_at: now,
    decision: {
      id: consoleDecisionId,
      project_id: "org-brain",
      title: "Keep decision context visible",
      decision: "Keep the active decision visible while people inspect evidence and apply it.",
      rationale: "This makes the decision and its rationale understandable before implementation details.",
      status: "active",
      confirmation_state: "user_confirmed",
      confidence: 0.94,
      valid_from: now - 86_400_000,
      valid_until: null,
      owner_refs: [{ type: "principal", id: "user:e2e-login-sub" }],
      reviewer_refs: [],
      version_hash: "e2e-source-hash"
    },
    access_policy: consolePolicy("decision_memory", consoleDecisionId),
    stages: Object.fromEntries(stageNames.map((stage) => [stage, nodes.filter((node) => node.stage === stage)])),
    nodes,
    edges,
    truncated: false,
    omitted_node_count: 0,
    omitted_edge_count: 0,
    include_inferred: includeInferred
  };
}

const consoleSkill = {
  id: "skill-e2e",
  tenant_id: "default",
  project_id: "org-brain",
  name: "Decision rollout checklist",
  description: "Apply the verified rollout safely",
  status: "published",
  current_version_id: "skill-e2e-v1",
  published_version_id: "skill-e2e-v1",
  source_decision_id: consoleDecisionId,
  owner_principal: "user:e2e-login-sub",
  valid_until: null,
  generation_task_id: null,
  created_at: now,
  updated_at: now,
  published_at: now
};
const consoleAgent = {
  id: "agent-e2e",
  tenant_id: "default",
  project_id: "org-brain",
  agent_key: "release-reviewer",
  name: "Release reviewer",
  role: "Reviews a rollout before release",
  status: "active",
  current_loadout_id: "loadout-e2e",
  source_decision_id: consoleDecisionId,
  owner_principal: "user:e2e-login-sub",
  last_used_at: now,
  created_at: now,
  updated_at: now,
  loadout_name: "Release checks",
  binding_count: 1
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

const domainPacks = domainPackCatalog(false);
const domainMetrics = [];
const domainDashboards = [];

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (path === "/health") {
    json(response, 200, { ok: true });
    return;
  }

  if (path === "/v1/capabilities" && request.method === "GET") {
    json(response, 200, ok({ domain_packs: { enabled: true, mode: "install" }, domain_metrics: { enabled: true, mode: "on" }, domain_workspaces: { enabled: true, mode: "on" }, pack_builder: { enabled: false, href: null, edition: "enterprise" } }));
    return;
  }
  if (path === "/v1/domain-packs" && request.method === "GET") {
    json(response, 200, ok((url.searchParams.get("tenant_id") || "").startsWith("workspace-") ? domainPackCatalog(true) : domainPacks));
    return;
  }
  const workspaceMatch = path.match(/^\/v1\/domain-packs\/(.+)\/workspace$/);
  if (workspaceMatch && request.method === "GET") {
    const tenantId = url.searchParams.get("tenant_id") || "";
    const workspace = workspaceFor(decodeURIComponent(workspaceMatch[1]));
    if (!workspace || !tenantId.startsWith("workspace-")) {
      json(response, 404, { ok: false, error: { code: "domain_pack_workspace_not_installed", message: "Workspace not found" } });
      return;
    }
    for (const source of workspace.source_readiness) source.tenant_id = tenantId;
    const sourceMode = tenantId.slice("workspace-".length);
    if (["unconfigured", "configured", "error", "stale"].includes(sourceMode)) {
      for (const source of workspace.source_readiness) {
        source.status = sourceMode === "stale" ? "active" : sourceMode;
        source.connection_ref = sourceMode === "unconfigured" ? null : source.connection_ref;
        source.last_success_at = sourceMode === "unconfigured" || sourceMode === "configured" || sourceMode === "error" ? null : source.last_success_at;
        source.last_error_code = sourceMode === "error" ? "upstream_unavailable" : null;
      }
      for (const metric of workspace.metric_groups.flatMap((group) => group.metrics)) {
        if (metric.origin_type === "custom") continue;
        metric.source.state = sourceMode === "stale" ? "active" : sourceMode;
        metric.source.last_error_code = sourceMode === "error" ? "upstream_unavailable" : null;
        if (["unconfigured", "configured", "error"].includes(sourceMode)) {
          metric.current = null;
          metric.outcome = null;
          metric.series = [];
          metric.delta = null;
          metric.status = sourceMode === "unconfigured" || sourceMode === "configured" ? "waiting" : "unknown";
        } else if (sourceMode === "stale" && metric.current) {
          metric.current = { ...metric.current, value: null, state: "stale" };
          metric.status = "stale";
        }
      }
    }
    json(response, 200, ok(workspace));
    return;
  }
  if (path === "/v1/domain-recalls/recall-build-e2e" && request.method === "GET") {
    json(response, 200, ok({
      contract_version: "domain-recall/v1",
      id: "recall-build-e2e",
      tenant_id: "workspace-demo",
      project_id: "org-brain",
      generated_at: now,
      query_hash: "a".repeat(64),
      summary: "checkout-webのCI変更に関連する確認済みDecision",
      primary: {
        recall_unit_id: "unit-build-e2e",
        pack_id: "function.build-engineering",
        role: "primary",
        score: { total: 0.91 },
        why_recalled: ["object exact", "intent matched"],
        scope: { repository: "checkout-web", pipeline: "ci-main" },
        decision: {
          id: "DEC-BUILD-2026-07-01",
          statement: "runnerを2台増やしintegration testを4 shardへ分割する",
          rationale: "遅延の大半がrunner待ちだったため",
          confirmation_state: "confirmed"
        },
        metrics: [{ metric_key: "build_duration_p95", value: 9.7, unit: "minutes", state: "measured" }],
        evidence: [{ id: "ci-report", title: "checkout-web CI 7日間レポート", source: "GitHub Actions", verification_state: "verified" }]
      },
      supporting: [],
      conflicts: [],
      warnings: []
    }));
    return;
  }
  if (path === "/v1/domain-packs/installations/plan" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 200, ok({
      plan_digest: "a".repeat(64), examples_loaded: false, warnings: [],
      packs: body.pack_ids.map((pack_id) => ({ pack_id, version: "1.0.0", action: "install", creates: { managed_object_types: 1, metric_definitions: 1, dashboards: 1, asset_references: 1, loadout_references: 0 }, preserved_custom_conflicts: { managed_object_types: [], metric_definitions: [], dashboards: [] }, connector_permissions: [] }))
    }));
    return;
  }
  if (path === "/v1/domain-packs/installations" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 201, ok({ installations: body.pack_ids.map((pack_id) => ({ pack_id, action: "installed" })), examples_loaded: false, plan_digest: body.plan_digest }));
    return;
  }
  if (path === "/v1/metrics/query" && request.method === "GET") {
    json(response, 200, ok(domainMetrics));
    return;
  }
  if (path === "/v1/metric-definitions" && request.method === "POST") {
    const body = await readJson(request);
    domainMetrics.push({ id: `metric-${domainMetrics.length + 1}`, metric_key: body.key, origin_type: "custom", definition: body, latest: { value: null, state: "unknown", evidence_ref: null } });
    json(response, 201, ok(domainMetrics.at(-1)));
    return;
  }
  if (path === "/v1/domain-dashboards" && request.method === "GET") {
    json(response, 200, ok(domainDashboards));
    return;
  }
  if (path === "/v1/domain-dashboards" && request.method === "POST") {
    const body = await readJson(request);
    domainDashboards.push({ id: `dashboard-${domainDashboards.length + 1}`, title: body.title, origin_type: "custom", definition: body });
    json(response, 201, ok(domainDashboards.at(-1)));
    return;
  }

  if (path === "/v1/decision-briefing" && request.method === "GET") {
    json(response, 200, ok(consoleBriefing));
    return;
  }

  if (path === `/v1/decisions/${consoleDecisionId}/trace` && request.method === "GET") {
    json(response, 200, ok(consoleTrace(url.searchParams.get("include_inferred") === "true")));
    return;
  }

  if (path === `/v1/decisions/${consoleDecisionId}/map` && request.method === "GET") {
    json(response, 200, ok(consoleTrace(url.searchParams.get("include_inferred") === "true")));
    return;
  }

  if (path === "/v1/skill-providers" && request.method === "GET") {
    json(response, 200, ok({ providers: [{ provider: "openai", available: true }] }));
    return;
  }

  if (path === "/v1/skills" && request.method === "GET") {
    json(response, 200, ok({ contract_version: "skill-assets/v1", items: [consoleSkill] }));
    return;
  }

  if (path === "/v1/skills" && request.method === "POST") {
    await readJson(request);
    json(response, 201, ok({ contract_version: "skill-assets/v1", asset: consoleSkill }));
    return;
  }

  if (path === "/v1/skills/generate" && request.method === "POST") {
    await readJson(request);
    json(response, 202, ok({
      contract_version: "skill-assets/v1",
      asset_id: "skill-generated-e2e",
      generation_run_id: "generation-e2e",
      task_id: "task-generation-e2e",
      status: "pending",
      private_draft: true,
      deduped: false
    }));
    return;
  }

  if (path === "/v1/skills/skill-e2e" && request.method === "GET") {
    json(response, 200, ok({
      contract_version: "skill-assets/v1",
      asset: consoleSkill,
      policy: consolePolicy("skill_asset", "skill-e2e", "d1_r2"),
      versions: [{
        id: "skill-e2e-v1",
        version: 1,
        schema_version: 1,
        content_hash: "skill-e2e-hash",
        validation: { schema: "passed" },
        manifest: {
          name: consoleSkill.name,
          description: consoleSkill.description,
          validation_conditions: ["All required checks report success"],
          files: [{ path: "SKILL.md", media_type: "text/markdown", content_hash: "skill-file-hash", size_bytes: 256 }]
        },
        files: [{ path: "SKILL.md", media_type: "text/markdown", content_hash: "skill-file-hash", size_bytes: 256 }],
        created_at: now
      }]
    }));
    return;
  }

  if (path === "/v1/skills/skill-e2e/publish" && request.method === "POST") {
    await readJson(request);
    json(response, 200, ok({ contract_version: "skill-assets/v1", asset: consoleSkill }));
    return;
  }

  if (path === "/v1/agents" && request.method === "GET") {
    json(response, 200, ok({ contract_version: "agent-loadouts/v1", items: [consoleAgent] }));
    return;
  }

  if (path === "/v1/agents" && request.method === "POST") {
    await readJson(request);
    json(response, 201, ok({ contract_version: "agent-loadouts/v1", agent: consoleAgent, loadout: { id: "loadout-e2e", name: "Release checks" } }));
    return;
  }

  if (path === "/v1/agents/agent-e2e" && request.method === "GET") {
    json(response, 200, ok({
      contract_version: "agent-loadouts/v1",
      agent: consoleAgent,
      loadout: { id: "loadout-e2e", tenant_id: "default", agent_id: "agent-e2e", name: "Release checks", description: "Release verification", status: "active", owner_principal: "user:e2e-login-sub", created_at: now, updated_at: now },
      bindings: [{
        id: "binding-e2e", skill_asset_id: "skill-e2e", usage_mode: "always", priority: 90,
        version_policy: "latest_published", pinned_version_id: null, valid_until: null,
        asset_name: consoleSkill.name, asset_description: consoleSkill.description,
        asset_status: "published", published_version_id: "skill-e2e-v1"
      }]
    }));
    return;
  }

  if (path === "/v1/agents/agent-e2e/loadouts/loadout-e2e" && request.method === "PUT") {
    await readJson(request);
    json(response, 200, ok({ contract_version: "agent-loadouts/v1", agent: consoleAgent }));
    return;
  }

  if (path === "/v1/agents/agent-e2e/context-preview" && request.method === "POST") {
    await readJson(request);
    json(response, 200, ok({
      contract_version: "agent-loadouts/v1",
      disabled: false,
      agent: { id: "agent-e2e", agent_key: "release-reviewer", name: "Release reviewer", status: "active" },
      loadout: { id: "loadout-e2e", name: "Release checks" },
      injected_skills: [{ skill_asset_id: "skill-e2e", version_id: "skill-e2e-v1", name: consoleSkill.name, usage_mode: "always", priority: 90, content: "# Decision rollout checklist", estimated_tokens: 72 }],
      on_demand_skills: [{ skill_asset_id: "skill-on-demand-e2e", version_id: "skill-on-demand-v1", name: "Optional diagnostics", priority: 30, handle: "orgbrain://skills/skill-on-demand-e2e/versions/skill-on-demand-v1" }],
      omitted: [{ skill_asset_id: "skill-retired-e2e", reason: "not_published" }],
      estimated_tokens: 72
    }));
    return;
  }

  const accessPolicyMatch = path.match(/^\/v1\/access-policies\/([^/]+)\/([^/]+)$/u);
  if (accessPolicyMatch && request.method === "GET") {
    const resourceType = decodeURIComponent(accessPolicyMatch[1]);
    const resourceId = decodeURIComponent(accessPolicyMatch[2]);
    json(response, 200, ok({
      contract_version: "resource-access-policy/v1",
      policy: consolePolicy(resourceType, resourceId, resourceType === "skill_asset" ? "d1_r2" : "d1"),
      utilizing_agents: resourceType === "skill_asset" ? [{ id: "agent-e2e", name: "Release reviewer", agent_key: "release-reviewer" }] : []
    }));
    return;
  }

  if (accessPolicyMatch && request.method === "PUT") {
    const body = await readJson(request);
    const resourceType = decodeURIComponent(accessPolicyMatch[1]);
    const resourceId = decodeURIComponent(accessPolicyMatch[2]);
    json(response, 200, ok({
      contract_version: "resource-access-policy/v1",
      policy: { ...consolePolicy(resourceType, resourceId, resourceType === "skill_asset" ? "d1_r2" : "d1"), ...body, policy_version: Number(body.expected_policy_version || 1) + 1 }
    }));
    return;
  }

  if (path === "/v1/decision-memories" && request.method === "POST") {
    const body = await readJson(request);
    json(response, 201, ok({ decisionMemory: { ...decisionMemory, ...body, id: "decision-created-e2e" } }));
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
    json(response, 200, ok(allKnowledgeMapFor(projectId)));
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
