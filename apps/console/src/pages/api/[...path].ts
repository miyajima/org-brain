import type { APIRoute } from "astro";
import { env as cloudflareEnv } from "cloudflare:workers";
import {
  AccessJwtError,
  accessJwtRequired,
  verifyConsoleAccessJwt,
  type ConsoleAccessEnv
} from "../../lib/access-jwt";

type ConsoleWorkerEnv = ConsoleAccessEnv & {
  API?: Fetcher;
  INTERNAL_API_KEY?: string;
  API_BASE_URL?: string;
};

type ProcessLike = {
  env?: Record<string, string | undefined>;
};

function getRuntimeEnv(): ConsoleWorkerEnv {
  const processEnv = (globalThis as typeof globalThis & { process?: ProcessLike }).process?.env ?? {};
  const runtimeEnv = cloudflareEnv as unknown as ConsoleWorkerEnv;
  return {
    API: runtimeEnv.API,
    INTERNAL_API_KEY: runtimeEnv.INTERNAL_API_KEY ?? processEnv.INTERNAL_API_KEY,
    API_BASE_URL: runtimeEnv.API_BASE_URL ?? processEnv.API_BASE_URL,
    ACCESS_TEAM_DOMAIN: runtimeEnv.ACCESS_TEAM_DOMAIN ?? processEnv.ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: runtimeEnv.ACCESS_AUD ?? processEnv.ACCESS_AUD,
    ACCESS_JWKS_JSON: runtimeEnv.ACCESS_JWKS_JSON ?? processEnv.ACCESS_JWKS_JSON,
    ACCESS_JWT_REQUIRED: runtimeEnv.ACCESS_JWT_REQUIRED ?? processEnv.ACCESS_JWT_REQUIRED
  };
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

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
  const runtimeEnv = getRuntimeEnv();
  if (accessJwtRequired(runtimeEnv)) {
    const accessJwt = request.headers.get("cf-access-jwt-assertion")?.trim();
    if (!accessJwt) return jsonError(401, "unauthorized", "Missing Cloudflare Access JWT");
    try {
      await verifyConsoleAccessJwt(runtimeEnv, accessJwt);
    } catch (error) {
      if (error instanceof AccessJwtError) {
        return jsonError(error.status, error.status === 401 ? "unauthorized" : "misconfigured", error.message);
      }
      return jsonError(500, "access_verification_failed", "Cloudflare Access JWT verification failed");
    }
  }
  const apiBaseUrl = typeof runtimeEnv?.API_BASE_URL === "string" ? runtimeEnv.API_BASE_URL.trim() : "";
  if ((!runtimeEnv?.API && !apiBaseUrl) || !runtimeEnv?.INTERNAL_API_KEY) {
    return jsonError(500, "misconfigured", "Missing API binding/API_BASE_URL or INTERNAL_API_KEY");
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
