import { sha256 } from '@org-brain/shared';
import type { Env } from './types';

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEVICE_SCOPES = ['orgbrain:read', 'orgbrain:write'] as const;
export const noStore = { 'cache-control': 'no-store', 'pragma': 'no-cache', 'referrer-policy': 'no-referrer' };
export const oauthError = (error: string, status = 400) => Response.json({ error }, { status, headers: noStore });
export const randomCode = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const identifier = (value: string | null, max = 128): value is string =>
  !!value && value.length <= max && !/[\x00-\x20\x7f]/u.test(value);
export const opaque = (value: unknown): value is string => typeof value === 'string' && value.length <= 8192 && /^[\x21-\x7e]+$/u.test(value);

export async function formBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded') || !request.body) throw Error('invalid_request');
  const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw Error('invalid_request'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const form = new URLSearchParams(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  for (const key of form.keys()) if (form.getAll(key).length !== 1) throw Error('invalid_request');
  return form;
}

export async function attemptLimit(env: Env, purpose: string, key: string, now: number, maximum: number) {
  // Existing platform limiter must be configured; no fail-open OAuth lane.
  const bucket = await sha256(`${purpose}:${key}`);
  if (!env.API_RATE_LIMITER || !(await env.API_RATE_LIMITER.limit({ key: `oauth:${bucket}` })).success) return false;
  const window = Math.floor(now / 60_000);
  const hash = await sha256(`${bucket}:${window}`);
  const result = await env.OPEN_BRAIN_DB.prepare(`INSERT INTO oauth_attempt_buckets(bucket_hash,attempts,expires_at)
    VALUES(?,1,?) ON CONFLICT(bucket_hash) DO UPDATE SET attempts=attempts+1 WHERE attempts<?`)
    .bind(hash, (window + 2) * 60_000, maximum).run();
  return result.meta.changes === 1;
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export async function boundedJson(request: Request, maximum = 16_384): Promise<Record<string, any>> {
  if (!request.body) throw Error('invalid_request');
  const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw Error('invalid_request'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('invalid_request');
  return body;
}
