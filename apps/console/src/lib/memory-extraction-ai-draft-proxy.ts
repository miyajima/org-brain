export type AiDraftProxyConfig = {
  endpoint?: string;
  token?: string;
};

const MAX_BODY_BYTES = 128 * 1024;

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" }
  });
}

export function resolveLocalAiDraftEndpoint(value: string | undefined): URL | null {
  if (!value?.trim()) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) return null;
  return url;
}

export async function proxyLocalAiDraft(
  request: Request,
  config: AiDraftProxyConfig,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "POST only");
  const endpoint = resolveLocalAiDraftEndpoint(config.endpoint);
  if (!endpoint || !config.token || config.token.length < 16) {
    return errorResponse(404, "ai_draft_disabled", "ローカルAI下書きサービスが有効ではありません。");
  }
  const expectedOrigin = new URL(request.url).origin;
  if (request.headers.get("origin") !== expectedOrigin) {
    return errorResponse(403, "origin_rejected", "同一オリジンの評価画面から実行してください。");
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return errorResponse(413, "request_too_large", "評価CASEが大きすぎます。");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return errorResponse(413, "request_too_large", "評価CASEが大きすぎます。");
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orgbrain-ai-draft-token": config.token
      },
      body,
      signal: AbortSignal.timeout(185_000)
    });
  } catch {
    return errorResponse(503, "ai_draft_unavailable", "ローカルAI下書きサービスへ接続できません。");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
