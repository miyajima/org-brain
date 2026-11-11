import { describe, expect, it } from "vitest";
import { memoryD1Fixture } from "./fixtures/memory-d1";
import { handleOrgBrainMcpRequest } from "../src/mcp";
import {
  getSharedKnowledge, publishSharedVersion, requestSharedPublication, revokeSharedKnowledge,
  searchSharedKnowledge, setTeamShare, sharedKnowledgeForSearch, sharedSearchTerms, teamKnowledgeEventVersions, teamKnowledgeInbox,
  watchSharedKnowledge
} from "../src/team-knowledge-service";
import { estimateTextTokens } from "../src/token-estimate";

type Delivery = {
  id: string; share_id: string; company_id: string; source_tenant_id: string; resource_type: string; resource_id: string;
  revision: string | null; viewer_tenant_id: string; viewer_principal: string; access_path: string; rank: number;
  injected_token_estimate: number; query_hash: string; created_at: number;
};
const queryHash = async (query: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query.trim().toLowerCase())))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");

function setup() {
  const { env, sql } = memoryD1Fixture();
  env.TEAM_KNOWLEDGE_ENABLED = "true";
  sql.exec(`
    INSERT INTO team_knowledge_tenants(tenant_id, company_id) VALUES ('a','corp'), ('b','corp'), ('c','corp'), ('d','other');
    INSERT INTO user_profiles(tenant_id,principal,display_name,created_at,updated_at)
      VALUES ('a','owner','Owner',1,1), ('a','member','Member',1,1), ('a','exec','Executive',1,1),
             ('b','manager','Manager',1,1), ('c','other','Other',1,1), ('d','outsider','Outsider',1,1);
    INSERT INTO team_knowledge_roles(tenant_id,principal,rank) VALUES ('a','owner',2), ('a','exec',3), ('b','manager',2), ('c','other',2), ('d','outsider',2);
    INSERT INTO team_knowledge_admins(company_id,tenant_id,principal) VALUES ('corp','a','exec');
    INSERT INTO memories(id,tenant_id,content,source,created_at,owner_principal,scope_type,scope_key,current_version)
      VALUES ('m','a','strategy initial','manual',1,'owner','user','owner',1);
    INSERT INTO resource_access_policies(id,tenant_id,resource_type,resource_id,scope,owner_principal,created_by_principal,created_at,updated_at)
      VALUES ('p','a','memory','m','private','owner','owner',1,1);
  `);
  const actor = (tenantId: string, principal: string) => ({ tenantId, principal });
  const owner = actor("a", "owner");
  const admin = actor("a", "exec");
  const manager = actor("b", "manager");
  const member = actor("a", "member");
  return { env, sql, actor, owner, admin, manager, member };
}

