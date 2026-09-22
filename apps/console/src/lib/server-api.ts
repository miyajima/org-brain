/** Bind server-rendered API calls to the incoming user's identity. */
export function createServerApi(request: Request, transport: typeof fetch = fetch) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const incoming = new URL(request.url);
    const target = new URL(input, incoming);
    if (target.origin !== incoming.origin || !target.pathname.startsWith("/api/")) {
      throw new Error("Server API requests must target the same-origin API");
    }
    const headers = new Headers(init.headers);
    for (const name of ["cookie", "cf-access-jwt-assertion", "authorization"]) {
      headers.delete(name);
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.delete("x-api-key");
    const method = (init.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const readOnlyPost = method === "POST" && ["/api/v1/memories/search", "/api/v1/memories/profile", "/api/v1/decision-memories/search"].includes(target.pathname);
      const origin = readOnlyPost && request.method === "GET" ? incoming.origin : request.headers.get("origin");
      if (origin !== incoming.origin || request.headers.get("sec-fetch-site") === "cross-site") {
        return new Response(JSON.stringify({ ok: false, error: { code: "origin_failed", message: "Invalid request origin" } }), {
          status: 403, headers: { "content-type": "application/json" }
        });
      }
      headers.set("origin", origin);
    }
    return transport(target, { ...init, headers, redirect: "manual" });
  };
}
