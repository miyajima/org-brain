import { defineMiddleware } from "astro:middleware";
import { capabilityPaths, loadConsoleCapabilities } from "./lib/capabilities";

export const onRequest = defineMiddleware(async ({ request, url }, next) => {
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
