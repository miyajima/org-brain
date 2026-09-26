export type EpisodicAgingCandidate = {
  id: string;
  version: number;
  stage: "cold_candidate" | "compaction_candidate";
  inactive_days: number;
  last_verified_use_at: number | null;
};

export function planEpisodicAging(
  rows: Array<Record<string, unknown>>,
  options?: { now?: number; coldDays?: number; compactDays?: number }
): {
  mode: "shadow";
  cold_after_days: number;
  compaction_after_days: number;
  scanned: number;
  candidates: EpisodicAgingCandidate[];
  mutations: 0;
};
