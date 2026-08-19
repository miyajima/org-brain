import {
  AGENT_LOADOUT_CONTRACT_VERSION,
  agentContextPreviewSchema,
  agentCreateSchema,
  agentLoadoutUpdateSchema
} from "@org-brain/contracts";
import { HttpError, ulid } from "@org-brain/shared";
import {
  assertResourceReadable,
  canReadResource,
  canReadResourceWithGroups,
  ensureAccessPolicy,
  loadAccessPolicies,
  loadAccessPolicy,
  loadPrincipalGroupIds
} from "./access-policy-service";
import type { Env } from "./types";

type AgentRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  agent_key: string;
  name: string;
  role: string;
  status: "active" | "paused" | "retired";
  current_loadout_id: string | null;
  source_decision_id: string | null;
  owner_principal: string;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
};

type LoadoutRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  owner_principal: string;
  created_at: number;
  updated_at: number;
};

type BindingRow = {
  id: string;
  skill_asset_id: string;
  usage_mode: "always" | "auto" | "on_demand";
  priority: number;
  version_policy: "pinned" | "latest_published";
  pinned_version_id: string | null;
  valid_until: number | null;
  asset_name: string;
  asset_description: string;
  asset_status: string;
  asset_project_id: string | null;
  asset_valid_until: number | null;
  published_version_id: string | null;
};

function parseLimit(value: unknown, fallback = 50) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(100, Math.max(1, parsed)) : fallback;
}

function estimateTokens(value: string): number {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? Math.max(1, Math.ceil(normalized.length / 4)) : 0;
}

function relevance(query: string, name: string, description: string): number {
  const terms = [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))];
  if (terms.length === 0) return 0;
  const haystack = `${name} ${description}`.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) / terms.length;
}

async function loadAgentById(env: Env, tenantId: string, agentId: string): Promise<AgentRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, agent_key, name, role, status, current_loadout_id,
            source_decision_id, owner_principal, last_used_at, created_at, updated_at
     FROM agents WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, agentId).first<AgentRow>();
  if (!row) throw new HttpError(404, "agent_not_found", "Agent not found");
  return row;
}

async function loadAgentByKey(env: Env, tenantId: string, agentKey: string): Promise<AgentRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, agent_key, name, role, status, current_loadout_id,
            source_decision_id, owner_principal, last_used_at, created_at, updated_at
     FROM agents WHERE tenant_id = ? AND agent_key = ?`
  ).bind(tenantId, agentKey).first<AgentRow>();
  if (!row) throw new HttpError(404, "agent_not_found", "Agent not found");
  return row;
}

async function loadLoadout(env: Env, tenantId: string, loadoutId: string): Promise<LoadoutRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, agent_id, name, description, status, owner_principal, created_at, updated_at
     FROM agent_loadouts WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, loadoutId).first<LoadoutRow>();
  if (!row) throw new HttpError(404, "loadout_not_found", "Loadout not found");
  return row;
}

async function loadBindings(env: Env, tenantId: string, loadoutId: string): Promise<BindingRow[]> {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT b.id, b.skill_asset_id, b.usage_mode, b.priority, b.version_policy,
            b.pinned_version_id, b.valid_until, s.name AS asset_name,
            s.description AS asset_description, s.status AS asset_status,
            s.project_id AS asset_project_id, s.valid_until AS asset_valid_until,
            s.published_version_id
     FROM agent_loadout_bindings b
     JOIN skill_assets s ON s.tenant_id = b.tenant_id AND s.id = b.skill_asset_id
     WHERE b.tenant_id = ? AND b.loadout_id = ?
     ORDER BY b.priority DESC, s.name`
  ).bind(tenantId, loadoutId).all<BindingRow>();
  return rows.results;
}

