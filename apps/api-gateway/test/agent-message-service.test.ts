import { describe, expect, it } from "vitest";
import {
  ackAgentMessage,
  getAgentMessage,
  listAgentMessages,
  markAgentMessageRead,
  sendAgentMessage
} from "../src/agent-message-service";

type MessageRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  thread_id: string;
  reply_to_message_id: string | null;
  sender_principal: string;
  target_type: "principal" | "agent" | "project" | "channel";
  target_key: string;
  subject: string | null;
  body: string;
  metadata_json: string | null;
  idempotency_key: string | null;
  status: "unread" | "read" | "acked" | "archived";
  created_at: number;
  read_at: number | null;
  acked_at: number | null;
  archived_at: number | null;
};

class FakeStatement {
  args: unknown[] = [];

  constructor(
    private db: FakeD1,
    public sql: string
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    if (this.sql.includes("WHERE tenant_id = ? AND idempotency_key = ?")) {
      const [tenantId, idempotencyKey] = this.args as [string, string];
      const found = this.db.messages.find((row) => row.tenant_id === tenantId && row.idempotency_key === idempotencyKey);
      return (found ? { id: found.id, thread_id: found.thread_id, status: found.status } : null) as T | null;
    }

    if (this.sql.includes("SELECT thread_id FROM agent_messages")) {
      const [tenantId, id] = this.args as [string, string];
      const found = this.db.messages.find((row) => row.tenant_id === tenantId && row.id === id);
      return (found ? { thread_id: found.thread_id } : null) as T | null;
    }

    if (this.sql.includes("WHERE tenant_id = ? AND id = ? AND target_type = ? AND target_key = ?")) {
      const [tenantId, id, targetType, targetKey] = this.args as [string, string, string, string];
      const found = this.db.messages.find(
        (row) =>
          row.tenant_id === tenantId &&
          row.id === id &&
          row.target_type === targetType &&
          row.target_key === targetKey
      );
      return (found ?? null) as T | null;
    }

    return null;
  }

  async all<T>() {
    if (!this.sql.includes("FROM agent_messages")) {
      return { results: [] as T[] };
    }

    const [tenantId, targetType, targetKey] = this.args as [string, string, string];
    let argIndex = 3;
    let rows = this.db.messages.filter(
      (row) => row.tenant_id === tenantId && row.target_type === targetType && row.target_key === targetKey
    );

    if (this.sql.includes("status IN")) {
      rows = rows.filter((row) => row.status === "unread" || row.status === "read");
    } else if (this.sql.includes("status = ?")) {
      const status = this.args[argIndex++] as string;
      rows = rows.filter((row) => row.status === status);
    }

    if (this.sql.includes("project_id = ?")) {
      const projectId = this.args[argIndex++] as string;
      rows = rows.filter((row) => row.project_id === projectId);
    }

    if (this.sql.includes("created_at < ?")) {
      const cursor = this.args[argIndex++] as number;
      rows = rows.filter((row) => row.created_at < cursor);
    }

    const limit = this.args[argIndex] as number;
    rows = [...rows].sort((left, right) => right.created_at - left.created_at).slice(0, limit);
    return { results: rows as T[] };
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO agent_messages")) {
      this.db.messages.push({
        id: this.args[0] as string,
        tenant_id: this.args[1] as string,
        project_id: this.args[2] as string | null,
        thread_id: this.args[3] as string,
        reply_to_message_id: this.args[4] as string | null,
        sender_principal: this.args[5] as string,
        target_type: this.args[6] as MessageRow["target_type"],
        target_key: this.args[7] as string,
        subject: this.args[8] as string | null,
        body: this.args[9] as string,
        metadata_json: this.args[10] as string | null,
        idempotency_key: this.args[11] as string | null,
        status: this.args[12] as MessageRow["status"],
        created_at: this.args[13] as number,
        read_at: null,
        acked_at: null,
        archived_at: null
      });
    }

    if (this.sql.startsWith("UPDATE agent_messages SET status = ?, read_at = ?")) {
      const [status, readAt, tenantId, id] = this.args as [MessageRow["status"], number, string, string];
      const found = this.db.messages.find((row) => row.tenant_id === tenantId && row.id === id);
      if (found) {
        found.status = status;
        found.read_at = readAt;
      }
    }

