import { afterEach, describe, expect, it, vi } from "vitest";
import {
  incrementalPollingSignature,
  isPollingSnapshotStale,
  nextPollingDelay,
  PollingHttpError,
  stablePollingSignature,
  startVisiblePolling
} from "./intelligence-polling";

function installPollingGlobals(hidden = false) {
  const fakeDocument = Object.assign(new EventTarget(), { hidden });
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("window", {
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis)
  });
  return fakeDocument;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("intelligence polling helpers", () => {
  it("backs off from the 30 second cadence and caps the delay", () => {
    expect(nextPollingDelay(0)).toBe(30_000);
    expect(nextPollingDelay(1)).toBe(60_000);
    expect(nextPollingDelay(5)).toBe(300_000);
  });

  it("creates a stable signature while ignoring generated timestamps", () => {
    expect(stablePollingSignature({ generated_at: 1, b: 2, a: { z: 3 } })).toBe(
      stablePollingSignature({ a: { z: 3 }, b: 2, generated_at: 99 })
    );
  });

  it("compares non-page activity state for incremental responses", () => {
    const initial = { events: [{ id: "old" }], observed_agents: [{ id: "a" }], newest_cursor: "one", has_more: true };
    const incremental = { events: [], observed_agents: [{ id: "a" }], newest_cursor: null, has_more: false };
    expect(incrementalPollingSignature(initial, "events")).toBe(incrementalPollingSignature(incremental, "events"));
  });

  it("classifies snapshots stale after two polling intervals", () => {
    expect(isPollingSnapshotStale(940_001, 1_000_000)).toBe(false);
    expect(isPollingSnapshotStale(940_000, 1_000_000)).toBe(true);
    expect(isPollingSnapshotStale(1_100_000, 1_000_000)).toBe(false);
    expect(isPollingSnapshotStale(0, 1_000_000)).toBe(true);
    expect(isPollingSnapshotStale(Number.NaN, 1_000_000)).toBe(true);
  });

  it("pauses while hidden, aborts the in-flight request, and resumes immediately", async () => {
    vi.useFakeTimers();
    const fakeDocument = installPollingGlobals();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      if (signals.length > 1) return Promise.resolve(jsonResponse({ revision: signals.length }));
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as unknown as typeof fetch;
    const states: string[] = [];
    const onError = vi.fn();
    const stop = startVisiblePolling({
      url: "/api/activity",
      intervalMs: 100,
      fetcher,
      onData: vi.fn(),
      onError,
      onStateChange: (state) => states.push(state)
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("refreshing");

    fakeDocument.hidden = true;
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(signals[0].aborted).toBe(true);
    expect(states.at(-1)).toBe("idle");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    fakeDocument.hidden = false;
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("live");
    stop();
    expect(states.at(-1)).toBe("stopped");
  });

  it("uses exponential backoff after a failed visible refresh", async () => {
    vi.useFakeTimers();
    installPollingGlobals();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(jsonResponse({ revision: 2 })) as unknown as typeof fetch;
    const onError = vi.fn();
    const stop = startVisiblePolling({
      url: "/api/activity",
      intervalMs: 100,
      maximumDelayMs: 500,
      fetcher,
      onData: vi.fn(),
      onError
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 200);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    stop();
  });

  it("resolves a fresh request URL for every polling run", async () => {
    vi.useFakeTimers();
    installPollingGlobals();
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ revision: 1 })) as unknown as typeof fetch;
    const url = vi.fn()
      .mockReturnValueOnce("/api/activity?from=1&to=2")
      .mockReturnValueOnce("/api/activity?from=2&to=3");
    const stop = startVisiblePolling({ url, intervalMs: 100, fetcher, onData: vi.fn() });

    await vi.advanceTimersByTimeAsync(200);
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/activity?from=1&to=2", expect.any(Object));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/activity?from=2&to=3", expect.any(Object));
    stop();
  });

  it("exposes a 400 status so an expired activity cursor can reset via page reload", async () => {
    vi.useFakeTimers();
    installPollingGlobals();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 400 })) as unknown as typeof fetch;
    const onError = vi.fn();
    const stop = startVisiblePolling({
      url: "/api/activity?after=expired",
      intervalMs: 100,
      fetcher,
      onData: vi.fn(),
      onError
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(expect.any(PollingHttpError), 200);
    expect((onError.mock.calls[0][0] as PollingHttpError).status).toBe(400);
    stop();
  });
});
