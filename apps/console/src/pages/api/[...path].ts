import type { APIRoute } from "astro";
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
  SESSION_ONLY_API?: string;
};

type ProcessLike = {
  env?: Record<string, string | undefined>;
};

async function getRuntimeEnv(): Promise<ConsoleWorkerEnv> {
  const processEnv = (globalThis as typeof globalThis & { process?: ProcessLike }).process?.env ?? {};
  // Astro/Vite exposes shell variables through import.meta.env in dev even
  // when its SSR sandbox provides an empty process.env object.
  const localEnv = {
    ...(import.meta.env as Record<string, string | undefined>),
    ...processEnv
  };
  let runtimeEnv: ConsoleWorkerEnv = {};
  if (!localEnv.API_BASE_URL && !localEnv.INTERNAL_API_KEY && localEnv.SESSION_ONLY_API !== "true") {
    try {
      runtimeEnv = (await import("cloudflare:workers")).env as unknown as ConsoleWorkerEnv;
    } catch {
      runtimeEnv = {};
    }
  }
  return {
    API: runtimeEnv.API,
    INTERNAL_API_KEY: runtimeEnv.INTERNAL_API_KEY ?? localEnv.INTERNAL_API_KEY,
    API_BASE_URL: runtimeEnv.API_BASE_URL ?? localEnv.API_BASE_URL,
    SESSION_ONLY_API: runtimeEnv.SESSION_ONLY_API ?? localEnv.SESSION_ONLY_API,
    ACCESS_TEAM_DOMAIN: runtimeEnv.ACCESS_TEAM_DOMAIN ?? localEnv.ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: runtimeEnv.ACCESS_AUD ?? localEnv.ACCESS_AUD,
    ACCESS_JWKS_JSON: runtimeEnv.ACCESS_JWKS_JSON ?? localEnv.ACCESS_JWKS_JSON,
    ACCESS_JWT_REQUIRED: runtimeEnv.ACCESS_JWT_REQUIRED ?? localEnv.ACCESS_JWT_REQUIRED
  };
}

function jsonError(status: number, code: string, message: string): Response {
  console.warn(JSON.stringify({
    console_view: "api_proxy",
    phase: code,
    status
  }));
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function logUpstreamFailure(response: Response): Promise<void> {
  if (response.status < 400) return;
  let code = "upstream_error";
  try {
    const payload = await response.clone().json() as { error?: { code?: string } };
    if (typeof payload.error?.code === "string") code = payload.error.code;
  } catch {
    // Keep logs metadata-only when the upstream body is not JSON.
  }
  console.warn(JSON.stringify({
    console_view: "api_proxy",
    phase: code,
    status: response.status
  }));
}

export function stripProxyHeaders(headers: Headers): Headers {
  const next = new Headers();
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "x-api-key" ||
      lower === "cf-access-jwt-assertion" ||
      lower === "cf-access-authenticated-user-email"
    ) continue;
    next.set(key, value);
  }
  return next;
}

export function applyProxyAuthentication(
  headers: Headers,
  path: string,
  accessJwt: string | null,
  internalApiKey: string | undefined
): Headers {
  const next = new Headers(headers);
  if (path.startsWith("v1/mcp-client-installations") && accessJwt) {
    // Client installations belong to the signed-in human, not the Console
    // service principal. The JWT has already been verified at this boundary;
    // the API verifies it again before resolving the Org Brain user identity.
    next.set("cf-access-jwt-assertion", accessJwt);
    return next;
  }
  if (internalApiKey) next.set("x-api-key", internalApiKey);
  return next;
}

export function normalizeFallbackResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  // Fetch runtimes transparently decode gzip/br payloads but retain the
  // upstream encoding headers. Forwarding those headers makes Node clients
  // attempt a second decode and turns valid JSON into an unreadable body.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function buildFallbackUrl(path: string, requestUrl: string, apiBaseUrl: string): URL {
  const baseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const fallbackUrl = new URL(path, baseUrl);
  fallbackUrl.search = new URL(requestUrl).search;
  return fallbackUrl;
}

export const ALL: APIRoute = async ({ params, request }) => {
  const runtimeEnv = await getRuntimeEnv();
  const accessJwt = request.headers.get("cf-access-jwt-assertion")?.trim() || null;
  if (accessJwtRequired(runtimeEnv)) {
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
  if ((!runtimeEnv?.API && !apiBaseUrl) || (!runtimeEnv?.INTERNAL_API_KEY && runtimeEnv.SESSION_ONLY_API !== "true")) {
    return jsonError(500, "misconfigured", "Missing API binding/API_BASE_URL or API authentication mode");
  }

  const path = params.path ?? "";
  const targetUrl = new URL(`https://internal/${path}`);
  targetUrl.search = new URL(request.url).search;

  const headers = applyProxyAuthentication(
    stripProxyHeaders(request.headers),
    path,
    accessJwt,
    runtimeEnv.INTERNAL_API_KEY
  );

  const init = {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer()
  };

  // API_BASE_URL is an explicit operator override (used by the private local
  // snapshot). When it is present, do not let an auto-discovered dev service
  // binding silently route the request to a different worker.
  if (runtimeEnv?.API && !apiBaseUrl) {
    try {
      const serviceResponse = await runtimeEnv.API.fetch(targetUrl.toString(), init);
      await logUpstreamFailure(serviceResponse);
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
  const fallbackResponse = await fetch(fallbackUrl.toString(), init);
  await logUpstreamFailure(fallbackResponse);
  return normalizeFallbackResponse(fallbackResponse);
};
