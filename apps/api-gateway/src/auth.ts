import { HttpError } from "@org-brain/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./types";

export const apiKeyAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const provided = c.req.header("x-api-key");
  if (!provided || provided !== c.env.API_KEY) {
    throw new HttpError(401, "unauthorized", "Missing or invalid API key");
  }
  await next();
};

export function jsonOk<T>(c: Context<{ Bindings: Env }>, data: T, status: number = 200): Response {
  return c.json({ ok: true as const, data }, { status: status as 200 });
}
