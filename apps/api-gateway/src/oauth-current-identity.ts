import { HttpError } from '@org-brain/shared';
import { resolveVerifiedAccessUser } from './auth';
import { assertPermission } from './rbac-service';
import type { OAuthProps } from './mcp-oauth-cloudflare';
import type { Env } from './types';

// Identity bindings originate only in verified Access consent, never in client
// arguments. Raw D1 reads remain primary; no unconstrained replica session here.
export async function currentOAuthIdentity(env: Env, props: Pick<OAuthProps, 'identity'|'tenantId'|'principal'|'projectId'|'scopes'>) {
  if (!props.identity?.issuer || !props.identity.subject) return null;
  try {
    const grant = await resolveVerifiedAccessUser(env, { iss: props.identity.issuer, sub: props.identity.subject,
      ...(props.identity.email ? { email: props.identity.email } : {}) }, 'access-jwt', { requireExistingIdentity: true });
    if (grant.principal !== props.principal || !grant.allowedTenants.includes(props.tenantId)) return null;
    // Device grants have a fixed project. Native grants have no target project:
    // their handlers must apply current RBAC to each operation's actual target.
    if (props.projectId) for (const scope of props.scopes) {
      await assertPermission(env, { tenantId: props.tenantId, projectId: props.projectId, principal: grant.principal,
        permission: scope === 'orgbrain:read' ? 'read' : 'write', fallbackRole: grant.defaultRole });
    }
    return { defaultRole: grant.defaultRole };
  } catch (error) {
    if (error instanceof HttpError && [401,403,409].includes(error.status)) return null;
    throw error; // Policy/storage failures must never authenticate or downgrade to legacy.
  }
}
