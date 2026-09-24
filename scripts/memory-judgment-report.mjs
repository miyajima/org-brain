#!/usr/bin/env node
// Read-only operational evidence. No API requests or causal benefit claims.
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { judgmentHash } from "../packages/shared/src/memory-judgment-runtime.mjs";

export async function judgmentReport({ file, project, tenant = "default", days = 7, now = Date.now() }) {
  if (!file || !project || !Number.isFinite(now) || !Number.isInteger(days) || days < 1 || days > 365) throw new Error("invalid_report_options");
  const projectHash = await judgmentHash(project), tenantHash = await judgmentHash(tenant);
  const since = now - days * 86400000;
  const periods = { previous: new Map(), current: new Map() };
  let malformed = 0, legacy = 0, duplicateEvents = 0, sourceMissing = false;
  const eventIds = new Set();
  try {
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { malformed++; continue; }
      if (!r || r.telemetry_version !== "memory-judgment-telemetry/v2") { legacy++; continue; }
      if (r.project_hash !== projectHash || r.tenant_hash !== tenantHash) continue;
      if (!Number.isFinite(r.recorded_at) || typeof r.event_id !== "string" || !r.event_id || !Array.isArray(r.decisions)
        || !Number.isFinite(r.elapsed_ms) || r.elapsed_ms < 0 || ![0, 1].includes(r.request_count)
        || !["judged", "fallback", "skipped"].includes(r.status)) { malformed++; continue; }
      if (r.recorded_at < since - days * 86400000 || r.recorded_at >= now) continue;
      if (eventIds.has(r.event_id)) { duplicateEvents++; continue; } eventIds.add(r.event_id);
      const period = r.recorded_at >= since ? "current" : "previous";
      const key = JSON.stringify([r.stage, r.mode, r.capture_assessment_mode, r.policy_hash, r.resolved_model, r.build?.built_at]);
      const group = periods[period].get(key) ?? { stage: r.stage, mode: r.mode, assessment_mode: r.capture_assessment_mode,
        policy_hash: r.policy_hash, model: r.resolved_model, build: r.build ?? null, events: 0, calls: 0, cache_hits: 0, fallbacks: 0,
        known_cost: 0, unknown_cost_calls: 0, api_elapsed: [], decisions: 0, assessments: 0, unknown_labels: 0,
        unknown_utility: 0, existing_label_comparisons: 0, existing_label_disagreements: 0,
        registration: { retain: 0, review: 0, omit: 0 }, snapshots: new Set(), samples: [] };
      group.events++; group.calls += r.request_count; group.cache_hits += r.cache_hit === true ? 1 : 0;
      group.fallbacks += r.status === "fallback" ? 1 : 0;
      if (r.request_count) {
        group.api_elapsed.push(r.elapsed_ms);
        if (typeof r.provider_cost === "number" && Number.isFinite(r.provider_cost) && r.provider_cost >= 0) group.known_cost += r.provider_cost;
        else group.unknown_cost_calls++;
      }
      for (const decision of r.decisions) {
        group.decisions++;
        if (/^[a-f0-9]{64}$/.test(decision?.candidate_snapshot_hash ?? "")) group.snapshots.add(decision.candidate_snapshot_hash);
        const a = decision?.capture_assessment;
        if (!a || a.basis !== "prediction" || a.applied !== false) continue;
        group.assessments++;
        group.unknown_labels += a.classification?.effective_label === "unknown" ? 1 : 0;
        group.unknown_utility += a.utility?.value == null ? 1 : 0;
        if (typeof a.classification?.matches_existing === "boolean") {
          group.existing_label_comparisons++;
          group.existing_label_disagreements += a.classification.matches_existing === false ? 1 : 0;
        }
        if (Object.hasOwn(group.registration, a.registration?.action)) group.registration[a.registration.action]++;
        if (group.samples.length < 10 && (a.classification?.matches_existing === false || a.registration?.action === "omit"))
          group.samples.push({ event_id: r.event_id, candidate_hash: decision.candidate_hash, candidate_snapshot_hash: decision.candidate_snapshot_hash });
      }
      periods[period].set(key, group);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; sourceMissing = true; }
  const summarize = map => [...map.values()].map(({ snapshots, api_elapsed, ...g }) => {
    const sorted = api_elapsed.sort((a,b) => a-b);
    return { ...g, unique_candidate_snapshots: snapshots.size, provider_cost: g.unknown_cost_calls ? null : g.known_cost,
      api_elapsed_mean_ms: sorted.length ? sorted.reduce((a,b)=>a+b,0)/sorted.length : null,
      api_elapsed_p95_ms: sorted.length ? sorted[Math.ceil(sorted.length*.95)-1] : null,
      fallback_rate: g.events ? g.fallbacks/g.events : null,
      registration_review_rate: g.assessments ? g.registration.review/g.assessments : null };
  });
  const current = summarize(periods.current), previous = summarize(periods.previous);
  return { schema: "memory-judgment-periodic-report/v1", project, tenant, from: since, to: now, days,
    status: sourceMissing || !current.length ? "insufficient_evidence" : "observational_only",
    source_missing: sourceMissing, malformed_lines: malformed, legacy_unattributable_lines: legacy, duplicate_events: duplicateEvents,
    current, previous, accuracy: null, task_success_improvement: null, activation_qualified: false,
    limitations: ["shadow predictions are not observed task benefit", "existing labels are not ground truth",
      "counts are decision events; unique snapshots reported separately", "cost excludes unknown charged failures",
      "compare only matching policy/model groups", "human labels and matched task outcomes required for effectiveness"] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {}; const allowed = new Set(["--file", "--project", "--tenant", "--days", "--out"]);
    for (let i=2;i<process.argv.length;i+=2) {
      if (!allowed.has(process.argv[i]) || !process.argv[i+1]) throw new Error("invalid_arguments");
      args[process.argv[i].slice(2)] = process.argv[i+1];
    }
    const report = await judgmentReport({ ...args, days: args.days ? Number(args.days) : 7 });
    const output = JSON.stringify(report, null, 2)+"\n";
    if (args.out) await writeFile(resolve(args.out), output, { flag: "wx", mode: 0o600 });
    console.log(output);
  } catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
}