describe("team knowledge", () => {
  it("limits role shares to the selected tenants and revokes stale links immediately", async () => {
    const { env, sql, actor, owner, admin, manager, member } = setup();
    const input = { type: "memory" as const, id: "m", expectedPolicyVersion: 1, minimumRank: 2, targets: ["b"] };
    const share = await setTeamShare(env, owner, input);
    expect(await sharedKnowledgeForSearch(env, manager, { q:"strategy", scope:"mine" })).toEqual({});
    expect(await sharedKnowledgeForSearch(env, manager, { q:"strategy", project_id:"restricted" })).toEqual({});
    expect(await sharedKnowledgeForSearch(env, manager, { q:"strategy" })).toMatchObject({ shared_knowledge:[{id:share.id}] });
    for (const viewer of [owner, admin, manager]) {
      expect(await searchSharedKnowledge(env, viewer, "strategy")).toMatchObject([{ id: share.id }]);
    }
    for (const viewer of [member, actor("c", "other"), actor("d", "outsider")]) {
      expect(await searchSharedKnowledge(env, viewer, "strategy")).toEqual([]);
      await expect(getSharedKnowledge(env, viewer, share.id)).rejects.toMatchObject({ status: 404 });
    }
    sql.exec("UPDATE team_knowledge_roles SET rank = 1 WHERE tenant_id = 'b' AND principal = 'manager'");
    expect(await searchSharedKnowledge(env, manager, "strategy")).toEqual([]);
    sql.exec("UPDATE resource_access_policies SET policy_version = 2 WHERE id = 'p'");
    await expect(getSharedKnowledge(env, owner, share.id)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the approved version in All and notifies each authorized watcher only once", async () => {
    const { env, sql, actor, owner, admin, member, manager } = setup();
    const proposal = await requestSharedPublication(env, owner, { type: "memory", id: "m", expectedPolicyVersion: 1 });
    await expect(publishSharedVersion(env, owner, proposal.id)).rejects.toMatchObject({ status: 403 });
    expect(await searchSharedKnowledge(env, member, "strategy")).toEqual([]);
    const published = await publishSharedVersion(env, admin, proposal.id);
    expect(await searchSharedKnowledge(env, member, "strategy")).toMatchObject([{ id: published.id, content: "strategy initial" }]);
    expect(await searchSharedKnowledge(env, actor("d", "outsider"), "strategy")).toEqual([]);
    await watchSharedKnowledge(env, manager, published.id, true);
    sql.exec("UPDATE memories SET content = 'strategy revised', current_version = 2 WHERE id = 'm'");
    expect(await teamKnowledgeInbox(env, manager)).toEqual([]);
    expect(await getSharedKnowledge(env, manager, published.id)).toMatchObject({ content: "strategy initial" });
    const next = await requestSharedPublication(env, owner, { type: "memory", id: "m", expectedPolicyVersion: 1 });
    await publishSharedVersion(env, admin, next.id);
    expect(await getSharedKnowledge(env, manager, published.id)).toMatchObject({ content: "strategy revised" });
    const events = await teamKnowledgeInbox(env, manager);
    expect(events).toMatchObject([{ id: expect.any(Number), share_id: published.id }]);
    expect(await teamKnowledgeEventVersions(env, manager, events[0]!.id)).toMatchObject({
      versions: [{ content: "strategy revised" }, { content: "strategy initial" }]
    });
    env.TEAM_KNOWLEDGE_ENABLED = "false";
    expect(await searchSharedKnowledge(env, manager, "strategy")).toEqual([]);
    await expect(getSharedKnowledge(env, manager, published.id)).rejects.toMatchObject({status:404});
    env.TEAM_KNOWLEDGE_ENABLED = "true";
    sql.exec("UPDATE user_profiles SET status = 'suspended' WHERE principal = 'manager'");
    expect(await teamKnowledgeInbox(env, manager)).toEqual([]);
    sql.exec("UPDATE memories SET deleted_at = 3 WHERE id = 'm'; UPDATE memories SET deleted_at = NULL WHERE id = 'm'");
    expect(await searchSharedKnowledge(env, member, "strategy")).toEqual([]);
    sql.exec("DELETE FROM memories WHERE id = 'm'");
    expect(sql.prepare("SELECT COUNT(*) AS n FROM team_knowledge_publications").get()).toMatchObject({ n:0 });
  });

  it("tracks committed local edits and ignores refresh, rollback, and changes before subscription", async () => {
    const { env, sql, owner } = setup();
    sql.exec("UPDATE memories SET content = 'strategy prior', current_version = 2 WHERE id = 'm'");
    await watchSharedKnowledge(env, owner, "local:m", true);
    sql.exec("UPDATE memories SET current_version = 3 WHERE id = 'm'");
    sql.exec("BEGIN; UPDATE memories SET content = 'strategy discarded', current_version = 4 WHERE id = 'm'; ROLLBACK");
    expect(await teamKnowledgeInbox(env, owner)).toEqual([]);
    sql.exec("UPDATE memories SET content = 'strategy saved', current_version = 4 WHERE id = 'm'");
    expect(await teamKnowledgeInbox(env, owner)).toMatchObject([{ version:"4", kind:"edited", share_id:"local:m" }]);
    await watchSharedKnowledge(env, owner, "local:m", false);
    expect(await teamKnowledgeInbox(env, owner)).toEqual([]);
  });

  describe("search", () => {
    function sharing() {
      const base = setup();
      let counter = 0;
      const share = async (summary: string, content: string, updatedAt?: number) => {
        const id = `m${++counter}`;
        base.sql.prepare(`
          INSERT INTO memories(id,tenant_id,content,summary,source,created_at,owner_principal,scope_type,scope_key,current_version)
          VALUES (?,'a',?,?,'manual',1,'owner','user','owner',1)
        `).run(id, content, summary);
        base.sql.prepare(`
          INSERT INTO resource_access_policies(id,tenant_id,resource_type,resource_id,scope,owner_principal,created_by_principal,created_at,updated_at)
          VALUES (?,'a','memory',?,'private','owner','owner',1,1)
        `).run(`p-${id}`, id);
        const created = await setTeamShare(base.env, base.owner, {
          type: "memory", id, expectedPolicyVersion: 1, minimumRank: 2, targets: ["b"], expiresAt: Date.now() + 86_400_000
        });
        if (updatedAt !== undefined) base.sql.prepare("UPDATE team_knowledge_shares SET updated_at = ? WHERE id = ?").run(updatedAt, created.id);
        return created.id;
      };
      return { ...base, share };
    }
    const tokens = (items: Array<{ title: string; content: string }>) =>
      items.reduce((sum, item) => sum + estimateTextTokens(`${item.title}${item.content}`), 0);
    const deliveries = (sql: ReturnType<typeof setup>["sql"]) =>
      sql.prepare("SELECT * FROM team_knowledge_deliveries ORDER BY access_path, rank").all() as Delivery[];

    it("estimates CJK text per character and other text per four characters", () => {
      expect(estimateTextTokens("")).toBe(0);
      expect(estimateTextTokens("日本語".repeat(100))).toBe(300);
      expect(estimateTextTokens("ひらがなカタカナ")).toBe(8);
      expect(estimateTextTokens("한국어")).toBe(3);
      expect(estimateTextTokens("ＡＢＣ")).toBe(3);
      expect(estimateTextTokens("abcd".repeat(100))).toBe(100);
      expect(estimateTextTokens("deploy 手順 abc")).toBe(Math.ceil(2 + 11 / 4));
    });

    it("never counts non-ASCII text at the ASCII rate", () => {
      expect(estimateTextTokens("サーバー・キー")).toBe(7);
      expect(estimateTextTokens("😀😀")).toBe(2);
      expect(estimateTextTokens("สวัสดี")).toBe(6);
      expect(estimateTextTokens("Привет")).toBe(6);
      expect(estimateTextTokens("ｶﾀｶﾅ")).toBe(4);
      expect(estimateTextTokens("𠮷野家")).toBe(3);
    });

    it("treats a REST token budget outside the MCP range as the nearest bound", async () => {
      const { env, manager, share } = sharing();
      await share("pricing strategy", "strategy ".repeat(300));
      const search = async (token_budget: unknown) =>
        (await sharedKnowledgeForSearch(env, manager, { q: "strategy", token_budget })) as { shared_knowledge: { content: string }[] };
      const lowest = await search(512);
      expect(lowest.shared_knowledge).toHaveLength(1);
      expect(lowest.shared_knowledge[0].content.length).toBeGreaterThan(0);
      expect(await search(1)).toEqual(lowest);
      expect(await search(1e9)).toEqual(await search(16000));
    });

    it("trims a Japanese share to the real token budget", async () => {
      const { env, manager, share } = sharing();
      for (let index = 0; index < 3; index += 1) await share(`記録${index}`, `${"運用".repeat(500)}検証手順${"確認".repeat(500)}`);
      const result = await sharedKnowledgeForSearch(env, manager, { q: "検証手順" }) as {
        shared_knowledge: Array<{ title: string; content: string }>; shared_knowledge_truncated?: boolean;
      };
      expect(result.shared_knowledge).toHaveLength(1);
      expect(tokens(result.shared_knowledge)).toBeLessThanOrEqual(450);
      expect(tokens(result.shared_knowledge)).toBeGreaterThan(400);
      expect(result.shared_knowledge[0]!.content).toContain("検証手順");
      expect(result.shared_knowledge_truncated).toBe(true);
    });

    it("records one delivery per returned item with its path, rank and estimate", async () => {
      const { env, sql, manager, share } = sharing();
      const filler = "lorem ipsum dolor sit amet ".repeat(40);
      const ids = [];
      for (let index = 0; index < 3; index += 1) ids.push(await share(`incident ${index}`, `${filler}postmortem timeline ${filler}`, 10 - index));
      const result = await sharedKnowledgeForSearch(env, manager, { q: "  Postmortem Timeline " }, { accessPath: "memory_search_mcp" }) as {
        shared_knowledge: Array<{ id: string; title: string; content: string }>;
      };
      expect(result.shared_knowledge).toHaveLength(2);
      const rows = deliveries(sql);
      expect(rows).toHaveLength(2);
      const expectedHash = await queryHash("postmortem timeline");
      rows.forEach((row, index) => {
        const item = result.shared_knowledge[index]!;
        expect(row).toMatchObject({
          share_id: item.id, company_id: "corp", source_tenant_id: "a", resource_type: "memory", resource_id: `m${index + 1}`,
          revision: "1", viewer_tenant_id: "b", viewer_principal: "manager", access_path: "memory_search_mcp", rank: index + 1,
          injected_token_estimate: estimateTextTokens(`${item.title}${item.content}`), query_hash: expectedHash
        });
        expect(row.id).toMatch(/^[0-9A-Z]{26}$/u);
        expect(row.created_at).toBeGreaterThan(0);
      });
      expect(JSON.stringify(rows)).not.toContain("postmortem");
      expect(ids.slice(0, 2)).toEqual(rows.map(row => row.share_id));
      const queued: Promise<unknown>[] = [];
      await searchSharedKnowledge(env, manager, "postmortem timeline", 20, { accessPath: "direct_search", waitUntil: promise => queued.push(promise) });
      expect(queued).toHaveLength(1);
      await Promise.all(queued);
      expect(deliveries(sql).filter(row => row.access_path === "direct_search").map(row => row.rank)).toEqual([1, 2, 3]);
      await searchSharedKnowledge(env, manager, "postmortem timeline", 1, { accessPath: "direct_search", waitUntil: () => { throw new Error("no context"); } });
      expect(deliveries(sql).filter(row => row.access_path === "direct_search")).toHaveLength(4);
    });

    it("records nothing without results, access or a delivery path", async () => {
      const { env, sql, actor, manager, member, share } = sharing();
      await share("release note", "release checklist");
      await searchSharedKnowledge(env, manager, "release checklist");
      await sharedKnowledgeForSearch(env, manager, { q: "release checklist" });
      await sharedKnowledgeForSearch(env, manager, { q: "unrelated words" }, { accessPath: "memory_search_api" });
      await sharedKnowledgeForSearch(env, manager, { q: "release checklist", scope: "mine" }, { accessPath: "memory_search_api" });
      await sharedKnowledgeForSearch(env, manager, { q: "release checklist", limit: 0 }, { accessPath: "memory_search_api" });
      for (const viewer of [member, actor("c", "other"), actor("d", "outsider")]) {
        await sharedKnowledgeForSearch(env, viewer, { q: "release checklist" }, { accessPath: "memory_search_api" });
        await searchSharedKnowledge(env, viewer, "release checklist", 20, { accessPath: "direct_search" });
      }
      expect(deliveries(sql)).toEqual([]);
    });

    it("keeps search results when the delivery write fails", async () => {
      const { env, sql, manager, share } = sharing();
      const id = await share("release note", "release checklist");
      sql.exec("DROP TABLE team_knowledge_deliveries");
      expect(await sharedKnowledgeForSearch(env, manager, { q: "release checklist" }, { accessPath: "memory_search_api" }))
        .toMatchObject({ shared_knowledge: [{ id }] });
      expect(await searchSharedKnowledge(env, manager, "release checklist", 20, { accessPath: "direct_search" })).toMatchObject([{ id }]);
    });

    it("keeps deliveries after revocation and removes them with the deleted source", async () => {
      const { env, sql, owner, manager, share } = sharing();
      const id = await share("release note", "release checklist");
      await sharedKnowledgeForSearch(env, manager, { q: "release checklist" }, { accessPath: "memory_search_api" });
      await revokeSharedKnowledge(env, owner, id);
      expect(deliveries(sql)).toMatchObject([{ share_id: id }]);
      sql.exec("DELETE FROM memories WHERE id = 'm1'");
      expect(deliveries(sql)).toEqual([]);
    });

    it("matches a sentence query by its terms and ranks by matched terms, title hits, then recency", async () => {
      const { env, manager, share } = sharing();
      const titled = await share("alpha beta notes", "unrelated body", 1);
      const three = await share("plain", "gamma alpha beta body", 2);
      const twoOld = await share("plain", "alpha with beta", 3);
      const twoNew = await share("plain", "beta then alpha", 4);
      await share("plain", "only alpha here", 5);
      const items = await searchSharedKnowledge(env, manager, "How do Alpha, beta and gamma interact?");
      expect(items.map(item => item.id)).toEqual([titled, three, twoNew, twoOld]);
    });

    it("keeps whole-string matching for a query without separators", async () => {
      const { env, manager, share } = sharing();
      const id = await share("方針", "来期の戦略の見直しを行う");
      expect(await searchSharedKnowledge(env, manager, "戦略の見直し")).toMatchObject([{ id }]);
      expect(await searchSharedKnowledge(env, manager, "戦略を変更")).toEqual([]);
    });

    it("returns at most three items to memory search unless a smaller limit is requested", async () => {
      const { env, manager, share } = sharing();
      for (let index = 0; index < 5; index += 1) await share(`release note ${index}`, "release checklist");
      const direct = await searchSharedKnowledge(env, manager, "release checklist");
      expect(direct.length).toBe(5);
      expect(direct.every(item => item.content_truncated === false)).toBe(true);
      expect(await searchSharedKnowledge(env, manager, "release checklist", 2.9)).toHaveLength(2);
      expect(await sharedKnowledgeForSearch(env, manager, { q: "release checklist", limit: 0 })).toEqual({ shared_knowledge: [] });
      expect(await sharedKnowledgeForSearch(env, manager, { q: "release checklist", limit: -1 })).toEqual({ shared_knowledge: [] });
      const fractional = await sharedKnowledgeForSearch(env, manager, { q: "release checklist", limit: 2.7 }) as { shared_knowledge: unknown[] };
      expect(fractional.shared_knowledge).toHaveLength(2);
      const augmented = await sharedKnowledgeForSearch(env, manager, { q: "release checklist" }) as { shared_knowledge: unknown[] };
      expect(augmented.shared_knowledge).toHaveLength(3);
      const limited = await sharedKnowledgeForSearch(env, manager, { q: "release checklist", limit: 2 }) as { shared_knowledge: unknown[] };
      expect(limited.shared_knowledge).toHaveLength(2);
    });

    it("keeps shared knowledge within a bounded share of the token budget and centres the excerpt on the match", async () => {
      const { env, manager, share } = sharing();
      const filler = "lorem ipsum dolor sit amet ".repeat(40);
      for (let index = 0; index < 3; index += 1) await share(`incident ${index}`, `${filler}postmortem timeline found here ${filler}`);
      const fallback = await sharedKnowledgeForSearch(env, manager, { q: "postmortem timeline" }) as {
        shared_knowledge: Array<{ title: string; content: string; content_truncated: boolean }>; shared_knowledge_truncated?: boolean;
      };
      expect(fallback.shared_knowledge.length).toBeGreaterThan(0);
      expect(tokens(fallback.shared_knowledge)).toBeLessThanOrEqual(450);
      expect(fallback.shared_knowledge_truncated).toBe(true);
      for (const item of fallback.shared_knowledge) {
        expect(item.content).toContain("postmortem");
        expect(item.content_truncated).toBe(true);
      }
      const small = await sharedKnowledgeForSearch(env, manager, { q: "postmortem timeline", token_budget: 600 }) as {
        shared_knowledge: Array<{ title: string; content: string }>;
      };
      expect(small.shared_knowledge).toHaveLength(1);
      expect(tokens(small.shared_knowledge)).toBeLessThanOrEqual(150);
      expect(small.shared_knowledge[0]!.content).toContain("postmortem");
      const large = await sharedKnowledgeForSearch(env, manager, { q: "postmortem timeline", token_budget: 16_000 }) as {
        shared_knowledge: Array<{ title: string; content: string }>; shared_knowledge_truncated?: boolean;
      };
      expect(large.shared_knowledge).toHaveLength(3);
      expect(large.shared_knowledge_truncated).toBeUndefined();
      expect(tokens(large.shared_knowledge)).toBeLessThanOrEqual(4000);
      for (const token_budget of [Number.NaN, "1000", 0, -5]) {
        expect(await sharedKnowledgeForSearch(env, manager, { q: "postmortem timeline", token_budget })).toEqual(fallback);
      }
    });

    it("keeps an item that exactly fits the budget", async () => {
      const { env, manager, share } = sharing();
      const id = await share(`exact ${"t".repeat(94)}`, `fitting ${"c".repeat(492)}`);
      const exact = await sharedKnowledgeForSearch(env, manager, { q: "exact fitting", token_budget: 600 }) as {
        shared_knowledge: Array<{ id: string; title: string; content: string; content_truncated: boolean }>; shared_knowledge_truncated?: boolean;
      };
      expect(exact.shared_knowledge).toMatchObject([{ id, content_truncated: false }]);
      expect(tokens(exact.shared_knowledge)).toBe(150);
      expect(exact.shared_knowledge_truncated).toBeUndefined();
      const titleOnly = await share(`bounded ${"t".repeat(592)}`, "bounded body");
      const full = await sharedKnowledgeForSearch(env, manager, { q: "bounded", token_budget: 600 }) as {
        shared_knowledge: Array<{ id: string; title: string; content: string }>; shared_knowledge_truncated?: boolean;
      };
      expect(full.shared_knowledge).toMatchObject([{ id: titleOnly, content: "" }]);
      expect(full.shared_knowledge[0]!.title).toHaveLength(600);
      expect(full.shared_knowledge_truncated).toBe(true);
    });

    it("selects content terms and drops stopwords, short ASCII terms, and contained terms", () => {
      expect(sharedSearchTerms("How do Alpha, beta and gamma interact?")).toEqual(["alpha", "beta", "gamma", "interact"]);
      expect(sharedSearchTerms("how to deploy")).toEqual(["deploy"]);
      expect(sharedSearchTerms("deploy the deployment")).toEqual(["deployment"]);
      expect(sharedSearchTerms("deploy+rollback|checklist")).toEqual(["deploy", "rollback", "checklist"]);
      expect(sharedSearchTerms("戦略 見直し")).toEqual(["戦略", "見直し"]);
      expect(sharedSearchTerms("what is the")).toEqual(["what is the"]);
      expect(sharedSearchTerms("a b")).toEqual(["a b"]);
      const words = Array.from({ length: 15 }, (_, index) => `word${String.fromCharCode(97 + index)}x`);
      expect(sharedSearchTerms(words.join(" "))).toEqual(words.slice(0, 12));
    });

    it("does not match natural-language queries on function words or fragments", async () => {
      const { env, manager, share } = sharing();
      await share("Show the token list", "Show the token list");
      expect(await searchSharedKnowledge(env, manager, "how to deploy")).toEqual([]);
      expect(await sharedKnowledgeForSearch(env, manager, { q: "how to deploy" })).toEqual({ shared_knowledge: [] });
      const guide = await share("worker guide", "steps to deploy the worker");
      expect(await searchSharedKnowledge(env, manager, "how to deploy")).toMatchObject([{ id: guide }]);
      const phrase = await share("plan", "what is the plan");
      expect(await searchSharedKnowledge(env, manager, "what is the")).toMatchObject([{ id: phrase }]);
    });

    it("requires a proportional number of terms for long queries", async () => {
      const { env, manager, share } = sharing();
      await share("plain", "alpha bravo only");
      const three = await share("plain", "alpha bravo charlie");
      expect(await searchSharedKnowledge(env, manager, "alpha bravo charlie delta echo foxtrot golf")).toMatchObject([{ id: three }]);
      await share("plain", "release notes");
      expect(await searchSharedKnowledge(env, manager, "release checklist")).toEqual([]);
    });

    it("falls back to the whole query when no term qualifies", async () => {
      const { env, manager, share } = sharing();
      const hit = await share("plan", "plan a b c");
      await share("other", "a x b");
      expect((await searchSharedKnowledge(env, manager, "a b")).map(item => item.id)).toEqual([hit]);
    });

    it("returns one row per source and keeps the approved text of an All share", async () => {
      const { env, sql, owner, admin, manager, member } = setup();
      await setTeamShare(env, owner, { type: "memory", id: "m", expectedPolicyVersion: 1, minimumRank: 2, targets: ["b"] });
      const proposal = await requestSharedPublication(env, owner, { type: "memory", id: "m", expectedPolicyVersion: 1 });
      const published = await publishSharedVersion(env, admin, proposal.id);
      expect(await searchSharedKnowledge(env, manager, "strategy initial")).toMatchObject([{ id: published.id, kind: "all" }]);
      sql.exec("UPDATE memories SET content = 'strategy revised', current_version = 2 WHERE id = 'm'");
      expect(await searchSharedKnowledge(env, member, "initial")).toMatchObject([{ id: published.id, content: "strategy initial" }]);
      expect(await searchSharedKnowledge(env, member, "revised")).toEqual([]);
    });

    it("tolerates a source without text", async () => {
      const { env, sql, manager, share } = sharing();
      sql.exec(`
        DROP VIEW team_knowledge_sources;
        CREATE VIEW team_knowledge_sources AS
        SELECT tenant_id, 'memory' AS resource_type, id AS resource_id, summary AS title, NULLIF(content,'') AS content,
               CAST(current_version AS TEXT) AS revision, NULL AS expires_at, NULL AS valid_from, 1 AS legacy_private
          FROM memories WHERE deleted_at IS NULL;
      `);
      const id = await share("nullable source", "");
      expect(await searchSharedKnowledge(env, manager, "nullable source")).toMatchObject([{ id, content: "", content_truncated: false }]);
      expect(await sharedKnowledgeForSearch(env, manager, { q: "nullable source" })).toMatchObject({ shared_knowledge: [{ id }] });
    });

    it("cuts multi-byte excerpts on character boundaries", async () => {
      const { env, manager, share } = sharing();
      await share("記録", `${"日本語😀".repeat(200)}検証手順${"テキスト🎉".repeat(200)}`);
      const result = await sharedKnowledgeForSearch(env, manager, { q: "検証手順", token_budget: 512 }) as {
        shared_knowledge: Array<{ content: string }>;
      };
      expect(result.shared_knowledge).toHaveLength(1);
      const content = result.shared_knowledge[0]!.content;
      expect(content).toContain("検証手順");
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(content)).toBe(false);
    });

    it("never widens access for term queries", async () => {
      const { env, sql, actor, owner, manager, member, share } = sharing();
      const id = await share("deployment rollback", "deployment rollback checklist");
      const query = "what is the deployment rollback checklist?";
      expect(await searchSharedKnowledge(env, manager, query)).toMatchObject([{ id }]);
      for (const viewer of [member, actor("c", "other"), actor("d", "outsider")]) {
        expect(await searchSharedKnowledge(env, viewer, query)).toEqual([]);
        expect(await sharedKnowledgeForSearch(env, viewer, { q: query })).toEqual({ shared_knowledge: [] });
      }
      sql.exec("UPDATE team_knowledge_roles SET rank = 1 WHERE tenant_id = 'b' AND principal = 'manager'");
      expect(await searchSharedKnowledge(env, manager, query)).toEqual([]);
      sql.exec("UPDATE team_knowledge_roles SET rank = 2 WHERE tenant_id = 'b' AND principal = 'manager'");
      sql.prepare("UPDATE team_knowledge_shares SET expires_at = 1 WHERE id = ?").run(id);
      expect(await searchSharedKnowledge(env, manager, query)).toEqual([]);
      sql.prepare("UPDATE team_knowledge_shares SET expires_at = NULL WHERE id = ?").run(id);
      expect(await searchSharedKnowledge(env, manager, query)).toMatchObject([{ id }]);
      await revokeSharedKnowledge(env, owner, id);
      expect(await searchSharedKnowledge(env, manager, query)).toEqual([]);
      expect(await sharedKnowledgeForSearch(env, manager, { q: query })).toEqual({ shared_knowledge: [] });
    });
  });

  it("enforces the authenticated tenant and principal on shared links and ordinary search", async () => {
    const { env, sql, owner } = setup();
    env.API_RATE_LIMITER = { limit: async () => ({ success: true }) };
    env.API_TENANT_POLICY_JSON = JSON.stringify({ keys: [
      { api_key:"local-team-member-test", principal:"member", tenants:["a"], role:"reader" },
      { api_key:"local-team-manager-test", principal:"manager", tenants:["b"], role:"reader" }
    ] });
    const share = await setTeamShare(env, owner, { type:"memory", id:"m", expectedPolicyVersion:1, minimumRank:2, targets:["b"] });
    const { default: worker } = await import("../src/index");
    const fetch = (path: string, key: string, init?: RequestInit) => worker.fetch(
      new Request(`https://test.invalid${path}`, { ...init, headers:{ "x-api-key":key, "content-type":"application/json" } }),
      env, {} as ExecutionContext
    );
    expect((await fetch(`/v1/team-knowledge/item/${share.id}?tenant_id=a&principal=owner`, "local-team-member-test")).status).toBe(404);
    expect((await fetch(`/v1/team-knowledge/item/${share.id}?tenant_id=a`, "local-team-manager-test")).status).toBe(403);
    const response = await fetch(`/v1/team-knowledge/item/${share.id}?tenant_id=b`, "local-team-manager-test");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({data:{id:share.id,access_reason:"target_tenant"}});
    const search = await fetch("/v1/memories/search", "local-team-manager-test", {
      method:"POST", body:JSON.stringify({tenant_id:"b",q:"strategy",search_mode:"memories"})
    });
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({data:{shared_knowledge:[{id:share.id}]}});
    const budgeted = await fetch("/v1/memories/search", "local-team-manager-test", {
      method:"POST", body:JSON.stringify({tenant_id:"b",q:"strategy",search_mode:"memories",token_budget:"bogus"})
    });
    expect(budgeted.status).toBe(200);
    expect(await budgeted.json()).toMatchObject({data:{shared_knowledge:[{id:share.id}]}});
    const direct = await fetch("/v1/team-knowledge/search?tenant_id=b&q=strategy", "local-team-manager-test");
    expect(direct.status).toBe(200);
    expect(await direct.json()).toMatchObject({data:{items:[{id:share.id}]}});
    expect(sql.prepare(`SELECT access_path,viewer_tenant_id,viewer_principal,share_id FROM team_knowledge_deliveries
      ORDER BY access_path DESC`).all()).toEqual([
      { access_path:"memory_search_api", viewer_tenant_id:"b", viewer_principal:"manager", share_id:share.id },
      { access_path:"memory_search_api", viewer_tenant_id:"b", viewer_principal:"manager", share_id:share.id },
      { access_path:"direct_search", viewer_tenant_id:"b", viewer_principal:"manager", share_id:share.id }
    ]);
  });

  it("honours token_budget on the MCP memory search tool and records the MCP path", async () => {
    const { env, sql, owner } = setup();
    env.API_RATE_LIMITER = { limit: async () => ({ success: true }) };
    sql.exec(`UPDATE memories SET summary = 'plan', content = '${"運用".repeat(400)}strategy${"確認".repeat(400)}' WHERE id = 'm'`);
    const share = await setTeamShare(env, owner, { type:"memory", id:"m", expectedPolicyVersion:1, minimumRank:2, targets:["b"] });
    const call = async (args: Record<string, unknown>) => {
      const response = await handleOrgBrainMcpRequest(new Request("https://example.com/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream", "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "orgbrain_memories_search"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "orgbrain_memories_search", arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "orgbrain-test-client", version: "1.0.0" }
          }
        } })
      }), env, {} as ExecutionContext, {
        principal: "manager", tenantId: "b", allowedTenants: ["b"], source: "oauth", defaultRole: "reader",
        runtimeActor: "principal:manager", scopes: ["orgbrain:read"]
      });
      const text = await response.text();
      const data = response.headers.get("content-type")?.includes("text/event-stream")
        ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text;
      const body = JSON.parse(data) as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: unknown };
      const text0 = body.result?.isError ? undefined : body.result?.content?.[0]?.text;
      return { status: response.status, body, payload: text0 ? JSON.parse(text0) : null };
    };
    const wide = await call({ tenant_id: "b", q: "strategy", search_mode: "memories", token_budget: 4000 });
    expect(wide.payload).toMatchObject({ shared_knowledge: [{ id: share.id }] });
    const narrow = await call({ tenant_id: "b", q: "strategy", search_mode: "memories", token_budget: 512 });
    const items = (narrow.payload as { shared_knowledge: Array<{ title: string; content: string }> }).shared_knowledge;
    expect(items).toHaveLength(1);
    expect(items.reduce((sum, item) => sum + estimateTextTokens(`${item.title}${item.content}`), 0)).toBeLessThanOrEqual(128);
    expect((wide.payload as { shared_knowledge: Array<{ content: string }> }).shared_knowledge[0]!.content.length)
      .toBeGreaterThan(items[0]!.content.length);
    const rejected = await call({ tenant_id: "b", q: "strategy", token_budget: 100 });
    expect(JSON.stringify(rejected.body)).toMatch(/token_budget/u);
    expect(sql.prepare("SELECT access_path,viewer_principal FROM team_knowledge_deliveries").all())
      .toEqual([{ access_path: "memory_search_mcp", viewer_principal: "manager" }, { access_path: "memory_search_mcp", viewer_principal: "manager" }]);
  });
});
