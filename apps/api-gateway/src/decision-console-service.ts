import { DECISION_CONSOLE_CONTRACT_VERSION } from "@org-brain/contracts";
import { HttpError, sha256 } from "@org-brain/shared";
import {
  assertResourceReadable,
  canReadResourceWithGroups,
  loadAccessPolicies,
  loadPrincipalGroupIds
} from "./access-policy-service";
import { getDecisionResourceTrace } from "./resource-decision-service";
import type { Env } from "./types";

type DecisionRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  domain: string;
  title: string;
  decision: string;
  rationale: string;
  constraints_json: string;
  known_pitfalls_json: string;
  owner_refs_json: string;
  reviewer_refs_json: string;
  valid_from: number | null;
  valid_until: number | null;
  status: string;
  confidence: number;
  confirmation_state: string;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
};

type TraceNode = {
  id: string;
  type: "decision" | "reason" | "evidence" | "artifact" | "skill" | "agent" | "result";
  stage: "decision" | "reason" | "evidence" | "artifact" | "skill" | "agent" | "result";
  label: string;
  summary: string | null;
  status: string | null;
  deep_link: string | null;
  metadata: Record<string, unknown>;
};

type TraceEdge = {
  id: string;
  source: string;
  target: string;
  relation: string;
  inferred: boolean;
};

type VerifiedTraceMetadata = {
  verification_state: string;
  source_label: string | null;
  source_digest: string | null;
  evidence_count: number;
  missing_stages: string[];
  provenance_coverage: number;
  collector_key_id: string | null;
  extraction_profile_version: number | null;
};

function parseArray(raw: string): unknown[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function loadDecision(env: Env, tenantId: string, decisionId: string): Promise<DecisionRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, domain, title, decision, rationale,
            constraints_json, known_pitfalls_json, owner_refs_json, reviewer_refs_json,
            valid_from, valid_until, status, confidence, confirmation_state,
            confirmed_at, created_at, updated_at
     FROM decision_memories WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, decisionId).first<DecisionRow>();
  if (!row) throw new HttpError(404, "decision_not_found", "Decision not found");
  return row;
}

function nextAction(flags: string[], decisionId: string) {
  if (flags.includes("expired")) return { label: "Review validity", action: "review", href: `/decisions/${decisionId}#review` };
  if (flags.includes("unconfirmed")) return { label: "Confirm decision", action: "confirm", href: `/decisions/${decisionId}#review` };
  if (flags.includes("artifact_missing")) return { label: "Connect an artifact", action: "connect_artifact", href: `/decisions/${decisionId}#artifacts` };
  if (flags.includes("share_pending")) return { label: "Review access", action: "share", href: `/decisions/${decisionId}#access` };
  return { label: "Open trace", action: "open", href: `/decisions/${decisionId}` };
}

