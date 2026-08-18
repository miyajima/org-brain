import { describe, expect, it } from "vitest";
import {
  AGENT_LOADOUT_CONTRACT_VERSION,
  DECISION_CONSOLE_CONTRACT_VERSION,
  SKILL_ASSET_CONTRACT_VERSION,
  agentLoadoutUpdateSchema,
  decisionTraceQuerySchema,
  resourceAccessPolicyUpdateSchema,
  skillGenerationCreateSchema,
  skillManifestSchema
} from "../src/index";

const digest = "a".repeat(64);

describe("decision console v2 contracts", () => {
  it("keeps public contract versions stable", () => {
    expect(DECISION_CONSOLE_CONTRACT_VERSION).toBe("decision-console/v2");
    expect(SKILL_ASSET_CONTRACT_VERSION).toBe("skill-asset/v1");
    expect(AGENT_LOADOUT_CONTRACT_VERSION).toBe("agent-loadout/v1");
  });

  it("requires complete access policy scope inputs", () => {
    expect(() => resourceAccessPolicyUpdateSchema.parse({
      resource_type: "skill_asset",
      resource_id: "skill-1",
      scope: "group"
    })).toThrow();
    expect(resourceAccessPolicyUpdateSchema.parse({
      resource_type: "skill_asset",
      resource_id: "skill-1",
      scope: "group",
      group_ids: ["group-1"]
    })).toMatchObject({ scope: "group", group_ids: ["group-1"] });
  });

  it("rejects traversal and accepts a validated skill manifest", () => {
    expect(() => skillManifestSchema.parse({
      name: "Release notes",
      description: "Prepare verified release notes",
      instructions: "Use only the selected decision and evidence.",
      validation_conditions: ["Citations are present"],
      files: [{ path: "../secret.txt", content: "x", media_type: "text/plain" }]
    })).toThrow();
    expect(skillManifestSchema.parse({
      name: "Release notes",
      description: "Prepare verified release notes",
      instructions: "Use only the selected decision and evidence.",
      validation_conditions: ["Citations are present"]
    }).files).toEqual([]);
  });

  it("limits generation to selected versioned sources", () => {
    expect(skillGenerationCreateSchema.parse({
      name: "Decision rollout",
      sources: [{ source_type: "decision_memory", source_id: "decision-1", version_hash: digest }],
      instructions: "Turn this decision into an operational checklist.",
      provider: "openai",
      model: "gpt-5.4-mini",
      idempotency_key: "generation-1"
    }).sources).toHaveLength(1);
    expect(() => skillGenerationCreateSchema.parse({
      name: "Decision rollout",
      source_decision_id: "decision-hidden",
      sources: [{ source_type: "decision_memory", source_id: "decision-1", version_hash: digest }],
      instructions: "Turn this decision into an operational checklist.",
      provider: "openai",
      model: "gpt-5.4-mini",
      idempotency_key: "generation-2"
    })).toThrow("source_decision_id must be one of the selected versioned Decision sources");
  });

  it("requires pinned bindings to identify the immutable version", () => {
    expect(() => agentLoadoutUpdateSchema.parse({
      bindings: [{
        skill_asset_id: "skill-1",
        usage_mode: "always",
        version_policy: "pinned"
      }]
    })).toThrow();
    expect(decisionTraceQuerySchema.parse({ node_limit: "150", edge_limit: "300" })).toMatchObject({
      include_inferred: false,
      node_limit: 150,
      edge_limit: 300
    });
  });
});
