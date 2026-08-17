import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMemoryMapTrace } from "../src/memory-map-trace-service";
import type { Env } from "../src/types";

const getMemoryDetailsMock = vi.hoisted(() => vi.fn());
const getDecisionResourceTraceMock = vi.hoisted(() => vi.fn());
const stableResultReadableMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("../src/memory-service", () => ({
  getMemoryDetails: getMemoryDetailsMock,
  stableResultReadable: stableResultReadableMock
}));

vi.mock("../src/resource-decision-service", () => ({
  getDecisionResourceTrace: getDecisionResourceTraceMock
}));

function database(options: {
  memory?: Record<string, unknown> | null;
  rationale?: Record<string, unknown> | null;
}) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM memories")) return (options.memory ?? null) as T;
              if (sql.includes("FROM decision_rationales")) return (options.rationale ?? null) as T;
              return null as T;
            },
            async all<T>() { return { results: [] as T[] }; }
          };
        }
      };
    }
  } as unknown as D1Database;
}

const memory = {
  id: "memory-1",
  project_id: "org-brain",
  owner_principal: "agent:trusted",
  permissions_json: "[]",
  deleted_at: null,
  lifecycle_state: "active"
};

const details = {
  tenant_id: "tenant-a",
  memory_id: "memory-1",
  memory: {
    id: "memory-1",
    source: "codex-v4-semantic-regression",
    external_key: "orgbrain-ingestion-v4:decision-001",
    created_at: 1_000,
    kind: "decision",
    current_version: 1,
    last_accessed_at: null,
    confidence_score: 0.9,
    utility_score: 0.8,
    actor_type: "system",
    actor_id: "local-v4-seed",
    owner_principal: "agent:trusted",
    created_by_principal: "agent:trusted",
    deleted_at: null,
    deleted_by_principal: null,
    delete_reason: null,
    project_id: "org-brain",
    content: "decision content",
    summary: "Use the canonical endpoint",
    tags: [],
    lifecycle_state: "active",
    updated_at: 1_000,
    reference_count: 0,
    used_count: 0,
    consumer_count: 0,
    net_saved_tokens: 0,
    injected_tokens: 0,
    reuse_rule: "Use the canonical endpoint for new connectors.",
    capture_origin: "observed",
    capture_route: "initial_import",
    capture_batch_id: "batch-1",
    verification_state: "verified",
    verified_at: 1_001,
    learning: {
      lesson_type: "decision",
      decision_key: "canonical_api_url",
      decision: "Use ORGBRAIN_API_URL.",
      rationale: "A single endpoint prevents configuration drift.",
      alternatives: [{ alternative: "Keep two endpoints", reason_rejected: "It creates drift." }],
      reuse_when: "When adding a connector.",
      evidence_selectors: [{ type: "file", ref: "private-transcript.json" }],
      applicability: { target_files: ["private-transcript.json"] },
      raw_transcript: "do not return this capture payload"
    },
    quality_dimensions: null
  },
  versions: [],
  rationales: [{
    id: "rationale-1",
    decision_type: "governance",
    conclusion: "Use ORGBRAIN_API_URL.",
    reason_summary: "A single endpoint prevents configuration drift.",
    status: "adopted",
    confirmation_state: "confirmed",
    confidence_score: 0.9,
    created_at: 1_000,
    confirmed_at: 1_001,
    evidence: [{
      id: "evidence-1",
      evidence_type: "file",
      evidence_ref: "src/semantic-regression.mjs",
      relation: "supports:decision,rationale",
      note: null,
      weight_score: 1,
      content_hash: "hash",
      observed_at: 1_000,
      attestation_ref: "attestation-1"
    }]
  }]
};

