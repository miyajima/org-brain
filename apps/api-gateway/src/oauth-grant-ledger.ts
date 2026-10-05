import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { sha256 } from '@org-brain/shared';
import type { Env } from './types';
import type { OAuthProps } from './mcp-oauth-cloudflare';
import { currentOAuthIdentity } from './oauth-current-identity';
import { oauthError, opaque } from './oauth-security-utils';

type Family = { family_id: string; user_id: string; grant_id: string; client_id: string; resource: string;
  tenant_id: string; principal: string; project_id: string | null;
  identity_issuer: string; identity_subject: string; identity_email: string | null; scopes_json: string; state: string; expires_at: number };
type Refresh = Family & { token_hash: string; token_state: string };

export class OAuthGrantLedger {
  constructor(private env: Env, private helpers: OAuthHelpers, private now = Date.now) {}

  async authorize(userId: string, grantId: string, props: OAuthProps, clientId: string) {
    const family = await this.env.OPEN_BRAIN_DB.prepare('SELECT * FROM oauth_grant_families WHERE family_id=?')
      .bind(`${userId}:${grantId}`).first<Family>();
    if (!family || family.state !== 'active' || family.expires_at <= this.now() || family.client_id !== clientId ||
        family.resource !== this.env.MCP_OAUTH_RESOURCE || family.tenant_id !== props.tenantId ||
        family.principal !== props.principal || family.project_id !== (props.projectId ?? null) ||
        family.identity_issuer !== props.identity?.issuer || family.identity_subject !== props.identity?.subject ||
        family.identity_email !== (props.identity?.email ?? null) || family.scopes_json !== JSON.stringify(props.scopes)) return null;
    const current = await this.current(family);
    if (!current) { await this.revoke(family); return null; }
    return { ...props, defaultRole: current.defaultRole };
  }

  private current(family: Family) {
    return currentOAuthIdentity(this.env, { tenantId: family.tenant_id, principal: family.principal,
      projectId: family.project_id ?? undefined, scopes: JSON.parse(family.scopes_json),
      identity: { issuer: family.identity_issuer, subject: family.identity_subject, email: family.identity_email } });
  }

  async revoke(family: Family) {
    // Strongly consistent deny state takes precedence over eventual KV deletion.
    await this.env.OPEN_BRAIN_DB.prepare("UPDATE oauth_grant_families SET state='revoked' WHERE family_id=?")
      .bind(family.family_id).run();
    await this.helpers.revokeGrant(family.grant_id, family.user_id).catch(() => {});
  }

  async refreshRecord(token: string) {
    return this.env.OPEN_BRAIN_DB.prepare(`SELECT f.*, t.token_hash, t.state AS token_state FROM oauth_refresh_tokens t
      JOIN oauth_grant_families f ON f.family_id=t.family_id WHERE t.token_hash=?`)
      .bind(await sha256(token)).first<Refresh>();
  }

  async schemaAvailable() {
    return !!await this.env.OPEN_BRAIN_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_grant_families'").first();
  }

  async claimsTrackedFamily(token: string) {
    // The unverified prefix may ONLY cause denial of this request. It can never
    // authenticate, consume, revoke or otherwise mutate a selected family.
    const parts = token.split(':');
    if (parts.length !== 3) return false;
    return !!await this.env.OPEN_BRAIN_DB.prepare('SELECT family_id FROM oauth_grant_families WHERE family_id=?')
      .bind(`${parts[0]}:${parts[1]}`).first();
  }

  async revokeClientFamilies(userId: string, clientId: string) {
    // Called only with the authenticated user subject and SDK-parsed client.
    // One durable transition also defeats a concurrent SDK refresh resurrection.
    if (!await this.schemaAvailable()) return;
    await this.env.OPEN_BRAIN_DB.prepare("UPDATE oauth_grant_families SET state='revoked' WHERE user_id=? AND client_id=?")
      .bind(userId, clientId).run();
  }

