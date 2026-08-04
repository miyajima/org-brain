import { describe, expect, it } from "vitest";
import { assertRequestRateLimit } from "../src/rate-limit-service";

describe("API rate limit binding", () => {
  it("fails closed when the binding is missing", async () => {
    await expect(assertRequestRateLimit({} as any, {
      tenantId: "default",
      principal: "user:test",
      path: "/v1/memories/search"
    })).rejects.toMatchObject({ status: 503, code: "rate_limit_unavailable" });
  });

  it("allows an explicit local fail-open override", async () => {
    await expect(assertRequestRateLimit({ API_RATE_LIMIT_FAIL_OPEN: "true" } as any, {
      tenantId: "default",
      principal: "user:test",
      path: "/v1/memories/search"
    })).resolves.toBeUndefined();
  });

  it("fails closed when the limiter service errors", async () => {
    const env = {
      API_RATE_LIMITER: {
        async limit() {
          throw new Error("binding unavailable");
        }
      }
    } as any;
    await expect(assertRequestRateLimit(env, {
      tenantId: "default",
      principal: "user:test",
      path: "/mcp"
    })).rejects.toMatchObject({ status: 503, code: "rate_limit_unavailable" });
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
