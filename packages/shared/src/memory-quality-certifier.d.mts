export const MEMORY_QUALITY_AXES: string[];
export function wilsonLowerBound(successes: number, total: number, z?: number): number | null;
export function certifyMemoryQuality(manifest: unknown, options?: { threshold?: number }): {
  schema_version: number;
  generated_at: string;
  aggregate_score: null;
  axes: Record<string, {
    status: "certified" | "not_certified" | "insufficient_evidence";
    score: number | null;
    threshold: number;
    metrics: Array<{
      name: string;
      successes: number;
      total: number;
      point_estimate: number | null;
      wilson_95_lower: number | null;
      passed: boolean;
    }>;
  }>;
};