    if (this.sql.startsWith("UPDATE agent_messages SET status = ?, acked_at = ?")) {
      const [status, ackedAt, readAt, tenantId, id] = this.args as [MessageRow["status"], number, number, string, string];
      const found = this.db.messages.find((row) => row.tenant_id === tenantId && row.id === id);
      if (found) {
        found.status = status;
        found.acked_at = ackedAt;
        found.read_at = found.read_at ?? readAt;
      }
    }

    return { success: true };
  }
}

class FakeD1 {
  messages: MessageRow[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

function env(db = new FakeD1()) {
  return { OPEN_BRAIN_DB: db } as any;
}

describe("agent message service", () => {
  it("sends, lists, reads, gets, and acks messages for a target inbox", async () => {
    const db = new FakeD1();
    const first = await sendAgentMessage(env(db), {
      tenant_id: "default",
      project_id: "org-brain",
      target_type: "principal",
      target_key: "service:receiver",
      subject: "hello",
      body: "please check this",
      metadata: { priority: "normal" }
    }, { principal: "service:sender" });

    const inbox = await listAgentMessages(env(db), {
      tenant_id: "default"
    }, { principal: "service:receiver" });

    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      id: first.message_id,
      sender_principal: "service:sender",
      target_key: "service:receiver",
      status: "unread",
      metadata: { priority: "normal" }
    });

    const read = await markAgentMessageRead(env(db), "default", first.message_id, {}, { principal: "service:receiver" });
    expect(read.status).toBe("read");
    expect(read.read_at).toBeTruthy();

    const fetched = await getAgentMessage(env(db), "default", first.message_id, {}, { principal: "service:receiver" });
    expect(fetched.status).toBe("read");

    const acked = await ackAgentMessage(env(db), "default", first.message_id, {}, { principal: "service:receiver" });
    expect(acked.status).toBe("acked");
    expect(acked.acked_at).toBeTruthy();
  });

  it("dedupes only when idempotency key is supplied and inherits reply threads", async () => {
    const db = new FakeD1();
    const first = await sendAgentMessage(env(db), {
      tenant_id: "default",
      target_type: "agent",
      target_key: "codex",
      body: "root",
      idempotency_key: "msg-1"
    }, { principal: "service:sender" });

    const duplicate = await sendAgentMessage(env(db), {
      tenant_id: "default",
      target_type: "agent",
      target_key: "codex",
      body: "root",
      idempotency_key: "msg-1"
    }, { principal: "service:sender" });

    const reply = await sendAgentMessage(env(db), {
      tenant_id: "default",
      target_type: "agent",
      target_key: "codex",
      body: "reply",
      reply_to_message_id: first.message_id
    }, { principal: "service:sender" });

    expect(duplicate).toMatchObject({ message_id: first.message_id, deduped: true });
    expect(reply.thread_id).toBe(first.thread_id);
    expect(db.messages).toHaveLength(2);
  });

  it("rejects replies that try to override the parent thread", async () => {
    const db = new FakeD1();
    const first = await sendAgentMessage(env(db), {
      tenant_id: "default",
      target_type: "agent",
      target_key: "codex",
      body: "root"
    }, { principal: "service:sender" });

    await expect(
      sendAgentMessage(env(db), {
        tenant_id: "default",
        target_type: "agent",
        target_key: "codex",
        body: "reply",
        reply_to_message_id: first.message_id,
        thread_id: "different-thread"
      }, { principal: "service:sender" })
    ).rejects.toThrow(/thread_id/i);
  });

  it("does not allow another target to read or ack a message", async () => {
    const db = new FakeD1();
    const message = await sendAgentMessage(env(db), {
      tenant_id: "default",
      target_type: "principal",
      target_key: "service:receiver",
      body: "private"
    }, { principal: "service:sender" });

    await expect(
      markAgentMessageRead(env(db), "default", message.message_id, {}, { principal: "service:other" })
    ).rejects.toThrow(/not found/i);
  });
});
