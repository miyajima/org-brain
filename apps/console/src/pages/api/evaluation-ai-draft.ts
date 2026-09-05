import type { APIRoute } from "astro";
import { proxyLocalAiDraft } from "../../lib/memory-extraction-ai-draft-proxy";

type ProcessLike = { env?: Record<string, string | undefined> };

function runtimeValue(name: string): string | undefined {
  const processEnv = (globalThis as typeof globalThis & { process?: ProcessLike }).process?.env ?? {};
  return processEnv[name] ?? (import.meta.env as Record<string, string | undefined>)[name];
}

export const POST: APIRoute = async ({ request }) => proxyLocalAiDraft(request, {
  endpoint: runtimeValue("MEMORY_EXTRACTION_AI_DRAFT_URL"),
  token: runtimeValue("MEMORY_EXTRACTION_AI_DRAFT_TOKEN")
});

export const ALL: APIRoute = async () => new Response(JSON.stringify({
  ok: false,
  error: { code: "method_not_allowed", message: "POST only" }
}), {
  status: 405,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" }
});
