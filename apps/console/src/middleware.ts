import { defineMiddleware } from "astro:middleware";
import { capabilityPaths, loadConsoleCapabilities } from "./lib/capabilities";
import { legacyConsoleDestination } from "./lib/operator-console";

export const onRequest = defineMiddleware(async ({ request, url, locals }, next) => {
  if (request.method === "GET" && url.searchParams.get("advanced") !== "1") {
    const destination = legacyConsoleDestination(url);
    if (destination) return new Response(null, { status: 302, headers: { location: destination, "cache-control": "no-store" } });
  }
  if (request.method === "POST" && url.pathname === "/settings") {
    // Render the selected controller before reading its success receipt. Buffering
    // this form response avoids depending on streaming component header timing.
    const response = await next();
    const html = await response.text();
    const destination = (locals as Record<string, unknown>).operatorPostRedirect;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (response.status < 400 && typeof destination === "string" && (destination === "/settings" || destination.startsWith("/settings?"))) {
      headers.set("location", destination);
      headers.set("cache-control", "private, no-store");
      headers.delete("content-type");
      return new Response(null, { status: 303, headers });
    }
    return new Response(html, { status: response.status, headers });
  }
  const entry = Object.entries(capabilityPaths).find(([path]) => url.pathname === path || url.pathname.startsWith(`${path}/`));
  if (!entry) return next();
  const capabilities = await loadConsoleCapabilities(request);
  if (capabilities?.[entry[1]]?.enabled) return next();
  const lang = url.searchParams.get("lang") ?? "ja";
  const copy = lang === "en" ? ["Feature unavailable", "This feature is disabled or its availability could not be checked.", "Back to home"]
    : lang === "zh" ? ["功能不可用", "此功能未启用，或暂时无法确认其状态。", "返回首页"]
    : ["この機能は利用できません", "機能が無効になっているか、現在の提供状態を確認できません。", "ホームに戻る"];
  return new Response(`<!doctype html><html lang="${["ja", "en", "zh"].includes(lang) ? lang : "ja"}"><meta charset="utf-8"><title>${copy[0]}</title><main><h1>${copy[0]}</h1><p>${copy[1]}</p><a href="/">${copy[2]}</a></main></html>`, {
    status: capabilities ? 404 : 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
});