  async consumeRefresh(token: string, clientId: string, resource: string) {
    if (!opaque(token)) return null;
    const row = await this.refreshRecord(token);
    if (!row || row.client_id !== clientId || row.resource !== resource || row.expires_at <= this.now() || row.state !== 'active') return null;
    if (!await this.current(row)) { await this.revoke(row); return null; }
    const result = await this.env.OPEN_BRAIN_DB.prepare(`UPDATE oauth_refresh_tokens SET state='used'
      WHERE token_hash=? AND state='active' AND EXISTS(SELECT 1 FROM oauth_grant_families f
        WHERE f.family_id=oauth_refresh_tokens.family_id AND f.state='active' AND f.expires_at>?)`)
      .bind(row.token_hash, this.now()).run();
    if (result.meta.changes !== 1) { await this.revoke(row); return null; }
    return row;
  }

  async revokeRefresh(token: string, clientId: string) {
    if (!opaque(token)) return false;
    const row = await this.refreshRecord(token);
    if (!row || row.client_id !== clientId) return false;
    await this.revoke(row); return true;
  }

  async register(response: Response, clientId: string, existing?: Family) {
    if (!response.ok) { if (existing) await this.revoke(existing); return response; }
    let family: Family | undefined;
    try {
      const tokens = await response.clone().json<{ access_token: string; refresh_token?: string; token_type: string }>();
      if (!opaque(tokens.access_token) || !opaque(tokens.refresh_token) || tokens.token_type.toLowerCase() !== 'bearer') throw Error();
      const verified = await this.helpers.unwrapToken<OAuthProps>(tokens.access_token);
      if (!verified || verified.grant.clientId !== clientId) throw Error();
      const id = `${verified.userId}:${verified.grantId}`;
      if (existing && id !== existing.family_id) throw Error();
      const props = verified.grant.props;
      family = { family_id: id, user_id: verified.userId, grant_id: verified.grantId, client_id: clientId,
        resource: this.env.MCP_OAUTH_RESOURCE!, tenant_id: props.tenantId, principal: props.principal,
        project_id: props.projectId ?? null, identity_issuer: props.identity?.issuer ?? '',
        identity_subject: props.identity?.subject ?? '', identity_email: props.identity?.email ?? null,
        scopes_json: JSON.stringify(props.scopes), state: 'active', expires_at: this.now() + 30 * 86400_000 };
      // Cutover requires fresh V2 consent. A pre-cutover authorization code may
      // not create an unmarked family that could bypass denial on rollback.
      if (props.securityV2 !== true || !await this.current(family)) throw Error();
      const audience = Array.isArray(verified.audience) ? verified.audience : [verified.audience];
      if (audience.length !== 1 || audience[0] !== family.resource) throw Error();
      const result = await this.env.OPEN_BRAIN_DB.batch([
        this.env.OPEN_BRAIN_DB.prepare(`INSERT INTO oauth_grant_families
          (family_id,user_id,grant_id,client_id,resource,tenant_id,principal,project_id,identity_issuer,identity_subject,identity_email,scopes_json,state,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(family_id) DO NOTHING`)
          .bind(id, family.user_id, family.grant_id, clientId, family.resource, family.tenant_id, family.principal,
            family.project_id, family.identity_issuer, family.identity_subject, family.identity_email, family.scopes_json, this.now(), family.expires_at),
        this.env.OPEN_BRAIN_DB.prepare(`INSERT INTO oauth_refresh_tokens(token_hash,family_id,state,created_at)
          SELECT ?,family_id,'active',? FROM oauth_grant_families WHERE family_id=? AND state='active' AND expires_at>?`)
          .bind(await sha256(tokens.refresh_token), this.now(), id, this.now())
      ]);
      if (result[1].meta.changes !== 1 || !await this.authorize(family.user_id, family.grant_id, props, clientId)) throw Error();
      return response;
    } catch {
      if (family) await this.revoke(family);
      else if (existing) await this.revoke(existing);
      return oauthError('invalid_grant');
    }
  }
}
