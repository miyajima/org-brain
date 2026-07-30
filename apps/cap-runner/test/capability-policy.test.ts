import { describe, expect, it } from "vitest";
import {
  assertWithinCapabilityCostLimit,
  loadCapabilityPolicy
} from "../src/capability-policy";

describe("capability operational policy", () => {
  it("loads concurrency quota and execution cost ceiling", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              first: async () => ({ max_concurrency: 4, cost_limit_ms: 12_000 })
            };
          }
        };
      }
    } as any;
    await expect(loadCapabilityPolicy(db, "tenant-a", "memory_measurement")).resolves.toEqual({
      maxConcurrency: 4,
      costLimitMs: 12_000
    });
  });

  it("rejects results that exceed the configured cost ceiling", () => {
    expect(() => assertWithinCapabilityCostLimit(12_001, 12_000))
      .toThrow("capability cost ceiling exceeded");
    expect(() => assertWithinCapabilityCostLimit(12_000, 12_000)).not.toThrow();
    expect(() => assertWithinCapabilityCostLimit(99_999, 0)).not.toThrow();
  });
});
