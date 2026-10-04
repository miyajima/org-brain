export const REMOTE_SCOPES = Object.freeze(['orgbrain:read', 'orgbrain:write']);
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export class RemoteOAuthError extends Error {
  constructor(code) { super(`remote_${code}`); this.code = code; }
}

export function httpsUrl(raw, origin) {
  let url;
  try { url = new URL(raw); } catch { throw new RemoteOAuthError('invalid_endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (origin && url.origin !== origin)) throw new RemoteOAuthError('invalid_endpoint');
  return url;
}

export function canonicalResource(raw) {
  const url = httpsUrl(raw);
  if (url.pathname !== '/mcp' || url.search) throw new RemoteOAuthError('invalid_resource');
  return url.href;
}

export function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x20\x7f]/u.test(value)) {
    throw new RemoteOAuthError('invalid_identity');
  }
  return value;
}

export function exactScopes(value) {
  const scopes = typeof value === 'string' ? value.split(' ').filter(Boolean) : value;
  if (!Array.isArray(scopes) || scopes.length !== REMOTE_SCOPES.length ||
      !REMOTE_SCOPES.every(scope => scopes.includes(scope))) throw new RemoteOAuthError('scope_mismatch');
  return [...REMOTE_SCOPES];
}

export async function boundedResponse(response, maximum = 256 * 1024) {
  if (!response.body) throw new RemoteOAuthError('invalid_response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new RemoteOAuthError('response_too_large'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof RemoteOAuthError) throw error;
    throw new RemoteOAuthError('invalid_response');
  } finally { reader.releaseLock(); }
}

export async function safeFetch(fetchImpl, url, options = {}) {
  try { return await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new RemoteOAuthError('network_failed'); }
}

export async function jsonRequest(fetchImpl, url, options = {}) {
  const response = await safeFetch(fetchImpl, url, options);
  let value;
  try { value = JSON.parse(await boundedResponse(response)); }
  catch (error) { if (error instanceof RemoteOAuthError) throw error; throw new RemoteOAuthError('invalid_response'); }
  if (!response.ok) {
    // Never log server descriptions/bodies: they can echo code, token or verifier.
    const allowed = ['invalid_grant', 'invalid_scope', 'access_denied', 'authorization_pending', 'slow_down', 'expired_token'];
    throw new RemoteOAuthError(allowed.includes(value?.error) ? value.error : `http_${response.status}`);
  }
  return value;
}

export async function discoverOrgBrain(fetchImpl, resource) {
  resource = canonicalResource(resource);
  const origin = new URL(resource).origin;
  const protectedMetadata = await jsonRequest(fetchImpl, `${origin}/.well-known/oauth-protected-resource/mcp`);
  if (protectedMetadata.resource !== resource || protectedMetadata.authorization_servers?.length !== 1 ||
      protectedMetadata.authorization_servers[0] !== origin) throw new RemoteOAuthError('resource_metadata_mismatch');
  const metadata = await jsonRequest(fetchImpl, `${origin}/.well-known/oauth-authorization-server`);
  if (metadata.issuer !== origin || !metadata.code_challenge_methods_supported?.includes('S256') ||
      !metadata.token_endpoint_auth_methods_supported?.includes('none') ||
      !REMOTE_SCOPES.every(scope => metadata.scopes_supported?.includes(scope))) {
    throw new RemoteOAuthError('unsupported_authorization_server');
  }
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    metadata[key] = httpsUrl(metadata[key], origin).href;
  }
  for (const key of ['revocation_endpoint', 'device_authorization_endpoint']) {
    if (metadata[key]) metadata[key] = httpsUrl(metadata[key], origin).href;
  }
  return { ...metadata, resource };
}

export async function tokenRequest(fetchImpl, metadata, fields) {
  return jsonRequest(fetchImpl, metadata.token_endpoint, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, resource: metadata.resource }).toString() });
}
