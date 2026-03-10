import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class DurableObject<Env = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  }

  return { DurableObject };
});

import { LeaseDO } from "../src/do/lease";

type StorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

function createStorage(): StorageLike {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
    }
  };
}

function createLeaseDo() {
  const storage = createStorage();
  const state = { storage } as any;
  const lease = new LeaseDO(state, {} as any);
  return { lease, storage };
}

describe("LeaseDO", () => {
  it("rejects duplicate acquire for the same task id", async () => {
    const { lease } = createLeaseDo();

    const first = await lease.fetch(
      new Request("https://leases/acquire", {
        method: "POST",
        body: JSON.stringify({ task_id: "t1", ttl_ms: 60_000, max_concurrency: 2 })
      })
    );
    const second = await lease.fetch(
      new Request("https://leases/acquire", {
        method: "POST",
        body: JSON.stringify({ task_id: "t1", ttl_ms: 60_000, max_concurrency: 2 })
      })
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("enforces capacity and allows acquire after release", async () => {
    const { lease } = createLeaseDo();

    const first = await lease.fetch(
      new Request("https://leases/acquire", {
        method: "POST",
        body: JSON.stringify({ task_id: "t1", ttl_ms: 60_000, max_concurrency: 1 })
      })
    );
    const second = await lease.fetch(
      new Request("https://leases/acquire", {
        method: "POST",
        body: JSON.stringify({ task_id: "t2", ttl_ms: 60_000, max_concurrency: 1 })
      })
    );
    const released = await lease.fetch(
      new Request("https://leases/release", {
        method: "POST",
        body: JSON.stringify({ task_id: "t1" })
      })
    );
    const third = await lease.fetch(
      new Request("https://leases/acquire", {
        method: "POST",
        body: JSON.stringify({ task_id: "t2", ttl_ms: 60_000, max_concurrency: 1 })
      })
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, reason: "capacity" });
    expect(released.status).toBe(200);
    expect(third.status).toBe(200);
  });
});

