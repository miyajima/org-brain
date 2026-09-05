// Generated from the 75-case calibration split by
// scripts/memory-extraction-router-calibrate.mjs. Locked cases are never used
// to fit weights or select thresholds.
export const MEMORY_EXTRACTION_ROUTER_MODEL_V2 = Object.freeze({
  schema: "memory-extraction-router-model/v2",
  model_type: "weighted_logistic_regression",
  training_set: "local-real-evaluation-2026-09-03:calibration",
  feature_names: [
    "user_adoption",
    "durable_decision",
    "preference",
    "constraint",
    "failure_correction",
    "durable_scope",
    "reusable_or_causal",
    "verified",
    "operational_status",
    "event_completed",
    "proposal_only",
    "review_only",
    "explicitly_transient",
    "assistant_only",
    "span_density"
  ],
  durable_candidate: {
    intercept: -0.002608905780183859,
    weights: [-0.20722261947396162, -0.09951018567913426, -0.052587729807099665, -0.18837695719363112, -0.006829994342527958, 0.5821337914069249, -0.14962310213807672, 0.16910149723330517, -0.11749422092782504, 0, -0.05831099481903008, 0.0654987024507014, -0.052587729807099665, -0.2774566630677458, -0.19780661453034876],
    threshold: 0.49370555506558084
  },
  operational_history: {
    intercept: -0.6691884497906204,
    weights: [0.037833768163313033, 0.07639479866072885, 0.05906575605510262, 0.22493462680354986, 0.06801854703458189, -0.24799169179657019, 0.39180606712091653, 0.15715992678201024, 0.26314699621919707, 0, 0.07711840216185095, -0.01057471808002081, 0.05906575605510262, 0.4167360178629668, 0.18212101175317008],
    threshold: 0.41635708627980944
  },
  calibration_metrics: {
    cases: 75,
    durable_candidate: { precision: 0.5517241379310345, recall: 0.7272727272727273, f1: 0.6274509803921569, positive_rate: 0.38666666666666666 },
    operational_history: { precision: 0.6119402985074627, recall: 1, f1: 0.7592592592592593, positive_rate: 0.8933333333333333 }
  }
});
