export const MEMORY_QUALITY_AXES = [
  "decision_utility",
  "evidence_rationale_quality",
  "retrieval_reproducibility",
  "freshness_validity",
  "duplicate_conflict_control",
  "coverage_utility",
  "structure_metadata"
];

export function wilsonLowerBound(successes, total, z = 1.959963984540054) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (center - margin) / denominator);
}

export function certifyMemoryQuality(manifest, options = {}) {
  const threshold = Number(options.threshold ?? 95);
  const axes = {};
  for (const axis of MEMORY_QUALITY_AXES) {
    const metrics = Array.isArray(manifest?.axes?.[axis]) ? manifest.axes[axis] : [];
    const evaluated = metrics.map((metric) => {
      const successes = Number(metric?.successes);
      const total = Number(metric?.total);
      const point = Number.isInteger(successes) && Number.isInteger(total) && total > 0
        ? (100 * successes) / total
        : null;
      const lower = wilsonLowerBound(successes, total);
      return {
        name: String(metric?.name ?? "unnamed"),
        successes,
        total,
        point_estimate: point,
        wilson_95_lower: lower === null ? null : lower * 100,
        passed: point !== null && lower !== null && point >= threshold && lower * 100 >= threshold
      };
    });
    const sufficient = evaluated.length > 0 && evaluated.every((metric) => metric.point_estimate !== null && metric.wilson_95_lower !== null);
    const score = sufficient
      ? Math.min(...evaluated.flatMap((metric) => [metric.point_estimate, metric.wilson_95_lower]))
      : null;
    axes[axis] = {
      status: sufficient ? (evaluated.every((metric) => metric.passed) ? "certified" : "not_certified") : "insufficient_evidence",
      score: score === null ? null : Math.round(score * 100) / 100,
      threshold,
      metrics: evaluated
    };
  }
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    aggregate_score: null,
    axes
  };
}

