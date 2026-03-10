import { leaseAcquireSchema, leaseReleaseSchema } from "@org-brain/shared";
import { DurableObject } from "cloudflare:workers";

export class LeaseDO extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/acquire" && req.method === "POST") {
      return this.acquire(req);
    }
    if (url.pathname === "/renew" && req.method === "POST") {
      return this.renew(req);
    }
    if (url.pathname === "/release" && req.method === "POST") {
      return this.release(req);
    }
    return new Response("not found", { status: 404 });
  }

  private async readRunning(): Promise<Record<string, number>> {
    return (await this.ctx.storage.get<Record<string, number>>("running")) ?? {};
  }

  private async writeRunning(running: Record<string, number>) {
    await this.ctx.storage.put("running", running);
  }

  private garbageCollect(running: Record<string, number>, now: number): Record<string, number> {
    const next: Record<string, number> = {};
    for (const [taskId, expiresAt] of Object.entries(running)) {
      if (expiresAt > now) {
        next[taskId] = expiresAt;
      }
    }
    return next;
  }

  private async acquire(req: Request): Promise<Response> {
    const body = leaseAcquireSchema.parse(await req.json<unknown>());
    const now = Date.now();
    const running = this.garbageCollect(await this.readRunning(), now);
    const limit = body.max_concurrency ?? (await this.ctx.storage.get<number>("limit")) ?? 2;
    await this.ctx.storage.put("limit", limit);

    const existing = running[body.task_id];
    if (existing && existing > now) {
      await this.writeRunning(running);
      return Response.json({ ok: false, reason: "duplicate", lease_until: existing }, { status: 409 });
    }

    if (Object.keys(running).length >= limit) {
      await this.writeRunning(running);
      return Response.json({ ok: false, reason: "capacity" }, { status: 409 });
    }

    running[body.task_id] = now + Math.max(5_000, body.ttl_ms ?? 60_000);
    await this.writeRunning(running);

    return Response.json({ ok: true, lease_until: running[body.task_id] });
  }

  private async renew(req: Request): Promise<Response> {
    const body = leaseAcquireSchema.parse(await req.json<unknown>());
    const now = Date.now();
    const running = this.garbageCollect(await this.readRunning(), now);
    if (!(body.task_id in running)) {
      return Response.json({ ok: false, reason: "missing" }, { status: 404 });
    }

    running[body.task_id] = now + Math.max(5_000, body.ttl_ms ?? 60_000);
    await this.writeRunning(running);
    return Response.json({ ok: true, lease_until: running[body.task_id] });
  }

  private async release(req: Request): Promise<Response> {
    const body = leaseReleaseSchema.parse(await req.json<unknown>());
    const running = await this.readRunning();
    delete running[body.task_id];
    await this.writeRunning(running);
    return Response.json({ ok: true });
  }
}