async function readableSourceDecisionId(
  env: Env,
  agent: AgentRow,
  args: { principal: string; projectId?: string | null; isAdmin?: boolean }
): Promise<string | null> {
  if (!agent.source_decision_id) return null;
  const policy = await loadAccessPolicy(env, agent.tenant_id, "decision_memory", agent.source_decision_id);
  return await canReadResource(env, policy, {
    tenantId: agent.tenant_id,
    principal: args.principal,
    projectId: args.projectId ?? agent.project_id,
    isAdmin: args.isAdmin
  }) ? agent.source_decision_id : null;
}

async function readableBindings(
  env: Env,
  tenantId: string,
  bindings: BindingRow[],
  args: { principal: string; projectId?: string | null; isAdmin?: boolean }
): Promise<BindingRow[]> {
  if (bindings.length === 0) return [];
  const [policies, groupIds] = await Promise.all([
    loadAccessPolicies(env, tenantId, "skill_asset", bindings.map((binding) => binding.skill_asset_id)),
    loadPrincipalGroupIds(env, tenantId, args.principal)
  ]);
  const visible: BindingRow[] = [];
  for (const binding of bindings) {
    if (await canReadResourceWithGroups(
      env,
      policies.get(binding.skill_asset_id) ?? null,
      {
        tenantId,
        principal: args.principal,
        projectId: args.projectId ?? binding.asset_project_id,
        isAdmin: args.isAdmin
      },
      groupIds
    )) visible.push(binding);
  }
  return visible;
}

async function skillMarkdown(env: Env, tenantId: string, versionId: string): Promise<string | null> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT r2_key FROM skill_asset_files
     WHERE tenant_id = ? AND skill_asset_version_id = ? AND lower(path) = 'skill.md'
     LIMIT 1`
  ).bind(tenantId, versionId).first<{ r2_key: string }>();
  if (!row) return null;
  const object = await env.OPEN_BRAIN_BUCKET.get(row.r2_key);
  return object ? object.text() : null;
}

export async function createAgent(
  env: Env,
  rawBody: unknown,
  options: { tenantId: string; actorPrincipal: string }
) {
  const parsed = agentCreateSchema.safeParse(rawBody);
  if (!parsed.success) throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid Agent");
  const input = parsed.data;
  if (input.source_decision_id) {
    await assertResourceReadable(env, {
      tenantId: options.tenantId,
      resourceType: "decision_memory",
      resourceId: input.source_decision_id,
      principal: options.actorPrincipal,
      projectId: input.project_id
    });
  }
  const now = Date.now();
  const agentId = ulid();
  const loadoutId = ulid();
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO agents(
        id, tenant_id, project_id, agent_key, name, role, status, current_loadout_id,
        source_decision_id, owner_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,'active',?,?,?,?,?)`
    ).bind(
      agentId, options.tenantId, input.project_id ?? null, input.agent_key, input.name,
      input.role, loadoutId, input.source_decision_id ?? null, options.actorPrincipal, now, now
    ),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO agent_loadouts(
        id, tenant_id, agent_id, name, description, status, owner_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,'active',?,?,?)`
    ).bind(loadoutId, options.tenantId, agentId, input.loadout_name, "", options.actorPrincipal, now, now)
  ]);
  await ensureAccessPolicy(env, {
    tenantId: options.tenantId,
    resourceType: "agent",
    resourceId: agentId,
    scope: "private",
    ownerPrincipal: options.actorPrincipal,
    projectId: input.project_id ?? null,
    actorPrincipal: options.actorPrincipal
  });
  await ensureAccessPolicy(env, {
    tenantId: options.tenantId,
    resourceType: "agent_loadout",
    resourceId: loadoutId,
    scope: "private",
    ownerPrincipal: options.actorPrincipal,
    projectId: input.project_id ?? null,
    actorPrincipal: options.actorPrincipal
  });
  return { contract_version: AGENT_LOADOUT_CONTRACT_VERSION, agent: await loadAgentById(env, options.tenantId, agentId), loadout: await loadLoadout(env, options.tenantId, loadoutId) };
}

export async function listAgents(
  env: Env,
  args: { tenantId: string; principal: string; projectId?: string | null; limit?: number }
) {
  const limit = parseLimit(args.limit);
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, agent_key, name, role, status, current_loadout_id,
            source_decision_id, owner_principal, last_used_at, created_at, updated_at
     FROM agents WHERE tenant_id = ? AND (? IS NULL OR project_id = ?)
     ORDER BY updated_at DESC LIMIT ?`
  ).bind(args.tenantId, args.projectId ?? null, args.projectId ?? null, Math.min(200, limit * 4)).all<AgentRow>();
  const visible = [] as Array<AgentRow & { loadout_name: string | null; binding_count: number }>;
  for (const agent of rows.results) {
    const policy = await loadAccessPolicy(env, args.tenantId, "agent", agent.id);
    if (!await canReadResource(env, policy, { tenantId: args.tenantId, principal: args.principal, projectId: args.projectId ?? agent.project_id })) continue;
    if (agent.current_loadout_id) {
      const loadoutPolicy = await loadAccessPolicy(env, args.tenantId, "agent_loadout", agent.current_loadout_id);
      if (!await canReadResource(env, loadoutPolicy, {
        tenantId: args.tenantId,
        principal: args.principal,
        projectId: args.projectId ?? agent.project_id
      })) continue;
    }
    const summary = agent.current_loadout_id ? await env.OPEN_BRAIN_DB.prepare(
      `SELECT name FROM agent_loadouts WHERE tenant_id = ? AND id = ?`
    ).bind(args.tenantId, agent.current_loadout_id).first<{ name: string }>() : null;
    const bindingCount = agent.current_loadout_id
      ? (await readableBindings(
        env,
        args.tenantId,
        await loadBindings(env, args.tenantId, agent.current_loadout_id),
        { principal: args.principal, projectId: args.projectId }
      )).length
      : 0;
    visible.push({
      ...agent,
      source_decision_id: await readableSourceDecisionId(env, agent, {
        principal: args.principal,
        projectId: args.projectId
      }),
      loadout_name: summary?.name ?? null,
      binding_count: bindingCount
    });
    if (visible.length >= limit) break;
  }
  return { contract_version: AGENT_LOADOUT_CONTRACT_VERSION, items: visible };
}

