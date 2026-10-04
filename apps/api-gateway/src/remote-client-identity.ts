import type { OrgBrainOAuthScope, OrgRole } from '@org-brain/shared';
import { assertPermission } from './rbac-service';
import type { Env } from './types';

export type RemoteOAuthIdentity = {
  tenantId: string; principal: string; defaultRole: OrgRole; scopes: OrgBrainOAuthScope[]; projectId?: string;
};

// Called ONLY from the OAuth provider's already authenticated apiHandler.
// This endpoint does not issue tokens or expose user profiles/email/credentials.
export async function remoteClientIdentity(request: Request, env: Env, props: RemoteOAuthIdentity): Promise<Response> {
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
  if (request.method !== 'GET') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers });
  const params = new URL(request.url).searchParams;
  const tenantId = params.get('tenant_id'); const projectId = params.get('project_id');
  if (params.getAll('tenant_id').length !== 1 || params.getAll('project_id').length !== 1 ||
      !tenantId || !projectId || tenantId.length > 128 || projectId.length > 128) {
    return Response.json({ error: 'explicit_tenant_project_required' }, { status: 400, headers });
  }
  if (tenantId !== props.tenantId || props.projectId && projectId !== props.projectId || !props.scopes.includes('orgbrain:read')) {
    return Response.json({ error: 'forbidden' }, { status: 403, headers });
  }
  const user = await env.OPEN_BRAIN_DB.prepare('SELECT status FROM user_profiles WHERE tenant_id=? AND principal=?')
    .bind(tenantId, props.principal).first<{ status: string }>();
  if (user?.status !== 'active') return Response.json({ error: 'user_inactive' }, { status: 403, headers });
  try {
    await assertPermission(env, { tenantId, projectId, principal: props.principal,
      permission: 'read', fallbackRole: props.defaultRole });
    if (props.scopes.includes('orgbrain:write')) {
      await assertPermission(env, { tenantId, projectId, principal: props.principal,
        permission: 'write', fallbackRole: props.defaultRole });
    }
  } catch { return Response.json({ error: 'forbidden' }, { status: 403, headers }); }
  return Response.json({ resource: env.MCP_OAUTH_RESOURCE, tenant_id: tenantId, project_id: projectId,
    principal: props.principal, scopes: props.scopes }, { headers });
}
