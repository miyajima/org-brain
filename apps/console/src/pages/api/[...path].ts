import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

type ConsoleWorkerEnv = {
  API?: Fetcher;
  INTERNAL_API_KEY?: string;
  API_BASE_URL?: string;
};

function stripHeaders(headers: Headers): Headers {
  const next = new Headers();
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "x-api-key") continue;
    next.set(key, value);
  }
  return next;
}

function buildFallbackUrl(path: string, requestUrl: string, apiBaseUrl: string): URL {
  const baseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const fallbackUrl = new URL(path, baseUrl);
  fallbackUrl.search = new URL(requestUrl).search;
  return fallbackUrl;
}

export const ALL: APIRoute = async ({ params, request }) => {
  const runtimeEnv = env as unknown as ConsoleWorkerEnv;
  const apiBaseUrl = typeof runtimeEnv?.API_BASE_URL === "string" ? runtimeEnv.API_BASE_URL.trim() : "";
  if ((!runtimeEnv?.API && !apiBaseUrl) || !runtimeEnv?.INTERNAL_API_KEY) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: "misconfigured",
          message: "Missing API binding/API_BASE_URL or INTERNAL_API_KEY"
        }
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" }
      }
    );
  }

  const path = params.path ?? "";
  const targetUrl = new URL(`https://internal/${path}`);
  targetUrl.search = new URL(request.url).search;

  const headers = stripHeaders(request.headers);
  headers.set("x-api-key", runtimeEnv.INTERNAL_API_KEY);

  const init = {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer()
  };

  if (runtimeEnv?.API) {
    try {
      const serviceResponse = await runtimeEnv.API.fetch(targetUrl.toString(), init);
      if (!apiBaseUrl || serviceResponse.status !== 503) {
        return serviceResponse;
      }

      const bodyText = await serviceResponse.clone().text();
      if (!bodyText.includes("Couldn't find a local dev session")) {
        return serviceResponse;
      }
    } catch {
      if (!apiBaseUrl) throw new Error("Service binding fetch failed and API_BASE_URL is not configured");
    }
  }

  const fallbackUrl = buildFallbackUrl(path, request.url, apiBaseUrl);
  return fetch(fallbackUrl.toString(), init);
};