export async function getAgent(
  env: Env,
  args: { tenantId: string; agentId: string; principal: string; projectId?: string | null }
) {
  const agent = await loadAgentById(env, args.tenantId, args.agentId);
  await assertResourceReadable(env, {
    tenantId: args.tenantId,
    resourceType: "agent",
    resourceId: agent.id,
    principal: args.principal,
    projectId: args.projectId ?? agent.project_id
  });
  const loadout = agent.current_loadout_id ? await loadLoadout(env, args.tenantId, agent.current_loadout_id) : null;
  if (loadout) {
    await assertResourceReadable(env, {
      tenantId: args.tenantId,
      resourceType: "agent_loadout",
      resourceId: loadout.id,
      principal: args.principal,
      projectId: args.projectId ?? agent.project_id
    });
  }
  const bindings = loadout
    ? await readableBindings(
      env,
      args.tenantId,
      await loadBindings(env, args.tenantId, loadout.id),
      { principal: args.principal, projectId: args.projectId }
    )
    : [];
  return {
    contract_version: AGENT_LOADOUT_CONTRACT_VERSION,
    agent: {
      ...agent,
      source_decision_id: await readableSourceDecisionId(env, agent, {
        principal: args.principal,
        projectId: args.projectId
      })
    },
    loadout,
    bindings
  };
}

