export type PollingState = "idle" | "refreshing" | "live" | "backoff" | "stopped";

export class PollingHttpError extends Error {
  constructor(readonly status: number) {
    super(`Polling request failed with HTTP ${status}`);
    this.name = "PollingHttpError";
  }
}

export type VisiblePollingOptions<T> = {
  url: string | (() => string);
  intervalMs?: number;
  maximumDelayMs?: number;
  fetcher?: typeof fetch;
  onData: (data: T) => void | Promise<void>;
  onError?: (error: unknown, retryInMs: number) => void;
  onStateChange?: (state: PollingState) => void;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "generated_at")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

export function stablePollingSignature(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function incrementalPollingSignature(value: unknown, itemField: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return stablePollingSignature(value);
  const ignored = new Set([itemField, "generated_at", "oldest_cursor", "newest_cursor", "has_more"]);
  return stablePollingSignature(
    Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !ignored.has(key)))
  );
}

export function nextPollingDelay(
  failureCount: number,
  intervalMs = 30_000,
  maximumDelayMs = 300_000
): number {
  const failures = Math.max(0, Math.floor(failureCount));
  return Math.min(maximumDelayMs, intervalMs * 2 ** failures);
}

export function isPollingSnapshotStale(
  generatedAt: number,
  now = Date.now(),
  staleAfterMs = 60_000
): boolean {
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) return true;
  return Math.max(0, now - generatedAt) >= Math.max(0, staleAfterMs);
}

export function startVisiblePolling<T>(options: VisiblePollingOptions<T>): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;

  const intervalMs = options.intervalMs ?? 30_000;
  const maximumDelayMs = options.maximumDelayMs ?? 300_000;
  const fetcher = options.fetcher ?? window.fetch.bind(window);
  let timeoutId: number | null = null;
  let controller: AbortController | null = null;
  let failureCount = 0;
  let stopped = false;

  const clearScheduledRun = () => {
    if (timeoutId === null) return;
    window.clearTimeout(timeoutId);
    timeoutId = null;
  };

  const schedule = (delay: number) => {
    if (stopped || document.hidden) return;
    clearScheduledRun();
    timeoutId = window.setTimeout(run, delay);
  };

  const run = async () => {
    timeoutId = null;
    if (stopped) return;
    if (document.hidden) {
      options.onStateChange?.("idle");
      return;
    }

    options.onStateChange?.("refreshing");
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    try {
      const requestUrl = typeof options.url === "function" ? options.url() : options.url;
      const response = await fetcher(requestUrl, {
        headers: { accept: "application/json" },
        signal: requestController.signal
      });
      if (!response.ok) throw new PollingHttpError(response.status);
      const envelope = await response.json() as { ok?: boolean; data?: T; error?: { message?: string } } | T;
      if (stopped || document.hidden || requestController.signal.aborted) return;
      if (envelope && typeof envelope === "object" && "ok" in envelope) {
        if (envelope.ok !== true || !("data" in envelope)) {
          throw new Error(envelope.error?.message ?? "Polling response was not successful");
        }
        await options.onData(envelope.data as T);
      } else {
        await options.onData(envelope as T);
      }
      failureCount = 0;
      options.onStateChange?.("live");
      schedule(intervalMs);
    } catch (error) {
      if (
        stopped
        || document.hidden
        || requestController.signal.aborted
        || (error instanceof Error && error.name === "AbortError")
      ) return;
      failureCount += 1;
      const retryInMs = nextPollingDelay(failureCount, intervalMs, maximumDelayMs);
      options.onStateChange?.("backoff");
      options.onError?.(error, retryInMs);
      schedule(retryInMs);
    } finally {
      if (controller === requestController) controller = null;
    }
  };

  const handleVisibility = () => {
    if (document.hidden) {
      clearScheduledRun();
      controller?.abort();
      controller = null;
      options.onStateChange?.("idle");
      return;
    }
    schedule(0);
  };
  document.addEventListener("visibilitychange", handleVisibility);
  if (document.hidden) options.onStateChange?.("idle");
  else schedule(intervalMs);

  return () => {
    stopped = true;
    options.onStateChange?.("stopped");
    document.removeEventListener("visibilitychange", handleVisibility);
    controller?.abort();
    controller = null;
    clearScheduledRun();
  };
}
