import { describe, expect, it } from "vitest";
import { memoryImpactAssessmentSchema, memoryImpactStartSchema } from "../src/index";

describe("memory impact v1 contract", () => {
  it("accepts eligible start input", () => {
    expect(memoryImpactStartSchema.parse({ external_run_id: "run-1", idempotency_key: "start-1" })).toEqual({
      contract_version: "memory-impact/v1",
      external_run_id: "run-1",
      idempotency_key: "start-1"
    });
  });

  it("requires basis and confidence when memory was used", () => {
    expect(() => memoryImpactAssessmentSchema.parse({
      idempotency_key: "report-1",
      memory_used: true,
      avoided_lookup: "source_search",
      memory_basis_ids: []
    })).toThrow();
  });

  it("requires none and no basis when memory was not used", () => {
    expect(memoryImpactAssessmentSchema.parse({
      idempotency_key: "report-2",
      memory_used: false,
      avoided_lookup: "none",
      memory_basis_ids: [],
      confidence: null
    })).toMatchObject({ memory_used: false, avoided_lookup: "none" });
  });
});