export async function updateAgent(
  env: Env,
  tenantId: string,
  agentId: string,
  rawBody: unknown,
  options: { actorPrincipal: string; isAdmin: boolean }
) {
  const agent = await loadAgentById(env, tenantId, agentId);
  await assertResourceReadable(env, {
    tenantId,
    resourceType: "agent",
    resourceId: agent.id,
    principal: options.actorPrincipal,
    projectId: agent.project_id,
    isAdmin: options.isAdmin
  });
  if (!options.isAdmin && agent.owner_principal !== options.actorPrincipal) throw new HttpError(403, "forbidden", "Only the owner or tenant admin can update an Agent");
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) throw new HttpError(400, "invalid_payload", "Request body must be an object");
  const body = rawBody as Record<string, unknown>;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : agent.name;
  const role = typeof body.role === "string" && body.role.trim() ? body.role.trim().slice(0, 500) : agent.role;
  const status = body.status === "active" || body.status === "paused" || body.status === "retired" ? body.status : agent.status;
  const sourceDecisionId = body.source_decision_id === null || typeof body.source_decision_id === "string" ? body.source_decision_id : agent.source_decision_id;
  if (sourceDecisionId) {
    await assertResourceReadable(env, {
      tenantId,
      resourceType: "decision_memory",
      resourceId: sourceDecisionId,
      principal: options.actorPrincipal,
      projectId: agent.project_id,
      isAdmin: options.isAdmin
    });
  }
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE agents SET name = ?, role = ?, status = ?, source_decision_id = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  ).bind(name, role, status, sourceDecisionId, Date.now(), tenantId, agentId).run();
  return { contract_version: AGENT_LOADOUT_CONTRACT_VERSION, agent: await loadAgentById(env, tenantId, agentId) };
}

export async function updateAgentLoadout(
  env: Env,
  tenantId: string,
  agentId: string,
  loadoutId: string,
  rawBody: unknown,
  options: { actorPrincipal: string; isAdmin: boolean }
) {
  const parsed = agentLoadoutUpdateSchema.safeParse(rawBody);
  if (!parsed.success) throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid Loadout");
  const agent = await loadAgentById(env, tenantId, agentId);
  const loadout = await loadLoadout(env, tenantId, loadoutId);
  if (loadout.agent_id !== agent.id) throw new HttpError(404, "loadout_not_found", "Loadout not found");
  await assertResourceReadable(env, {
    tenantId,
    resourceType: "agent",
    resourceId: agent.id,
    principal: options.actorPrincipal,
    projectId: agent.project_id,
    isAdmin: options.isAdmin
  });
  await assertResourceReadable(env, {
    tenantId,
    resourceType: "agent_loadout",
    resourceId: loadout.id,
    principal: options.actorPrincipal,
    projectId: agent.project_id,
    isAdmin: options.isAdmin
  });
  if (!options.isAdmin && agent.owner_principal !== options.actorPrincipal) throw new HttpError(403, "forbidden", "Only the owner or tenant admin can update a Loadout");
  if (loadout.status !== "active") throw new HttpError(409, "loadout_archived", "Archived Loadouts cannot be updated");
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.OPEN_BRAIN_DB.prepare(`DELETE FROM agent_loadout_bindings WHERE tenant_id = ? AND loadout_id = ?`).bind(tenantId, loadoutId)
  ];
  const seen = new Set<string>();
  for (const binding of parsed.data.bindings) {
    if (seen.has(binding.skill_asset_id)) throw new HttpError(400, "duplicate_binding", "A Skill can appear only once in a Loadout");
    seen.add(binding.skill_asset_id);
    const skill = await env.OPEN_BRAIN_DB.prepare(
      `SELECT status, published_version_id FROM skill_assets WHERE tenant_id = ? AND id = ?`
    ).bind(tenantId, binding.skill_asset_id).first<{ status: string; published_version_id: string | null }>();
    if (!skill || skill.status === "retired" || !skill.published_version_id) throw new HttpError(409, "skill_not_published", "Only published Skills can be added to a Loadout");
    await assertResourceReadable(env, {
      tenantId,
      resourceType: "skill_asset",
      resourceId: binding.skill_asset_id,
      principal: options.actorPrincipal,
      projectId: agent.project_id
    });
    if (binding.version_policy === "pinned" && binding.pinned_version_id !== skill.published_version_id) {
      throw new HttpError(409, "version_not_published", "Pinned version must be the published Skill version");
    }
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO agent_loadout_bindings(
        id, tenant_id, loadout_id, skill_asset_id, usage_mode, priority,
        version_policy, pinned_version_id, valid_until, created_by_principal, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      ulid(), tenantId, loadoutId, binding.skill_asset_id, binding.usage_mode,
      binding.priority, binding.version_policy, binding.pinned_version_id ?? null,
      binding.valid_until ?? null, options.actorPrincipal, now, now
    ));
  }
  statements.push(
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE agent_loadouts SET name = ?, description = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(parsed.data.name ?? loadout.name, parsed.data.description ?? loadout.description, now, tenantId, loadoutId),
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE agents SET current_loadout_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(loadoutId, now, tenantId, agentId)
  );
  await env.OPEN_BRAIN_DB.batch(statements);
  return getAgent(env, { tenantId, agentId, principal: options.actorPrincipal, projectId: agent.project_id });
}

