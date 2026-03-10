import type { APIRoute } from "astro";

function stripHeaders(headers: Headers): Headers {
  const next = new Headers();
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "x-api-key") continue;
    next.set(key, value);
  }
  return next;
}

export const ALL: APIRoute = async ({ params, request, locals }) => {
  const env = (locals as any).runtime?.env;
  if (!env?.API || !env?.INTERNAL_API_KEY) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: { code: "misconfigured", message: "Missing API binding or INTERNAL_API_KEY" }
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
  headers.set("x-api-key", env.INTERNAL_API_KEY);

  return env.API.fetch(targetUrl.toString(), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer()
  });
};
