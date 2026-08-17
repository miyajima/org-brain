import { describe, expect, it } from "vitest";
import { MEMORY_QUALITY_AXES, certifyMemoryQuality, evaluateMemoryIngestionAutonomousQualification } from "../src/memory-quality-certifier";

describe("memory quality certifier", () => {
  it("reports every axis independently and never emits an aggregate score", () => {
    const axes = Object.fromEntries(MEMORY_QUALITY_AXES.map((axis) => [axis, [
      { name: `${axis}-metric`, successes: 999, total: 1_000 }
    ]]));
    const result = certifyMemoryQuality({ axes });
    expect(result.aggregate_score).toBeNull();
    expect(Object.keys(result.axes)).toEqual(MEMORY_QUALITY_AXES);
    expect(Object.values(result.axes).every((axis) => axis.status === "certified")).toBe(true);
  });

  it("does not certify a high point estimate when its Wilson lower bound is below 95", () => {
    const axes = Object.fromEntries(MEMORY_QUALITY_AXES.map((axis) => [axis, [
      { name: `${axis}-small-sample`, successes: 19, total: 20 }
    ]]));
    const result = certifyMemoryQuality({ axes });
    expect(result.axes.decision_utility.status).toBe("not_certified");
    expect(result.axes.decision_utility.metrics[0].point_estimate).toBe(95);
    expect(result.axes.decision_utility.metrics[0].wilson_95_lower).toBeLessThan(95);
  });

  it("uses insufficient_evidence when an axis has no samples", () => {
    const result = certifyMemoryQuality({ axes: {} });
    expect(Object.values(result.axes).every((axis) => axis.status === "insufficient_evidence")).toBe(true);
  });

  it("keeps the autonomous input report separate from its certification result", () => {
    const result = evaluateMemoryIngestionAutonomousQualification({
      schema_version: 1,
      dataset_id: "machine-reference-v1",
      dataset_sha256: `sha256:${"a".repeat(64)}`,
      selected_case_count: 0,
      route_counts: {},
      metamorphic: { pair_count: 0 },
      passed: false,
      status: "insufficient_evidence"
    });

    expect(result.input_report).toMatchObject({ dataset_id: "machine-reference-v1", passed: false });
    expect(result.certification_result).toMatchObject({ certification: "not_qualified", pass: false });
    expect(result.dataset_id).toBe("machine-reference-v1");
    expect(result.certification).toBe("not_qualified");
  });
});