export async function getDecisionBriefing(
  env: Env,
  args: { tenantId: string; principal: string; projectId?: string | null; limit: number }
) {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, domain, title, decision, rationale,
            constraints_json, known_pitfalls_json, owner_refs_json, reviewer_refs_json,
            valid_from, valid_until, status, confidence, confirmation_state,
            confirmed_at, created_at, updated_at
     FROM decision_memories
     WHERE tenant_id = ? AND (? IS NULL OR project_id = ?)
     ORDER BY updated_at DESC LIMIT ?`
  ).bind(args.tenantId, args.projectId ?? null, args.projectId ?? null, Math.min(400, args.limit * 6)).all<DecisionRow>();
  const decisionIds = rows.results.map((row) => row.id);
  const [policies, groupIds, artifactRows] = await Promise.all([
    loadAccessPolicies(env, args.tenantId, "decision_memory", decisionIds),
    loadPrincipalGroupIds(env, args.tenantId, args.principal),
    decisionIds.length === 0
      ? Promise.resolve({ results: [] as Array<{ decision_id: string; count: number }> })
      : env.OPEN_BRAIN_DB.prepare(
        `SELECT subject_ref AS decision_id, COUNT(*) AS count
         FROM knowledge_assertions
         WHERE tenant_id = ? AND subject_type = 'decision_memory'
           AND subject_ref IN (SELECT value FROM json_each(?))
           AND assertion_type = 'relation' AND confirmation_state = 'confirmed'
           AND valid_until IS NULL
           AND predicate IN ('implementation_artifact', 'output_artifact', 'verification_artifact')
         GROUP BY subject_ref`
      ).bind(args.tenantId, JSON.stringify(decisionIds)).all<{ decision_id: string; count: number }>()
  ]);
  const artifactCounts = new Map(artifactRows.results.map((row) => [row.decision_id, Number(row.count)]));
  const now = Date.now();
  const items: Array<Record<string, unknown>> = [];
  let visibleCount = 0;
  const counts = { new: 0, changed: 0, expired: 0, unconfirmed: 0, artifact_missing: 0, share_pending: 0 };
  for (const decision of rows.results) {
    const policy = policies.get(decision.id) ?? null;
    if (!await canReadResourceWithGroups(env, policy, {
      tenantId: args.tenantId,
      principal: args.principal,
      projectId: args.projectId ?? decision.project_id
    }, groupIds)) continue;
    const artifactCount = artifactCounts.get(decision.id) ?? 0;
    const flags: string[] = [];
    if (now - decision.created_at <= 7 * 24 * 60 * 60 * 1000) flags.push("new");
    if (decision.updated_at - decision.created_at > 60_000) flags.push("changed");
    if (decision.valid_until !== null && decision.valid_until <= now) flags.push("expired");
    if (!["user_confirmed", "user_corrected", "reviewed"].includes(decision.confirmation_state)) flags.push("unconfirmed");
    if (artifactCount === 0) flags.push("artifact_missing");
    if (decision.project_id && policy?.scope === "private") flags.push("share_pending");
    for (const flag of flags) counts[flag as keyof typeof counts] += 1;
    visibleCount += 1;
    if (items.length < args.limit) {
      items.push({
        id: decision.id,
        project_id: decision.project_id,
        title: decision.title,
        decision: decision.decision,
        reason_summary: decision.rationale,
        status: decision.status,
        confidence: decision.confidence,
        confirmation_state: decision.confirmation_state,
        valid_until: decision.valid_until,
        updated_at: decision.updated_at,
        artifact_count: artifactCount,
        flags,
        next_action: nextAction(flags, decision.id)
      });
    }
  }
  const truncated = visibleCount > args.limit;
  return {
    contract_version: DECISION_CONSOLE_CONTRACT_VERSION,
    generated_at: now,
    counts,
    items,
    truncated
  };
}

async function decisionVersionHash(env: Env, tenantId: string, decisionId: string): Promise<string> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT snapshot_json FROM decision_memory_versions
     WHERE tenant_id = ? AND decision_memory_id = ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(tenantId, decisionId).first<{ snapshot_json: string }>();
  return sha256(row?.snapshot_json ?? decisionId);
}

async function loadVerifiedTraceMetadata(env: Env, tenantId: string, decisionId: string): Promise<VerifiedTraceMetadata | null> {
  try {
    const row = await env.OPEN_BRAIN_DB.prepare(
      "SELECT verification_state, source_digest, evidence_count, missing_stages_json, provenance_coverage, collector_key_id, extraction_profile_version, manifest_json FROM verified_ingestion_manifests WHERE tenant_id = ? AND projected_decision_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(tenantId, decisionId).first<{
      verification_state: string;
      source_digest: string | null;
      evidence_count: number;
      missing_stages_json: string | null;
      provenance_coverage: number;
      collector_key_id: string | null;
      extraction_profile_version: number | null;
      manifest_json: string | null;
    }>();
    if (!row) return null;
    let missingStages: string[] = [];
    try {
      const parsed = JSON.parse(row.missing_stages_json ?? "[]") as unknown;
      missingStages = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      missingStages = [];
    }
    let sourceLabel: string | null = null;
    try {
      const manifest = row.manifest_json ? JSON.parse(row.manifest_json) as Record<string, unknown> : null;
      const extractor = manifest?.extractor_ref && typeof manifest.extractor_ref === "object" && !Array.isArray(manifest.extractor_ref)
        ? manifest.extractor_ref as Record<string, unknown>
        : null;
      sourceLabel = typeof extractor?.name === "string" ? extractor.name : null;
    } catch {
      sourceLabel = null;
    }
    return {
      verification_state: row.verification_state,
      source_label: sourceLabel,
      source_digest: row.source_digest,
      evidence_count: Number(row.evidence_count ?? 0),
      missing_stages: missingStages,
      provenance_coverage: Number(row.provenance_coverage ?? 0),
      collector_key_id: row.collector_key_id,
      extraction_profile_version: row.extraction_profile_version === null ? null : Number(row.extraction_profile_version)
    };
  } catch {
    // Older installations can serve the trace before migration 0035 is applied.
    return null;
  }
}

export async function getDecisionTrace(
  env: Env,
  args: {
    tenantId: string;
    decisionId: string;
    principal: string;
    projectId?: string | null;
    includeInferred?: boolean;
    nodeLimit: number;
    edgeLimit: number;
  }
) {
  const decision = await loadDecision(env, args.tenantId, args.decisionId);
  const projectId = args.projectId ?? decision.project_id;
  const policy = await assertResourceReadable(env, {
    tenantId: args.tenantId,
    resourceType: "decision_memory",
    resourceId: decision.id,
    principal: args.principal,
    projectId
  });
  const resourceTrace = await getDecisionResourceTrace(env, args.tenantId, {
    source_type: "decision_memory",
    source_id: decision.id
  }, { principal: args.principal, projectId, accessMode: "defer" });
  const groupIds = await loadPrincipalGroupIds(env, args.tenantId, args.principal);
  const resourceItems = [...resourceTrace.sources, ...resourceTrace.artifacts];
  const resourcePolicies = await loadAccessPolicies(
    env,
    args.tenantId,
    "knowledge_resource",
    resourceItems.map((item) => item.resource.id)
  );
  const readableResourceIds = new Set<string>();
  for (const item of resourceItems) {
    if (await canReadResourceWithGroups(
      env,
      resourcePolicies.get(item.resource.id) ?? null,
      { tenantId: args.tenantId, principal: args.principal, projectId: projectId ?? item.resource.project_id },
      groupIds
    )) readableResourceIds.add(item.resource.id);
  }
  const versionHash = await decisionVersionHash(env, args.tenantId, decision.id);
  const verification = await loadVerifiedTraceMetadata(env, args.tenantId, decision.id);
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];
  const decisionNodeId = `decision:${decision.id}`;
  const reasonNodeId = `reason:${decision.id}`;
  nodes.push({
    id: decisionNodeId,
    type: "decision",
    stage: "decision",
    label: decision.title,
    summary: decision.decision,
    status: decision.status,
    deep_link: `/decisions/${decision.id}`,
    metadata: {
      project_id: decision.project_id,
      domain: decision.domain,
      confidence: decision.confidence,
      confirmation_state: decision.confirmation_state,
      version_hash: versionHash,
      ...(verification ?? {})
    }
  });
  nodes.push({
    id: reasonNodeId,
    type: "reason",
    stage: "reason",
    label: "Reason",
    summary: decision.rationale,
    status: decision.confirmation_state,
    deep_link: `/decisions/${decision.id}#reason`,
    metadata: { constraints: parseArray(decision.constraints_json), known_pitfalls: parseArray(decision.known_pitfalls_json), version_hash: versionHash, ...(verification ?? {}) }
  });
  edges.push({ id: `${decisionNodeId}->${reasonNodeId}`, source: decisionNodeId, target: reasonNodeId, relation: "explained_by", inferred: false });

  const sources = resourceTrace.sources.filter((item) => readableResourceIds.has(item.resource.id));
  const artifacts = resourceTrace.artifacts.filter((item) => readableResourceIds.has(item.resource.id));
  const explicitResourceNodeIds = new Set<string>();
  for (const item of sources) {
    const nodeId = `evidence:${item.resource.id}:${item.version?.id ?? "current"}`;
    if (!explicitResourceNodeIds.has(nodeId)) {
      explicitResourceNodeIds.add(nodeId);
      nodes.push({
        id: nodeId,
        type: "evidence",
        stage: "evidence",
        label: item.resource.title,
        summary: item.link.note,
        status: item.freshness,
        deep_link: `/resources?selected=${encodeURIComponent(item.resource.id)}`,
        metadata: {
          resource_id: item.resource.id,
          version_id: item.version?.id ?? null,
          version_hash: item.version?.content_hash ?? null,
          role: item.link.role,
          locator: item.link.locator
        }
      });
    }
    edges.push({ id: `${reasonNodeId}->${nodeId}:${item.link.role}`, source: reasonNodeId, target: nodeId, relation: item.link.role, inferred: false });
  }
  for (const item of artifacts) {
    const nodeId = `artifact:${item.resource.id}:${item.version?.id ?? "current"}`;
    if (!explicitResourceNodeIds.has(nodeId)) {
      explicitResourceNodeIds.add(nodeId);
      nodes.push({
        id: nodeId,
        type: "artifact",
        stage: "artifact",
        label: item.resource.title,
        summary: item.link.note,
        status: item.freshness,
        deep_link: `/resources?selected=${encodeURIComponent(item.resource.id)}`,
        metadata: {
          resource_id: item.resource.id,
          version_id: item.version?.id ?? null,
          version_hash: item.version?.content_hash ?? null,
          role: item.link.role
        }
      });
    }
    edges.push({ id: `${reasonNodeId}->${nodeId}:${item.link.role}`, source: reasonNodeId, target: nodeId, relation: item.link.role, inferred: false });
  }

  if (args.includeInferred) {
    const proposals = await env.OPEN_BRAIN_DB.prepare(
      `SELECT a.id, a.predicate, a.object_ref AS resource_id, a.confidence,
              r.project_id, r.title, r.current_version_id, r.lifecycle_state
       FROM knowledge_assertions a
       JOIN knowledge_resources r
         ON r.tenant_id = a.tenant_id AND r.id = a.object_ref
       WHERE a.tenant_id = ? AND a.subject_type = 'decision_memory' AND a.subject_ref = ?
         AND a.assertion_type = 'relation' AND a.object_type = 'knowledge_resource'
         AND a.confirmation_state = 'proposal'
         AND (a.valid_until IS NULL OR a.valid_until > ?)
       ORDER BY a.confidence DESC, a.updated_at DESC LIMIT 100`
    ).bind(args.tenantId, decision.id, Date.now()).all<{
      id: string;
      predicate: string;
      resource_id: string;
      confidence: number;
      project_id: string | null;
      title: string;
      current_version_id: string | null;
      lifecycle_state: string;
    }>();
    const proposalPolicies = await loadAccessPolicies(
      env,
      args.tenantId,
      "knowledge_resource",
      proposals.results.map((proposal) => proposal.resource_id)
    );
    for (const proposal of proposals.results) {
      if (readableResourceIds.has(proposal.resource_id)) continue;
      if (!await canReadResourceWithGroups(
        env,
        proposalPolicies.get(proposal.resource_id) ?? null,
        { tenantId: args.tenantId, principal: args.principal, projectId: projectId ?? proposal.project_id },
        groupIds
      )) continue;
      const stage = proposal.predicate.includes("artifact") ? "artifact" : "evidence";
      const nodeId = `inferred:${proposal.id}`;
      nodes.push({
        id: nodeId,
        type: stage,
        stage,
        label: proposal.title,
        summary: `Proposed relationship: ${proposal.predicate}`,
        status: "proposal",
        deep_link: `/resources?selected=${encodeURIComponent(proposal.resource_id)}`,
        metadata: {
          assertion_id: proposal.id,
          resource_id: proposal.resource_id,
          version_id: proposal.current_version_id,
          confidence: proposal.confidence,
          lifecycle_state: proposal.lifecycle_state
        }
      });
      edges.push({
        id: `${reasonNodeId}->${nodeId}`,
        source: reasonNodeId,
        target: nodeId,
        relation: proposal.predicate,
        inferred: true
      });
    }
  }

  const skillRows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, project_id, name, description, status, current_version_id,
            published_version_id, owner_principal, updated_at
     FROM skill_assets WHERE tenant_id = ? AND source_decision_id = ? AND status <> 'retired'
     ORDER BY updated_at DESC LIMIT 100`
  ).bind(args.tenantId, decision.id).all<{
    id: string; project_id: string | null; name: string; description: string; status: string;
    current_version_id: string | null; published_version_id: string | null; owner_principal: string; updated_at: number;
  }>();
  const skillPolicies = await loadAccessPolicies(
    env,
    args.tenantId,
    "skill_asset",
    skillRows.results.map((skill) => skill.id)
  );
  const visibleSkillIds = new Set<string>();
  for (const skill of skillRows.results) {
    const skillPolicy = skillPolicies.get(skill.id) ?? null;
    if (!await canReadResourceWithGroups(
      env,
      skillPolicy,
      { tenantId: args.tenantId, principal: args.principal, projectId: projectId ?? skill.project_id },
      groupIds
    )) continue;
    visibleSkillIds.add(skill.id);
    const nodeId = `skill:${skill.id}`;
    nodes.push({
      id: nodeId,
      type: "skill",
      stage: "skill",
      label: skill.name,
      summary: skill.description,
      status: skill.status,
      deep_link: `/skills?selected=${encodeURIComponent(skill.id)}`,
      metadata: { skill_asset_id: skill.id, current_version_id: skill.current_version_id, published_version_id: skill.published_version_id }
    });
    edges.push({ id: `${decisionNodeId}->${nodeId}`, source: decisionNodeId, target: nodeId, relation: "generated_skill", inferred: false });
  }

  if (visibleSkillIds.size > 0) {
    const bindingRows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT DISTINCT a.id, a.project_id, a.agent_key, a.name, a.role, a.status,
              a.last_used_at, l.id AS loadout_id, b.skill_asset_id, b.usage_mode
       FROM agent_loadout_bindings b
       JOIN agent_loadouts l ON l.tenant_id = b.tenant_id AND l.id = b.loadout_id AND l.status = 'active'
       JOIN agents a ON a.tenant_id = l.tenant_id AND a.id = l.agent_id AND a.status <> 'retired'
       WHERE b.tenant_id = ? AND b.skill_asset_id IN (SELECT value FROM json_each(?))
       ORDER BY a.name LIMIT 150`
    ).bind(args.tenantId, JSON.stringify([...visibleSkillIds])).all<{
      id: string; project_id: string | null; agent_key: string; name: string; role: string;
      status: string; last_used_at: number | null; loadout_id: string;
      skill_asset_id: string; usage_mode: string;
    }>();
    const [agentPolicies, loadoutPolicies] = await Promise.all([
      loadAccessPolicies(
        env,
        args.tenantId,
        "agent",
        bindingRows.results.map((agent) => agent.id)
      ),
      loadAccessPolicies(
        env,
        args.tenantId,
        "agent_loadout",
        bindingRows.results.map((agent) => agent.loadout_id)
      )
    ]);
    const visibleAgentIds = new Set<string>();
    for (const agent of bindingRows.results) {
      const agentPolicy = agentPolicies.get(agent.id) ?? null;
      if (!await canReadResourceWithGroups(
        env,
        agentPolicy,
        { tenantId: args.tenantId, principal: args.principal, projectId: projectId ?? agent.project_id },
        groupIds
      )) continue;
      if (!await canReadResourceWithGroups(
        env,
        loadoutPolicies.get(agent.loadout_id) ?? null,
        { tenantId: args.tenantId, principal: args.principal, projectId: projectId ?? agent.project_id },
        groupIds
      )) continue;
      const agentNodeId = `agent:${agent.id}`;
      if (!visibleAgentIds.has(agent.id)) {
        visibleAgentIds.add(agent.id);
        nodes.push({
          id: agentNodeId,
          type: "agent",
          stage: "agent",
          label: agent.name,
          summary: agent.role,
          status: agent.status,
          deep_link: `/agents?selected=${encodeURIComponent(agent.id)}`,
          metadata: { agent_key: agent.agent_key, last_used_at: agent.last_used_at }
        });
      }
      edges.push({
        id: `skill:${agent.skill_asset_id}->${agentNodeId}:${agent.loadout_id}:${agent.usage_mode}`,
        source: `skill:${agent.skill_asset_id}`,
        target: agentNodeId,
        relation: `bound:${agent.usage_mode}`,
        inferred: false
      });
    }
    const usageRows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, skill_asset_id, agent_id, agent_key, event_type, outcome,
              context_tokens, created_at
       FROM asset_usage_events
       WHERE tenant_id = ? AND skill_asset_id IN (SELECT value FROM json_each(?))
       ORDER BY created_at DESC LIMIT 100`
    ).bind(args.tenantId, JSON.stringify([...visibleSkillIds])).all<{
      id: string; skill_asset_id: string; agent_id: string | null; agent_key: string | null;
      event_type: string; outcome: string | null; context_tokens: number; created_at: number;
    }>();
    for (const usage of usageRows.results) {
      if (usage.agent_id && !visibleAgentIds.has(usage.agent_id)) continue;
      const nodeId = `result:${usage.id}`;
      nodes.push({
        id: nodeId,
        type: "result",
        stage: "result",
        label: usage.outcome || usage.event_type,
        summary: usage.agent_key ? `Agent ${usage.agent_key}` : null,
        status: usage.event_type,
        deep_link: null,
        metadata: { context_tokens: usage.context_tokens, created_at: usage.created_at }
      });
      const source = usage.agent_id ? `agent:${usage.agent_id}` : `skill:${usage.skill_asset_id}`;
      edges.push({ id: `${source}->${nodeId}`, source, target: nodeId, relation: "usage_result", inferred: false });
    }
  }

  const allowedNodeIds = new Set(nodes.slice(0, args.nodeLimit).map((node) => node.id));
  const limitedNodes = nodes.filter((node) => allowedNodeIds.has(node.id));
  const readableEdges = edges.filter((edge) =>
    allowedNodeIds.has(edge.source) && allowedNodeIds.has(edge.target) && (args.includeInferred || !edge.inferred)
  );
  const limitedEdges = readableEdges.slice(0, args.edgeLimit);
  const byStage = (stage: TraceNode["stage"]) => limitedNodes.filter((node) => node.stage === stage);
  return {
    contract_version: DECISION_CONSOLE_CONTRACT_VERSION,
    generated_at: Date.now(),
    decision: {
      id: decision.id,
      project_id: decision.project_id,
      title: decision.title,
      decision: decision.decision,
      rationale: decision.rationale,
      status: decision.status,
      confirmation_state: decision.confirmation_state,
      confidence: decision.confidence,
      valid_from: decision.valid_from,
      valid_until: decision.valid_until,
      owner_refs: parseArray(decision.owner_refs_json),
      reviewer_refs: parseArray(decision.reviewer_refs_json),
      version_hash: versionHash
    },
    access_policy: policy,
    stages: {
      decision: byStage("decision"),
      reason: byStage("reason"),
      evidence: byStage("evidence"),
      artifact: byStage("artifact"),
      skill: byStage("skill"),
      agent: byStage("agent"),
      result: byStage("result")
    },
    nodes: limitedNodes,
    edges: limitedEdges,
    truncated: nodes.length > limitedNodes.length || readableEdges.length > limitedEdges.length,
    omitted_node_count: Math.max(0, nodes.length - limitedNodes.length),
    omitted_edge_count: Math.max(0, readableEdges.length - limitedEdges.length),
    include_inferred: Boolean(args.includeInferred),
    resource_truncated: resourceTrace.truncated && readableResourceIds.size >= 200
  };
}

export async function getDecisionMap(env: Env, args: Parameters<typeof getDecisionTrace>[1]) {
  const trace = await getDecisionTrace(env, args);
  return {
    contract_version: trace.contract_version,
    generated_at: trace.generated_at,
    focus: { type: "decision", id: args.decisionId },
    nodes: trace.nodes,
    edges: trace.edges,
    truncated: trace.truncated,
    omitted_node_count: trace.omitted_node_count,
    omitted_edge_count: trace.omitted_edge_count,
    include_inferred: trace.include_inferred
  };
}
