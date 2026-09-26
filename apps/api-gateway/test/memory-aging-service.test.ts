import { describe, expect, it } from "vitest";
import { getMemoryAgingPlan } from "../src/memory-aging-service";

describe("memory aging service", () => {
  it("returns read-only candidates based on verified-use rows from the database", async () => {
    const now = 200 * 86_400_000;
    const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [
      { id: "old", kind: "episodic", lifecycle_state: "active", created_at: now - 181 * 86_400_000 },
      { id: "used", kind: "episodic", lifecycle_state: "active", created_at: now - 181 * 86_400_000, last_verified_use_at: now - 2 * 86_400_000 }
    ] }) }) }) };
    const result = await getMemoryAgingPlan({ OPEN_BRAIN_DB: db } as any, "tenant", "project", now);
    expect(result.mode).toBe("shadow");
    expect(result.candidates.map((item: { id: string }) => item.id)).toEqual(["old"]);
    expect(result.mutations).toBe(0);
  });
});