export async function resolveAgentLoadoutContext(
  env: Env,
  args: {
    tenantId: string;
    agentKey: string;
    principal: string;
    projectId?: string | null;
    taskText: string;
    maxTokens?: number;
    recordUsage?: boolean;
    usageEvent?: "previewed" | "resolved";
    enforceRuntimeFlag?: boolean;
  }
) {
  if (args.enforceRuntimeFlag && !["beta", "on"].includes(env.LOADOUT_RESOLUTION_MODE ?? "off")) {
    return {
      contract_version: AGENT_LOADOUT_CONTRACT_VERSION,
      disabled: true,
      agent: null,
      injected_skills: [],
      on_demand_skills: [],
      omitted: []
    };
  }
  const parsed = agentContextPreviewSchema.parse({
    task_text: args.taskText,
    max_tokens: args.maxTokens ?? 8000,
    record_usage: args.recordUsage ?? false
  });
  const agent = await loadAgentByKey(env, args.tenantId, args.agentKey);
  await assertResourceReadable(env, {
    tenantId: args.tenantId,
    resourceType: "agent",
    resourceId: agent.id,
    principal: args.principal,
    projectId: args.projectId ?? agent.project_id
  });
  if (agent.status !== "active" || !agent.current_loadout_id) {
    return {
      contract_version: AGENT_LOADOUT_CONTRACT_VERSION,
      disabled: false,
      agent: { id: agent.id, agent_key: agent.agent_key, name: agent.name, status: agent.status },
      injected_skills: [],
      on_demand_skills: [],
      omitted: agent.status === "active" ? [] : [{ reason: "agent_not_active" }]
    };
  }
  const loadout = await loadLoadout(env, args.tenantId, agent.current_loadout_id);
  await assertResourceReadable(env, {
    tenantId: args.tenantId,
    resourceType: "agent_loadout",
    resourceId: loadout.id,
    principal: args.principal,
    projectId: args.projectId ?? agent.project_id
  });
  if (loadout.status !== "active") {
    return {
      contract_version: AGENT_LOADOUT_CONTRACT_VERSION,
      disabled: false,
      agent: { id: agent.id, agent_key: agent.agent_key, name: agent.name, status: agent.status },
      loadout: { id: loadout.id, name: loadout.name },
      injected_skills: [],
      on_demand_skills: [],
      omitted: [{ reason: "loadout_not_active" }],
      estimated_tokens: 0
    };
  }
  const bindings = await loadBindings(env, args.tenantId, loadout.id);
  const now = Date.now();
  const injected = [] as Array<Record<string, unknown>>;
  const onDemand = [] as Array<Record<string, unknown>>;
  const omitted = [] as Array<{ skill_asset_id: string; reason: string }>;
  const usageStatements: D1PreparedStatement[] = [];
  let usedTokens = 0;
  for (const binding of bindings) {
    if (binding.asset_status !== "published" || !binding.published_version_id) {
      omitted.push({ skill_asset_id: binding.skill_asset_id, reason: "not_published" });
      continue;
    }
    if ((binding.valid_until && binding.valid_until <= now) || (binding.asset_valid_until && binding.asset_valid_until <= now)) {
      omitted.push({ skill_asset_id: binding.skill_asset_id, reason: "expired" });
      continue;
    }
    const policy = await loadAccessPolicy(env, args.tenantId, "skill_asset", binding.skill_asset_id);
    if (!await canReadResource(env, policy, {
      tenantId: args.tenantId,
      principal: args.principal,
      projectId: args.projectId ?? binding.asset_project_id
    })) {
      omitted.push({ skill_asset_id: binding.skill_asset_id, reason: "access_denied" });
      continue;
    }
    const versionId = binding.version_policy === "pinned" ? binding.pinned_version_id : binding.published_version_id;
    if (!versionId) {
      omitted.push({ skill_asset_id: binding.skill_asset_id, reason: "version_unavailable" });
      continue;
    }
    const handle = `orgbrain://skills/${binding.skill_asset_id}/versions/${versionId}`;
    if (binding.usage_mode === "on_demand") {
      onDemand.push({
        skill_asset_id: binding.skill_asset_id,
        version_id: versionId,
        name: binding.asset_name,
        description: binding.asset_description,
        priority: binding.priority,
        handle
      });
      if (args.recordUsage) usageStatements.push(env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO asset_usage_events(
          id, tenant_id, project_id, skill_asset_id, skill_asset_version_id,
          agent_id, agent_key, event_type, context_tokens, metadata_json, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        ulid(), args.tenantId, args.projectId ?? agent.project_id, binding.skill_asset_id,
        versionId, agent.id, agent.agent_key, "listed", 0,
        JSON.stringify({ usage_mode: binding.usage_mode, handle }), now
      ));
      continue;
    }
    if (binding.usage_mode === "auto" && relevance(parsed.task_text, binding.asset_name, binding.asset_description) <= 0) {
      omitted.push({ skill_asset_id: binding.skill_asset_id, reason: "not_relevant" });
      continue;
    }
    const markdown = await skillMarkdown(env, args.tenantId, versionId);
    if (!markdown) {
      omitted.push({ skill_asset_id: binding.skill_asset_id, reason: "file_unavailable" });
      continue;
    }
    const tokens = estimateTokens(markdown);
    if (usedTokens + tokens > parsed.max_tokens) {
      omitted.push({ skill_asset_id: binding.skill_asset_id, reason: "token_budget" });
      continue;
    }
    usedTokens += tokens;
    injected.push({
      skill_asset_id: binding.skill_asset_id,
      version_id: versionId,
      name: binding.asset_name,
      description: binding.asset_description,
      usage_mode: binding.usage_mode,
      priority: binding.priority,
      content: markdown,
      estimated_tokens: tokens,
      handle
    });
    if (args.recordUsage) usageStatements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO asset_usage_events(
        id, tenant_id, project_id, skill_asset_id, skill_asset_version_id,
        agent_id, agent_key, event_type, context_tokens, metadata_json, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      ulid(), args.tenantId, args.projectId ?? agent.project_id, binding.skill_asset_id,
      versionId, agent.id, agent.agent_key, args.usageEvent ?? "resolved", tokens,
      JSON.stringify({ usage_mode: binding.usage_mode, priority: binding.priority }), now
    ));
  }
  if (args.recordUsage) {
    usageStatements.push(env.OPEN_BRAIN_DB.prepare(
      `UPDATE agents SET last_used_at = ?, updated_at = MAX(updated_at, ?) WHERE tenant_id = ? AND id = ?`
    ).bind(now, now, args.tenantId, agent.id));
    await env.OPEN_BRAIN_DB.batch(usageStatements);
  }
  return {
    contract_version: AGENT_LOADOUT_CONTRACT_VERSION,
    disabled: false,
    agent: { id: agent.id, agent_key: agent.agent_key, name: agent.name, role: agent.role, status: agent.status },
    loadout: { id: loadout.id, name: loadout.name },
    injected_skills: injected,
    on_demand_skills: onDemand,
    omitted,
    estimated_tokens: usedTokens
  };
}
