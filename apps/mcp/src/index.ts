import { Hono } from "hono";

type Env = {
  API: Fetcher;
};

const PROXY_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "last-event-id",
  "x-orgbrain-tenant",
  "cf-access-jwt-assertion"
] as const;

const PROXY_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "www-authenticate"
] as const;

export function buildMcpProxyRequest(request: Request): Request {
  const sourceUrl = new URL(request.url);
  const suffix = sourceUrl.pathname.startsWith("/mcp")
    ? sourceUrl.pathname.slice("/mcp".length)
    : sourceUrl.pathname;
  const target = new URL(`https://internal/mcp${suffix || ""}`);
  target.search = sourceUrl.search;
  const headers = new Headers();
  for (const name of PROXY_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-orgbrain-hook-edge", "service-binding-v1");
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 1_048_576) {
    throw new Error("MCP request body exceeds 1 MiB");
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
    duplex: "half"
  };
  return new Request(target, init);
}

async function proxyMcpRequest(request: Request, env: Env): Promise<Response> {
  if (!request.headers.get("cf-access-jwt-assertion")?.trim()) {
    return new Response("missing Cloudflare Access assertion", { status: 401 });
  }
  let upstreamRequest: Request;
  try {
    upstreamRequest = buildMcpProxyRequest(request);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 413 });
  }
  const upstream = await env.API.fetch(upstreamRequest);
  const headers = new Headers();
  for (const name of PROXY_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({
    ok: true,
    name: "open-brain-mcp",
    mcp_path: "/mcp",
    auth: "Cloudflare Access migration edge for per-installation service-token hooks"
  })
);

app.mount("/mcp", (request, env) => proxyMcpRequest(request, env));

export default app;
