import type { AvoidedLookup, MemoryImpactSummary } from "@org-brain/contracts";

export type MemoryImpactObservation = {
  event_type: "eligible" | "assessed" | "failed";
  external_run_id: string;
  memory_used?: boolean | null;
  avoided_lookup?: AvoidedLookup | null;
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;

export function summarizeMemoryImpact(events: MemoryImpactObservation[]): MemoryImpactSummary {
  const runs = new Map<string, { eligible: boolean; assessed: boolean; failed: boolean; memoryUsed: boolean; avoided: AvoidedLookup }>();
  for (const event of events) {
    const run = runs.get(event.external_run_id) ?? {
      eligible: false,
      assessed: false,
      failed: false,
      memoryUsed: false,
      avoided: "none" as const
    };
    if (event.event_type === "eligible") run.eligible = true;
    if (event.event_type === "failed") run.failed = true;
    if (event.event_type === "assessed") {
      run.assessed = true;
      run.memoryUsed = event.memory_used === true;
      run.avoided = event.avoided_lookup ?? "none";
    }
    runs.set(event.external_run_id, run);
  }

  const values = [...runs.values()];
  const eligibleRuns = values.filter((run) => run.eligible).length;
  const assessedRuns = values.filter((run) => run.assessed).length;
  const failedRuns = values.filter((run) => run.failed).length;
  const memoryUsedRuns = values.filter((run) => run.assessed && run.memoryUsed).length;
  const avoidedRuns = values.filter((run) => run.assessed && run.memoryUsed && run.avoided !== "none").length;
  const byAvoidedLookup: Record<AvoidedLookup, number> = {
    source_search: 0,
    web_search: 0,
    past_context: 0,
    none: 0
  };
  for (const run of values.filter((item) => item.assessed)) byAvoidedLookup[run.avoided] += 1;

  return {
    eligible_runs: eligibleRuns,
    assessed_runs: assessedRuns,
    failed_runs: failedRuns,
    memory_used_runs: memoryUsedRuns,
    avoided_runs: avoidedRuns,
    reporting_rate: ratio(assessedRuns + failedRuns, eligibleRuns),
    memory_usage_rate: ratio(memoryUsedRuns, assessedRuns),
    avoided_lookup_rate: ratio(avoidedRuns, memoryUsedRuns),
    by_avoided_lookup: byAvoidedLookup
  };
}
