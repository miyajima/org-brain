import { HttpError } from "@org-brain/shared";
import type { Env } from "./types";

export async function assertRequestRateLimit(
  env: Env,
  input: { tenantId: string; principal: string; path: string }
): Promise<void> {
  if (!env.API_RATE_LIMITER) return;
  const key = `${input.tenantId}:${input.principal}:${input.path}`.slice(0, 512);
  const result = await env.API_RATE_LIMITER.limit({ key });
  if (!result.success) {
    throw new HttpError(429, "rate_limited", "Request rate limit exceeded");
  }
}
