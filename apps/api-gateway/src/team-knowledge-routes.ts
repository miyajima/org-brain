import type { Context, Hono } from "hono";
import { z } from "zod";
import { HttpError } from "@org-brain/shared";
import { assertApiTenantAccess, getApiAuthContext, jsonOk, type ApiContextEnv } from "./auth";
import { isTenantAdmin } from "./route-support";
import {
  acknowledgeTeamKnowledgeEvent, getSharedKnowledge, pendingSharedPublications, previewTeamShare, publishSharedVersion,
  recentTeamShares, requestSharedPublication, revokeSharedKnowledge, searchSharedKnowledge, setTeamShare, teamKnowledgeInbox,
  teamKnowledgeEventVersions, teamKnowledgeSharingState, teamKnowledgeStatus, teamKnowledgeWatchStatus, updateTeamKnowledgeRole, watchSharedKnowledge
} from "./team-knowledge-service";

const identifier = z.string().trim().min(1).max(160);
const source = z.object({
  type: z.enum(["memory", "decision_memory", "knowledge_doc", "knowledge_resource"]),
  id: identifier,
  expectedPolicyVersion: z.number().int().positive()
});
const audience = source.extend({
  minimumRank: z.number().int().min(1).max(3),
  targets: z.array(identifier).max(50),
  expiresAt: z.number().int().positive().nullable().optional(),
  expectedShareId: identifier.nullable()
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "invalid_payload", result.error.issues[0]?.message ?? "Invalid team knowledge request");
  return result.data;
}

async function actor(c: Context<ApiContextEnv>, body?: unknown, privileged = false) {
  const requested = body && typeof body === "object" && "tenant_id" in body ? body.tenant_id : undefined;
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id") ?? (typeof requested === "string" ? requested : undefined));
  const auth = getApiAuthContext(c);
  if (privileged && auth.scopes && !auth.scopes.includes("admin")) {
    throw new HttpError(403, "team_admin_scope_required", "This token cannot manage team knowledge");
  }
  return { tenantId, principal: auth.principal, projectId: auth.projectId, isTenantAdmin: await isTenantAdmin(c, tenantId) };
}

export function registerTeamKnowledgeRoutes(app: Hono<ApiContextEnv>) {
  const root = "/v1/team-knowledge";
  app.get(`${root}/status`, async c => jsonOk(c, await teamKnowledgeStatus(c.env, await actor(c))));
  app.get(`${root}/search`, async c => jsonOk(c, { items: await searchSharedKnowledge(c.env, await actor(c), parse(z.string().trim().min(1).max(500), c.req.query("q")),
    undefined, { accessPath: "direct_search", waitUntil: promise => c.executionCtx.waitUntil(promise) }) }));
  app.get(`${root}/item/:id`, async c => jsonOk(c, await getSharedKnowledge(c.env, await actor(c), c.req.param("id"))));
  app.get(`${root}/sharing`, async c => jsonOk(c, await teamKnowledgeSharingState(c.env, await actor(c), parse(source, {
    type: c.req.query("type"), id: c.req.query("id"), expectedPolicyVersion: Number(c.req.query("version"))
  }))));
  app.post(`${root}/sharing/preview`, async c => {
    const body = await c.req.json();
    const input = parse(audience, body);
    const { targets, current } = await previewTeamShare(c.env, await actor(c, body), input);
    return jsonOk(c, { current, next: { minimum_rank: input.minimumRank, target_tenants: targets, expires_at: input.expiresAt ?? null } });
  });
  app.put(`${root}/sharing`, async c => {
    const body = await c.req.json();
    return jsonOk(c, await setTeamShare(c.env, await actor(c, body), parse(audience, body)));
  });
  app.post(`${root}/sharing/revoke`, async c => {
    const body = await c.req.json();
    return jsonOk(c, await revokeSharedKnowledge(c.env, await actor(c, body), parse(identifier, body?.id)));
  });
  app.get(`${root}/publications`, async c => jsonOk(c, { items: await pendingSharedPublications(c.env, await actor(c)) }));
  app.post(`${root}/publications/request`, async c => {
    const body = await c.req.json();
    return jsonOk(c, await requestSharedPublication(c.env, await actor(c, body), parse(source, body)), 201);
  });
  app.post(`${root}/publications/approve`, async c => {
    const body = await c.req.json();
    return jsonOk(c, await publishSharedVersion(c.env, await actor(c, body, true), parse(identifier, body?.id)));
  });
  app.post(`${root}/publications/revoke`, async c => {
    const body = await c.req.json();
    return jsonOk(c, await revokeSharedKnowledge(c.env, await actor(c, body, true), parse(identifier, body?.id), "all"));
  });
  app.put(`${root}/roles`, async c => {
    const body = await c.req.json();
    const input = parse(z.object({ targetTenant: identifier, principal: identifier, rank: z.number().int().min(1).max(4) }), body);
    return jsonOk(c, await updateTeamKnowledgeRole(c.env, await actor(c, body, true), input.targetTenant, input.principal, input.rank));
  });
  app.get(`${root}/watch/:ref`, async c => jsonOk(c, await teamKnowledgeWatchStatus(c.env, await actor(c), c.req.param("ref"))));
  app.put(`${root}/watch/:ref`, async c => {
    const body = await c.req.json();
    return jsonOk(c, await watchSharedKnowledge(c.env, await actor(c, body), c.req.param("ref"), parse(z.boolean(), body?.watching)));
  });
  app.get(`${root}/inbox`, async c => jsonOk(c, { items: await teamKnowledgeInbox(c.env, await actor(c)) }));
  app.get(`${root}/inbox/:eventId`, async c => jsonOk(c, await teamKnowledgeEventVersions(c.env, await actor(c),
    parse(z.number().int().positive(), Number(c.req.param("eventId"))))));
  app.get(`${root}/recent-shares`, async c => jsonOk(c, { items: await recentTeamShares(c.env, await actor(c)) }));
  app.post(`${root}/inbox/read`, async c => {
    const body = await c.req.json();
    return jsonOk(c, await acknowledgeTeamKnowledgeEvent(c.env, await actor(c, body), parse(z.number().int().positive(), body?.id)));
  });
}
