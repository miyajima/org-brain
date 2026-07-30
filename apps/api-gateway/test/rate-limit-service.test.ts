import { describe, expect, it } from "vitest";
import { assertRequestRateLimit } from "../src/rate-limit-service";

describe("API rate limit binding", () => {
  it("is optional for self-hosted/local deployments", async () => {
    await expect(assertRequestRateLimit({} as any, {
      tenantId: "default",
      principal: "user:test",
      path: "/v1/memories/search"
    })).resolves.toBeUndefined();
  });

  it("keys limits by tenant, principal, and route and returns 429 on rejection", async () => {
    const keys: string[] = [];
    const env = {
      API_RATE_LIMITER: {
        async limit({ key }: { key: string }) {
          keys.push(key);
          return { success: false };
        }
      }
    } as any;
    await expect(assertRequestRateLimit(env, {
      tenantId: "tenant-a",
      principal: "service:agent",
      path: "/v1/memories/capture"
    })).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(keys).toEqual(["tenant-a:service:agent:/v1/memories/capture"]);
  });
});
