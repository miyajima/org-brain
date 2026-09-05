import crypto from "node:crypto";
import { validateEvaluationBundle } from "./memory-extraction-evaluation-bundle-validate.mjs";

export function stableRouterJson(value) {
  const stable = (item) => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])])) : item;
  return JSON.stringify(stable(value));
}
export const routerHash = (value) => `sha256:${crypto.createHash("sha256").update(stableRouterJson(value)).digest("hex")}`;
export function validateRouterDataset(bundle, labels) {
  if (bundle.contract) validateEvaluationBundle(bundle);
  if (!Array.isArray(bundle.cases) || !bundle.cases.length) throw new Error("router_cases_missing");
  const ids = new Set();
  const sessions = new Map();
  for (const item of bundle.cases) {
    if (!item.id || ids.has(item.id)) throw new Error("router_case_duplicate");
    ids.add(item.id);
    if (!["calibration", "locked"].includes(item.phase) || !item.session_hash) throw new Error("router_phase_or_session_missing");
    if (sessions.has(item.session_hash) && sessions.get(item.session_hash) !== item.phase) throw new Error("router_session_overlap");
    sessions.set(item.session_hash, item.phase);
    if (bundle.contract && item.source_hash !== routerHash(item.turns)) throw new Error("router_source_hash_mismatch");
    const label = labels.get(item.id);
    if (!["durable_memory", "operational_history_only", "not_useful", "excluded"].includes(label)) throw new Error("router_label_missing_or_invalid");
  }
  if (labels.size !== ids.size || [...labels.keys()].some((id) => !ids.has(id))) throw new Error("router_label_set_mismatch");
}

export function validateRouterGoldRows(bundle, rows) {
  if (!Array.isArray(rows)) throw new Error("router_gold_rows_required");
  const byId = new Map(bundle.cases.map((item) => [item.id, item]));
  const labels = new Map();
  for (const row of rows) {
    const item = byId.get(row?.case_id);
    if (!item || labels.has(row.case_id)) throw new Error("router_gold_identity_invalid");
    if (typeof row.source_hash !== "string" || !row.source_hash || row.source_hash !== item.source_hash) throw new Error("router_gold_source_hash_mismatch");
    if (row.phase !== item.phase || row.cohort !== item.cohort) throw new Error("router_gold_phase_or_cohort_mismatch");
    if (!row.gold || !Array.isArray(row.gold.evidence_spans)) throw new Error("router_gold_evidence_invalid");
    const turns = new Map(item.turns.map((turn) => [turn.id, turn.content]));
    for (const span of row.gold.evidence_spans) {
      const text = turns.get(span.turn_id);
      if (typeof text !== "string" || !Number.isInteger(span.start) || !Number.isInteger(span.end)
        || span.start < 0 || span.start >= span.end || span.end > text.length) throw new Error("router_gold_span_bounds_invalid");
    }
    labels.set(row.case_id, row.gold.usefulness);
  }
  validateRouterDataset(bundle, labels);
  return labels;
}
