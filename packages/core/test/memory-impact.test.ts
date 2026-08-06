import { describe, expect, it } from "vitest";
import { summarizeMemoryImpact } from "../src/index";

describe("summarizeMemoryImpact", () => {
  it("calculates reporting, usage, and avoided lookup rates", () => {
    expect(summarizeMemoryImpact([
      { event_type: "eligible", external_run_id: "a" },
      { event_type: "assessed", external_run_id: "a", memory_used: true, avoided_lookup: "source_search" },
      { event_type: "eligible", external_run_id: "b" },
      { event_type: "assessed", external_run_id: "b", memory_used: false, avoided_lookup: "none" },
      { event_type: "eligible", external_run_id: "c" },
      { event_type: "failed", external_run_id: "c" }
    ])).toMatchObject({
      eligible_runs: 3,
      assessed_runs: 2,
      failed_runs: 1,
      memory_used_runs: 1,
      avoided_runs: 1,
      reporting_rate: 1,
      memory_usage_rate: 0.5,
      avoided_lookup_rate: 1
    });
  });
});
