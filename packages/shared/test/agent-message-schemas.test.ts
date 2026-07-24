import { describe, expect, it } from "vitest";
import {
  agentMessageActionSchema,
  listAgentMessagesSchema,
  sendAgentMessageSchema
} from "../src/schemas";

describe("agent message schemas", () => {
  it("accepts a valid send request", () => {
    expect(
      sendAgentMessageSchema.parse({
        tenant_id: "default",
        target_type: "agent",
        target_key: "codex",
        body: "please review",
        metadata: { priority: "normal" }
      })
    ).toMatchObject({
      tenant_id: "default",
      target_type: "agent",
      target_key: "codex"
    });
  });

  it("rejects invalid target types", () => {
    expect(() =>
      sendAgentMessageSchema.parse({
        target_type: "unknown",
        target_key: "codex",
        body: "please review"
      })
    ).toThrow();
    expect(() =>
      sendAgentMessageSchema.parse({
        target_type: "agent",
        target_key: "   ",
        body: "please review"
      })
    ).toThrow();
  });

  it("defaults list status to active and accepts action target overrides", () => {
    expect(listAgentMessagesSchema.parse({})).toMatchObject({ status: "active" });
    expect(
      agentMessageActionSchema.parse({
        target_type: "channel",
        target_key: "general"
      })
    ).toMatchObject({
      target_type: "channel",
      target_key: "general"
    });
  });
});
