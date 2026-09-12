// Scenario arithmetic, not fitted measurements or model usage.
import { writeFile } from 'node:fs/promises';

const scenarios = [
  {
    id: 'applicable-history', weight: 0.5,
    time: { investigation_share: 0.35, avoidable_fraction: 0.55, added_overhead_share: 0.05 },
    tokens: { investigation_share: 0.45, avoidable_fraction: 0.6, added_overhead_share: 0.05 },
    bounds: { time: [[0.25, 0.45], [0.4, 0.7], [0.03, 0.08]], tokens: [[0.3, 0.6], [0.4, 0.7], [0.03, 0.1]] }
  },
  {
    id: 'changed-conditions', weight: 0.3,
    time: { investigation_share: 0.22, avoidable_fraction: 0.2, added_overhead_share: 0.06 },
    tokens: { investigation_share: 0.3, avoidable_fraction: 0.25, added_overhead_share: 0.06 },
    bounds: { time: [[0.15, 0.3], [0.1, 0.3], [0.04, 0.09]], tokens: [[0.2, 0.4], [0.1, 0.35], [0.04, 0.1]] }
  },
  {
    id: 'no-useful-history', weight: 0.2,
    time: { investigation_share: 0, avoidable_fraction: 0, added_overhead_share: 0.025 },
    tokens: { investigation_share: 0, avoidable_fraction: 0, added_overhead_share: 0.04 },
    bounds: { time: [[0, 0.05], [0, 0.2], [0.01, 0.05]], tokens: [[0, 0.05], [0, 0.2], [0.01, 0.08]] }
  }
];
const percent = (n) => Math.round(n * 10000) / 100;
const improvement = (x) => x.investigation_share * x.avoidable_fraction - x.added_overhead_share;
const interval = ([f, e, h]) => [f[0] * e[0] - h[1], f[1] * e[1] - h[0]];
const result = {
  status: 'assumption-only sensitivity analysis; no paired agent trial',
  formula: 'improvement = baseline investigation share * avoided fraction - all added overhead share',
  scope: 'Incremental benefit over existing memory, skills, RTK and normal prompt caching. Assumes bounded output and rejection of irrelevant evidence; current raw retrieval does not satisfy this assumption.',
  overhead_includes: ['retrieval', 'additional agent turn', 'source verification', 'rework', 'prefix cache losses', 'amortized preparation and capture cost'],
  baseline_distribution: 'Weights are assumed workload cost shares, not measured task frequencies; equal-duration/equal-token tasks make them task frequencies too.',
  scenarios: scenarios.map((s) => ({ ...s, time_improvement_pct: percent(improvement(s.time)), total_token_improvement_pct: percent(improvement(s.tokens)), time_sensitivity_pct: interval(s.bounds.time).map(percent), total_token_sensitivity_pct: interval(s.bounds.tokens).map(percent) })),
  portfolio: Object.fromEntries(['time', 'tokens'].map((metric) => [metric, {
    improvement_pct: percent(scenarios.reduce((sum, s) => sum + s.weight * improvement(s[metric]), 0)),
    sensitivity_pct: [0, 1].map((i) => percent(scenarios.reduce((sum, s) => sum + s.weight * interval(s.bounds[metric])[i], 0)))
  }])),
  independent_pair_sample_size_example: {
    assumptions: { target_effect: 0.15, paired_difference_sd: 0.25, two_sided_alpha_approx: 0.05, power_approx: 0.8 },
    normal_approx_pairs_per_client: Math.ceil(((1.96 + 0.84) * 0.25 / 0.15) ** 2),
    warning: 'Planning example only. Small samples, task clusters, skew and quality failures need different analysis; re-estimate from pilot variance.'
  }
};
await writeFile(process.argv[2], `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
