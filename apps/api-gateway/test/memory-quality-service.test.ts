import { describe, expect, it } from "vitest";
import { getMemoryQualityRun, listMemoryQualityRuns } from "../src/memory-quality-service";

class Statement {
  args: unknown[] = [];
  constructor(private db: FakeDb, private sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() { return (this.sql.includes("memory_quality_runs") ? this.db.run : null) as T | null; }
  async all<T>() {
    if (this.sql.includes("memory_quality_measurements")) return { results: this.db.measurements as T[] };
    if (this.sql.includes("memory_quality_cases")) return { results: this.db.cases as T[] };
    if (this.sql.includes("FROM memories")) return { results: this.db.memories as T[] };
    if (this.sql.includes("memory_quality_runs")) return { results: [this.db.run] as T[] };
    return { results: [] as T[] };
  }
}

class FakeDb {
  run = { id: "run-1", tenant_id: "tenant-a", project_id: null, corpus_id: "v3", prompt_contract_id: "p1", verifier_version: "v1", judge_profile_id: null, manifest_hash: "hash", status: "passed", input_source: "synthetic", ground_truth_basis: "locked_oracle", capture_routes_json: '["realtime_hook","initial_import"]', privacy_json: '{"raw_transcript":false}', hard_violation_count: 0, started_at: 1, completed_at: 2 };
  measurements = [{ id: "m1", run_id: "run-1", axis: "atomicity", cohort: "all", numerator: 100, denominator: 100, point_estimate: 1, wilson_lower: 0.96, wilson_upper: 1, hard_violation_count: 0, created_at: 2 }];
  cases = [{ id: "c1", run_id: "run-1", case_hash: "case", session_hash: "session", project_hash: "project", split: "locked_test", lesson_type: "decision", capture_route: "realtime_hook", expected_route: "active", actual_route: "active", candidate_hash: "candidate", memory_id: "mem-1", candidate_id: null, reason_codes_json: "[]", hard_violation_count: 0, parity_mismatch: 0, created_at: 2 }];
  memories = [{ id: "mem-1", summary: "Reusable decision summary" }];
  prepare(sql: string) { return new Statement(this, sql); }
}

describe("memory quality service", () => {
  it("returns dimensions without an averaged score and redacts excluded summaries", async () => {
    const env = { OPEN_BRAIN_DB: new FakeDb() } as any;
    const listed = await listMemoryQualityRuns(env, "tenant-a");
    expect(listed.items[0]).toMatchObject({ capture_routes: ["realtime_hook", "initial_import"] });
    expect(listed.items[0]).not.toHaveProperty("average");
    const detail = await getMemoryQualityRun(env, "tenant-a", "run-1", { parityMismatch: false });
    expect(detail.dimensions[0]).toMatchObject({ axis: "atomicity", wilson_lower: 0.96 });
    expect(detail.cases[0]).toMatchObject({ summary: "Reusable decision summary", parity_mismatch: false });
    (env.OPEN_BRAIN_DB as FakeDb).cases[0].actual_route = "excluded";
    const excluded = await getMemoryQualityRun(env, "tenant-a", "run-1");
    expect(excluded.cases[0]).toEqual(expect.objectContaining({ case_hash: "case", reason_codes: [] }));
    expect(excluded.cases[0]).not.toHaveProperty("memory_id");
  });
});