const resources = {
  sources: [{
    link: { role: "rationale_source", resource_version_id: "version-source", locator: { line_start: 1 }, note: null, confirmation_state: "confirmed", excerpt_digest: "digest" },
    resource: { id: "resource-source", title: "Decision record", resource_kind: "document", canonical_uri: "orgbrain://local/source", source_system: "fixture", lifecycle_state: "active", current_version_id: "version-source" },
    version: { id: "version-source", source_version: null, content_hash: "hash", captured_at: 1_000, extraction_state: "ready", pinned: true },
    freshness: "active",
    availability: "readable" as const
  }],
  artifacts: [{
    link: { role: "verification_artifact", resource_version_id: "version-test", locator: null, note: "passed", confirmation_state: "confirmed", excerpt_digest: null },
    resource: { id: "resource-test", title: "Verification result", resource_kind: "test_result", canonical_uri: "orgbrain://local/test", source_system: "fixture", lifecycle_state: "active", current_version_id: "version-test" },
    version: { id: "version-test", source_version: null, content_hash: "hash", captured_at: 1_000, extraction_state: "ready", pinned: true },
    freshness: "active",
    availability: "readable" as const
  }],
  truncated: false
};

describe("memory map trace service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stableResultReadableMock.mockReturnValue(true);
    getMemoryDetailsMock.mockResolvedValue(details);
    getDecisionResourceTraceMock.mockResolvedValue(resources);
  });

  it("returns decision, reason, evidence, and confirmed artifacts for a memory", async () => {
    const result = await getMemoryMapTrace({ OPEN_BRAIN_DB: database({ memory }) } as unknown as Env, {
      tenantId: "tenant-a",
      principal: "agent:trusted",
      projectId: "org-brain",
      scope: "org",
      memoryId: "memory-1"
    });

    expect(result.contract_version).toBe("memory-map-trace/v1");
    expect(result.selected.node_type).toBe("memory");
    expect(result.rationales[0].derived.decision_key).toBe("canonical_api_url");
    expect(result.rationales[0].resources.artifacts[0].resource.title).toBe("Verification result");
    expect(result.memory.learning).not.toHaveProperty("evidence_selectors");
    expect(result.memory.learning).not.toHaveProperty("applicability");
    expect(result.memory.learning).not.toHaveProperty("raw_transcript");
    expect(result.completeness).toMatchObject({ rationale_count: 1, evidence_count: 1, artifact_count: 1, partial: false });
    expect(getMemoryDetailsMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", "memory-1", expect.objectContaining({ recordUsage: false }));
  });

  it("focuses a selected rationale and resolves its parent memory", async () => {
    const result = await getMemoryMapTrace({ OPEN_BRAIN_DB: database({ memory, rationale: { id: "rationale-1", memory_id: "memory-1", project_id: "org-brain" } }) } as unknown as Env, {
      tenantId: "tenant-a",
      principal: "agent:trusted",
      projectId: "org-brain",
      scope: "org",
      decisionRationaleId: "rationale-1"
    });

    expect(result.selected).toEqual({
      node_type: "decision",
      id: "rationale-1",
      memory_id: "memory-1",
      decision_rationale_id: "rationale-1"
    });
    expect(result.selected_rationale_id).toBe("rationale-1");
  });

  it("does not disclose a memory when permissions reject the principal", async () => {
    stableResultReadableMock.mockReturnValue(false);
    await expect(getMemoryMapTrace({ OPEN_BRAIN_DB: database({ memory }) } as unknown as Env, {
      tenantId: "tenant-a",
      principal: "agent:other",
      scope: "org",
      memoryId: "memory-1"
    })).rejects.toMatchObject({ status: 404, code: "memory_not_found" });
    expect(getMemoryDetailsMock).not.toHaveBeenCalled();
  });

  it("requires exactly one selector", async () => {
    await expect(getMemoryMapTrace({ OPEN_BRAIN_DB: database({ memory }) } as unknown as Env, {
      tenantId: "tenant-a",
      principal: "agent:trusted",
      scope: "org"
    })).rejects.toMatchObject({ status: 400, code: "invalid_query" });
  });
});
