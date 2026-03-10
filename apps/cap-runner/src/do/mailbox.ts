import { mailboxPushSchema } from "@org-brain/shared";
import { DurableObject } from "cloudflare:workers";

const LIMIT = 200;

export class MailboxDO extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/push" && req.method === "POST") {
      return this.push(req);
    }
    if (url.pathname === "/pull" && req.method === "GET") {
      return this.pull(req);
    }
    return new Response("not found", { status: 404 });
  }

  private async push(req: Request): Promise<Response> {
    const incoming = mailboxPushSchema.parse(await req.json<unknown>());
    const list = (await this.ctx.storage.get<Array<Record<string, unknown>>>("events")) ?? [];
    list.push({ ...incoming, ts: incoming.ts ?? Date.now() });
    while (list.length > LIMIT) {
      list.shift();
    }
    await this.ctx.storage.put("events", list);
    return Response.json({ ok: true });
  }

  private async pull(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
    const list = (await this.ctx.storage.get<Array<{ ts?: number } & Record<string, unknown>>>("events")) ?? [];

    const filtered = list.filter((entry: { ts?: number }) => (entry.ts ?? 0) >= (Number.isNaN(since) ? 0 : since));
    return Response.json({ ok: true, events: filtered.slice(Math.max(0, filtered.length - limit)) });
  }
}
