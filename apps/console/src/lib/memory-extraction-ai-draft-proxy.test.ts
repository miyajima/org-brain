import { describe, expect, it, vi } from "vitest";
import { proxyLocalAiDraft, resolveLocalAiDraftEndpoint } from "./memory-extraction-ai-draft-proxy";

const token = "local-test-token-123456";

describe("memory extraction AI draft proxy", () => {
  it("accepts loopback only", () => {
    expect(resolveLocalAiDraftEndpoint("http://127.0.0.1:19088/evaluate")?.port).toBe("19088");
    expect(resolveLocalAiDraftEndpoint("https://api.openai.com/v1/responses")).toBeNull();
    expect(resolveLocalAiDraftEndpoint("http://192.168.1.3:19088/evaluate")).toBeNull();
  });

  it("forwards a same-origin request with the local service token", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-orgbrain-ai-draft-token")).toBe(token);
      return new Response(JSON.stringify({ ok: true, data: { outcome: "no_candidate" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const response = await proxyLocalAiDraft(new Request("http://127.0.0.1:4321/api/evaluation-ai-draft", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4321", "content-type": "application/json" },
      body: JSON.stringify({ contract: "test" })
    }), { endpoint: "http://127.0.0.1:19088/evaluate", token }, fetchImpl);
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin and disabled requests before forwarding", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const crossOrigin = await proxyLocalAiDraft(new Request("http://127.0.0.1:4321/api/evaluation-ai-draft", {
      method: "POST",
      headers: { origin: "https://example.com" },
      body: "{}"
    }), { endpoint: "http://127.0.0.1:19088/evaluate", token }, fetchImpl);
    expect(crossOrigin.status).toBe(403);
    const disabled = await proxyLocalAiDraft(new Request("http://127.0.0.1:4321/api/evaluation-ai-draft", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4321" },
      body: "{}"
    }), {}, fetchImpl);
    expect(disabled.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
