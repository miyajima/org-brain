import { HttpError } from "@org-brain/shared";
import type { Env } from "./types";

export async function assertRequestRateLimit(
  env: Env,
  input: { tenantId: string; principal: string; path: string }
): Promise<void> {
  if (!env.API_RATE_LIMITER) {
    if (env.API_RATE_LIMIT_FAIL_OPEN === "true") return;
    throw new HttpError(503, "rate_limit_unavailable", "API rate limiter is not configured");
  }
  const key = `${input.tenantId}:${input.principal}:${input.path}`.slice(0, 512);
  let result: Awaited<ReturnType<NonNullable<Env["API_RATE_LIMITER"]>["limit"]>>;
  try {
    result = await env.API_RATE_LIMITER.limit({ key });
  } catch {
    throw new HttpError(503, "rate_limit_unavailable", "API rate limiter request failed");
  }
  if (!result.success) {
    throw new HttpError(429, "rate_limited", "Request rate limit exceeded");
  }
}
