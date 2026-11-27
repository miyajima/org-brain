import { expect, it } from "vitest";
import { createDecisionMemory, confirmDecisionMemory, enrichContext } from "../src/context-engine-service";
import { handleOrgBrainMcpRequest } from "../src/mcp";
import { memoryD1Fixture } from "./fixtures/memory-d1";

it("supplies confirmation details for a teammate's and the current user's past decisions through Cloud MCP", async () => {
  const { env, sql } = memoryD1Fixture();
  const tenant = "decision-test";
  const project = "notifications";
  const author = "user:alice";
  const recorder = "user:bob";
  const source = { type: "adr", title: "切替レビュー議事録", id: "ADR-18" };
  const alternative = { alternative: "自動切替", reasonRejected: "切り戻し手順が未検証" };
  const request = {
    tenant_id: tenant, project_id: project,
    task: { title: "今回、通知は自動で切り替えますか？", description: "切り戻し手順はまだ検証していません。" }
  };
  const save = async (overrides: Record<string, unknown> = {}, review = true) => {
    const created = await createDecisionMemory(env, {
      tenant_id: tenant, project_id: project, visibility: "project",
      title: "通知の自動切替を見送る", decision: "手動で通知を切り替える",
      rationale: "切り戻し手順が未検証だったため", constraints: ["切り戻し手順が未検証の間"],
      source_refs: [source], rejected_alternatives: [alternative],
      owner_refs: [{ type: "user", id: author, name: "Alice" }], ...overrides
    }, { principal: recorder });
    if (review) await confirmDecisionMemory(env, tenant, created.decisionMemory.id, {}, { principal: recorder });
    return created.decisionMemory.id;
  };
  const call = async (principal: string, args: Record<string, unknown> = request) => {
    const tool = "orgbrain_context_enrich";
    const response = await handleOrgBrainMcpRequest(new Request("https://fixture.example/mcp", {
      method: "POST",
      headers: {
        accept: "application/json", "content-type": "application/json", "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call", "mcp-name": tool
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: tool, arguments: args, _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "decision-test", version: "1" }
        }
      } })
    }), env, { waitUntil() {} } as unknown as ExecutionContext, {
      tenantId: tenant, allowedTenants: [tenant], principal, runtimeActor: principal,
      source: "oauth", defaultRole: "reader", scopes: ["orgbrain:read"]
    });
    expect(response.status).toBe(200);
    const { result, error } = await response.json() as {
      result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown
    };
    expect(error).toBeUndefined();
    expect(result, JSON.stringify(result)).not.toHaveProperty("isError", true);
    return JSON.parse(result!.content[0].text);
  };
  try {
    env.API_RATE_LIMITER = { async limit() { return { success: true }; } };
    const id = await save();
    const denied = await save({ title: "非公開の通知切替", visibility: "restricted" });
    const unreadableSource = await save({ title: "通知切替の非公開文書", source_refs: [{ ...source, allowedPrincipals: ["user:other"] }] });
    const expired = await save({ title: "期限切れの通知切替", valid_until: Date.now() - 60_000 });
    const future = await save({ title: "将来の通知切替", valid_from: Date.now() + 60_000 });
    const unrelated = await save({ title: "税率表の更新", decision: "税率を更新する", rationale: "税制が改定されたため", constraints: [], rejected_alternatives: [] });
    const unreviewed = await save({ title: "未確認の通知切替" }, false);

    for (const viewer of [author, "user:carol"]) {
      const response = await call(viewer);
      const entries = response.decisionContext as Array<Record<string, unknown>>;
      expect(entries.find(entry => entry.id === id)).toMatchObject({
        decision: "手動で通知を切り替える", rationale: "切り戻し手順が未検証だったため",
        constraints: ["切り戻し手順が未検証の間"], sources: [source],
        confirmationCandidate: {
          deciders: [{ name: "Alice", isCurrentUser: viewer === author }], rejectedAlternatives: [alternative]
        }
      });
      expect(entries.filter(entry => entry.confirmationCandidate).map(entry => entry.id)).toEqual([id]);
      for (const inaccessibleId of [denied, expired, unreviewed]) {
        expect(entries.map(entry => entry.id)).not.toContain(inaccessibleId);
      }
      expect(entries.find(entry => entry.id === unreadableSource)).not.toHaveProperty("confirmationCandidate");
      expect(entries.find(entry => entry.id === future)).not.toHaveProperty("confirmationCandidate");
      expect(entries.find(entry => entry.id === unrelated)?.confirmationCandidate).toBeUndefined();
    }

    const ordinary = await enrichContext(env, request, { principal: author, recordUsage: false });
    expect(ordinary.decisionContext.find(entry => entry.id === id)).not.toHaveProperty("confirmationCandidate");

    const otherProject = await call(author, { ...request, project_id: "other-project" });
    expect(otherProject.decisionContext).toEqual([]);

    const withoutSources = await call(author, { ...request, include_sources: false });
    expect(withoutSources.decisionContext.find((entry: Record<string, unknown>) => entry.id === id))
      .not.toHaveProperty("confirmationCandidate");
    const small = await call(author, { ...request, max_tokens: 500 });
    expect(small.decisionContext.some((entry: Record<string, unknown>) => entry.confirmationCandidate)).toBe(false);

    await save({ decision: "今回は通知を自動で切り替える" });
    const conflict = await call(author, { ...request, include_conflicts: false });
    expect(conflict.decisionContext.some((entry: Record<string, unknown>) => entry.confirmationCandidate)).toBe(false);
  } finally {
    sql.close();
  }
});
