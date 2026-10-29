import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerAssetAgentRoutes, type AssetAgentPort, type RouteAppEnv } from "@org-brain/server-core";
import { getAgent, listAgents, updateAgentLoadout } from "../src/agent-loadout-service";
import { getSkillAsset, listSkillAssets } from "../src/skill-asset-service";
import { memoryD1Fixture } from "./fixtures/memory-d1";

const caller = { tenantId: "tenant-a", principal: "user:runner" };

describe("console inventory pagination", () => {
  let fixture: ReturnType<typeof memoryD1Fixture>;

  beforeEach(() => { fixture = memoryD1Fixture(); });
  afterEach(() => { fixture.sql.close(); });

  function policy(type: string, id: string, readable = true) {
    fixture.sql.prepare(`INSERT INTO resource_access_policies(
      id, tenant_id, resource_type, resource_id, scope, owner_principal,
      created_by_principal, created_at, updated_at
    ) VALUES(?, 'tenant-a', ?, ?, ?, 'user:other', 'user:other', 1, 1)`)
      .run(`policy:${type}:${id}`, type, id, readable ? "tenant" : "private");
  }

  function agent(id: string, options: { readable?: boolean; loadoutReadable?: boolean; updated?: number; name?: string; role?: string } = {}) {
    fixture.sql.prepare(`INSERT INTO agents(
      id, tenant_id, agent_key, name, role, current_loadout_id, owner_principal, created_at, updated_at
    ) VALUES(?, 'tenant-a', ?, ?, ?, ?, 'user:runner', 1, ?)`)
      .run(id, `key-${id}`, options.name ?? `Agent ${id}`, options.role ?? "Review", `loadout:${id}`, options.updated ?? 1);
    fixture.sql.prepare(`INSERT INTO agent_loadouts(
      id, tenant_id, agent_id, name, owner_principal, created_at, updated_at
    ) VALUES(?, 'tenant-a', ?, 'Default', 'user:runner', 1, 1)`)
      .run(`loadout:${id}`, id);
    policy("agent", id, options.readable ?? true);
    policy("agent_loadout", `loadout:${id}`, options.loadoutReadable ?? true);
  }

  function skill(id: string, options: { readable?: boolean; status?: string; updated?: number; description?: string; projectId?: string } = {}) {
    fixture.sql.prepare(`INSERT INTO skill_assets(
      id, tenant_id, project_id, name, description, status, owner_principal, created_at, updated_at
    ) VALUES(?, 'tenant-a', ?, ?, ?, ?, 'user:runner', 1, ?)`)
      .run(id, options.projectId ?? null, `Skill ${id}`, options.description ?? "Review", options.status ?? "published", options.updated ?? 1);
    policy("skill_asset", id, options.readable ?? true);
  }

  function binding(agentId: string, skillId: string, pinned = false) {
    if (pinned) fixture.sql.prepare(`INSERT OR IGNORE INTO skill_asset_versions(
      id, tenant_id, skill_asset_id, version, manifest_json, content_hash, created_by_principal, created_at
    ) VALUES('version-original', 'tenant-a', ?, 1, '{}', 'original-hash', 'user:runner', 1)`).run(skillId);
    fixture.sql.prepare(`INSERT INTO agent_loadout_bindings(
      id, tenant_id, loadout_id, skill_asset_id, usage_mode, priority, version_policy,
      pinned_version_id, valid_until, created_by_principal, created_at, updated_at
    ) VALUES(?, 'tenant-a', ?, ?, 'always', 50, ?, ?, 123456, 'user:runner', 1, 1)`)
      .run(`binding:${agentId}:${skillId}`, `loadout:${agentId}`, skillId, pinned ? "pinned" : "latest_published", pinned ? "version-original" : null);
  }

  function newerPublishedVersion(skillId: string) {
    const versionId = `version-new:${skillId}`;
    fixture.sql.prepare(`INSERT INTO skill_asset_versions(
      id, tenant_id, skill_asset_id, version, manifest_json, content_hash, created_by_principal, created_at
    ) VALUES(?, 'tenant-a', ?, 2, '{}', ?, 'user:runner', 2)`).run(versionId, skillId, `hash:${versionId}`);
    fixture.sql.prepare("UPDATE skill_assets SET current_version_id = ?, published_version_id = ? WHERE id = ?")
      .run(versionId, versionId, skillId);
  }

  function replacePinnedBinding(agentId: string, skillId: string, versionId = "version-original") {
    return updateAgentLoadout(fixture.env, "tenant-a", agentId, `loadout:${agentId}`, {
      name: "Renamed Loadout",
      bindings: [{
        skill_asset_id: skillId, usage_mode: "always", priority: 80,
        version_policy: "pinned", pinned_version_id: versionId, valid_until: 123456
      }]
    }, { actorPrincipal: "user:runner", isAdmin: false });
  }

  it("pages more than 25 Agents in stable order and keeps direct details authorized", async () => {
    const ids = Array.from({ length: 31 }, (_, index) => `visible-${String(index).padStart(2, "0")}`);
    for (const id of [...ids].reverse()) agent(id);
    const first = await listAgents(fixture.env, { ...caller, limit: 25 });
    expect(first).toMatchObject({ has_more: true, next_offset: 25 });
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 25));
    const last = await listAgents(fixture.env, { ...caller, limit: 25, offset: 25 });
    expect(last).toMatchObject({ has_more: false, next_offset: null });
    expect(last.items.map((item) => item.id)).toEqual(ids.slice(25));
    await expect(getAgent(fixture.env, { ...caller, agentId: ids[30] })).resolves.toMatchObject({ agent: { id: ids[30] } });
    agent("denied", { readable: false });
    await expect(getAgent(fixture.env, { ...caller, agentId: "denied" })).rejects.toMatchObject({ status: 404 });
  });

  it("scans beyond 200 denied Agent candidates and offsets only readable Agents", async () => {
    agent("visible-first", { updated: 1000 });
    for (let index = 0; index < 230; index++) agent(`secret-${index}`, { readable: false, updated: 900 - index });
    agent("secret-loadout", { loadoutReadable: false, updated: 500 });
    agent("visible-last", { updated: 1 });
    skill("visible-binding");
    skill("secret-binding", { readable: false });
    binding("visible-first", "visible-binding");
    binding("visible-first", "secret-binding");

    const first = await listAgents(fixture.env, { ...caller, limit: 1 });
    expect(first).toMatchObject({ has_more: true, next_offset: 1, items: [{ id: "visible-first", binding_count: 1 }] });
    const last = await listAgents(fixture.env, { ...caller, limit: 1, offset: 1 });
    expect(last).toMatchObject({ has_more: false, next_offset: null, items: [{ id: "visible-last" }] });
    expect(JSON.stringify([first, last])).not.toContain("secret-");
    expect(first).not.toHaveProperty("total");
    expect(first).not.toHaveProperty("candidate_count");
    await expect(getAgent(fixture.env, { ...caller, agentId: "secret-loadout" })).rejects.toMatchObject({ status: 404 });
    await expect(listAgents(fixture.env, { ...caller, limit: 1, offset: 2 })).resolves.toMatchObject({ items: [], has_more: false, next_offset: null });
  });

  it("searches Agent name, key and role before paging", async () => {
    agent("key-match");
    agent("name-match", { name: "Special search target" });
    agent("role-match", { role: "Special search target" });
    agent("ordinary");
    expect((await listAgents(fixture.env, { ...caller, q: "  SPECIAL SEARCH  ", limit: 1, offset: 1 })).items.map((item) => item.id))
      .toEqual(["role-match"]);
    expect((await listAgents(fixture.env, { ...caller, q: "key-key-match" })).items.map((item) => item.id)).toEqual(["key-match"]);
  });

  it("pages Skills after ACL filtering while preserving q, status and project filters", async () => {
    const ids = Array.from({ length: 31 }, (_, index) => `visible-${String(index).padStart(2, "0")}`);
    for (const id of [...ids].reverse()) skill(id, { description: "Target phrase", projectId: "project-a" });
    skill("other-status", { description: "Target phrase", status: "draft", projectId: "project-a" });
    skill("other-text", { description: "Something else", projectId: "project-a" });
    skill("other-project", { description: "Target phrase", projectId: "project-b" });
    for (let index = 0; index < 230; index++) skill(`secret-${index}`, { readable: false, updated: 2, description: "Target phrase", projectId: "project-a" });
    const query = { ...caller, q: " TARGET PHRASE ", status: "published", projectId: "project-a", limit: 25 };
    const first = await listSkillAssets(fixture.env, query);
    expect(first).toMatchObject({ has_more: true, next_offset: 25, truncated: true });
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 25));
    const last = await listSkillAssets(fixture.env, { ...query, offset: 25 });
    expect(last).toMatchObject({ has_more: false, next_offset: null, truncated: false });
    expect(last.items.map((item) => item.id)).toEqual(ids.slice(25));
    expect(JSON.stringify([first, last])).not.toContain("secret-");
    expect(first).not.toHaveProperty("total");
    await expect(getSkillAsset(fixture.env, { ...caller, assetId: ids[30], projectId: "project-a" }))
      .resolves.toMatchObject({ asset: { id: ids[30] } });
    await expect(getSkillAsset(fixture.env, { ...caller, assetId: "secret-0", projectId: "project-a" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("redacts unreadable source decisions on later Agent and Skill pages", async () => {
    for (const id of ["readable-source", "hidden-source"]) {
      fixture.sql.prepare(`INSERT INTO decision_memories(
        id, tenant_id, title, decision, rationale, created_at, updated_at
      ) VALUES(?, 'tenant-a', 'Source', 'Decision', 'Rationale', 1, 1)`).run(id);
      policy("decision_memory", id, id === "readable-source");
    }
    for (const id of ["a", "b"]) {
      agent(id);
      skill(id);
      const source = id === "a" ? "readable-source" : "hidden-source";
      fixture.sql.prepare("UPDATE agents SET source_decision_id = ? WHERE id = ?").run(source, id);
      fixture.sql.prepare("UPDATE skill_assets SET source_decision_id = ? WHERE id = ?").run(source, id);
    }
    expect((await listAgents(fixture.env, { ...caller, limit: 1 })).items[0].source_decision_id).toBe("readable-source");
    expect((await listSkillAssets(fixture.env, { ...caller, limit: 1 })).items[0].source_decision_id).toBe("readable-source");
    expect((await listAgents(fixture.env, { ...caller, limit: 1, offset: 1 })).items[0].source_decision_id).toBeNull();
    expect((await listSkillAssets(fixture.env, { ...caller, limit: 1, offset: 1 })).items[0].source_decision_id).toBeNull();
  });

  it("marks replacement unsafe for partially hidden bindings without exposing them", async () => {
    agent("complete");
    agent("partial");
    skill("visible");
    skill("hidden", { readable: false });
    binding("complete", "visible", true);
    binding("partial", "visible", true);
    binding("partial", "hidden");
    const complete = await getAgent(fixture.env, { ...caller, agentId: "complete" });
    expect(complete).toMatchObject({ can_replace_bindings: true, bindings: [{ skill_asset_id: "visible", pinned_version_id: "version-original", valid_until: 123456 }] });
    const partial = await getAgent(fixture.env, { ...caller, agentId: "partial" });
    expect(partial).toMatchObject({ can_replace_bindings: false, bindings: [{ skill_asset_id: "visible" }] });
    expect(JSON.stringify(partial)).not.toContain("hidden");
    expect(partial).not.toHaveProperty("hidden_binding_count");
    expect(partial).not.toHaveProperty("total_bindings");
  });

  it("preserves an existing pin after a newer version is published when editing name and priority", async () => {
    agent("existing");
    skill("visible");
    binding("existing", "visible", true);
    newerPublishedVersion("visible");

    await expect(replacePinnedBinding("existing", "visible")).resolves.toMatchObject({
      loadout: { name: "Renamed Loadout" },
      bindings: [{ skill_asset_id: "visible", priority: 80, pinned_version_id: "version-original", valid_until: 123456 }]
    });
    expect(fixture.sql.prepare("SELECT priority, pinned_version_id, valid_until FROM agent_loadout_bindings WHERE loadout_id = ?")
      .get("loadout:existing")).toMatchObject({ priority: 80, pinned_version_id: "version-original", valid_until: 123456 });
  });

  it("rejects arbitrary old pins, pins from another loadout, and pins from another Skill", async () => {
    agent("existing");
    agent("other");
    skill("visible");
    skill("another");
    binding("existing", "visible", true);
    newerPublishedVersion("visible");
    newerPublishedVersion("another");
    fixture.sql.prepare(`INSERT INTO skill_asset_versions(
      id, tenant_id, skill_asset_id, version, manifest_json, content_hash, created_by_principal, created_at
    ) VALUES('version-unbound', 'tenant-a', 'visible', 3, '{}', 'unbound-hash', 'user:runner', 3)`).run();

    await expect(replacePinnedBinding("existing", "visible", "version-unbound"))
      .rejects.toMatchObject({ status: 409, code: "version_not_published" });
    await expect(replacePinnedBinding("other", "visible"))
      .rejects.toMatchObject({ status: 409, code: "version_not_published" });
    await expect(replacePinnedBinding("existing", "another"))
      .rejects.toMatchObject({ status: 409, code: "version_not_published" });
    expect(fixture.sql.prepare("SELECT pinned_version_id, priority FROM agent_loadout_bindings WHERE loadout_id = ?")
      .get("loadout:existing")).toMatchObject({ pinned_version_id: "version-original", priority: 50 });
  });

  it.each(["private", "retired", "draft", "archived"])("keeps %s rejection for an existing old pin", async (restriction) => {
    agent("existing");
    skill("visible");
    binding("existing", "visible", true);
    newerPublishedVersion("visible");
    if (restriction === "private") fixture.sql.prepare("UPDATE resource_access_policies SET scope = 'private' WHERE resource_type = 'skill_asset'").run();
    if (restriction === "retired") fixture.sql.prepare("UPDATE skill_assets SET status = 'retired'").run();
    if (restriction === "draft") fixture.sql.prepare("UPDATE skill_assets SET status = 'draft', published_version_id = NULL").run();
    if (restriction === "archived") fixture.sql.prepare("UPDATE agent_loadouts SET status = 'archived'").run();

    await expect(replacePinnedBinding("existing", "visible")).rejects.toMatchObject({
      status: restriction === "private" ? 404 : 409,
      code: restriction === "private" ? "resource_not_found" : restriction === "archived" ? "loadout_archived" : "skill_not_published"
    });
    expect(fixture.sql.prepare("SELECT pinned_version_id, priority FROM agent_loadout_bindings WHERE loadout_id = ?")
      .get("loadout:existing")).toMatchObject({ pinned_version_id: "version-original", priority: 50 });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])("rejects invalid offset %s", async (offset) => {
    await expect(listAgents(fixture.env, { ...caller, offset })).rejects.toMatchObject({ status: 400, code: "invalid_offset" });
    await expect(listSkillAssets(fixture.env, { ...caller, offset })).rejects.toMatchObject({ status: 400, code: "invalid_offset" });
  });

  it("wires optional search and offset through both existing GET routes", async () => {
    agent("a");
    agent("b");
    agent("aa", { name: "Unrelated" });
    skill("a");
    skill("b");
    const app = new Hono<RouteAppEnv>();
    registerAssetAgentRoutes(app, {
      assertDecisionConsoleEnabled: () => {},
      assertApiTenantAccess: () => "tenant-a",
      getApiPrincipal: () => "user:runner",
      jsonOk: (_context: unknown, data: unknown) => Response.json(data),
      listAgents,
      listSkillAssets
    } as unknown as AssetAgentPort<RouteAppEnv>);
    const agents = await app.request("/v1/agents?q=Agent&limit=1&offset=1", {}, fixture.env);
    expect(await agents.json()).toMatchObject({ items: [{ id: "b" }], has_more: false, next_offset: null });
    const skills = await app.request("/v1/skills?q=Skill&status=published&limit=1&offset=1", {}, fixture.env);
    expect(await skills.json()).toMatchObject({ items: [{ id: "b" }], has_more: false, next_offset: null });
  });
});
