import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgmentReport } from "./memory-judgment-report.mjs";
import { judgmentHash } from "../packages/shared/src/memory-judgment-runtime.mjs";

const now = 1800000000000, day = 86400000;
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "jev-report-"));
  try { await fn(join(dir,"log.jsonl")); } finally { await rm(dir,{recursive:true,force:true}); }
}
async function row(extra={}) {
  return { telemetry_version:"memory-judgment-telemetry/v2", event_id:"one", recorded_at:now-day,
    project_hash:await judgmentHash("p"),tenant_hash:await judgmentHash("default"),stage:"capture",mode:"shadow",
    capture_assessment_mode:"shadow",policy_hash:"policy",resolved_model:"model",status:"judged",request_count:1,
    cache_hit:false,provider_cost:.001,elapsed_ms:20,decisions:[{candidate_hash:"a".repeat(64),candidate_snapshot_hash:"b".repeat(64),
      capture_assessment:{basis:"prediction",applied:false,classification:{effective_label:"unknown",matches_existing:false},
        utility:{value:null},registration:{action:"review"}}}],...extra };
}
test("periodic report scopes projects/tenants, deduplicates events and separates cache and API costs",()=>fixture(async file=>{
  const first=await row();
  const rows=[first,first,await row({event_id:"cache",request_count:0,cache_hit:true,provider_cost:0,elapsed_ms:1}),
    await row({event_id:"other",project_hash:await judgmentHash("other")}),await row({event_id:"tenant",tenant_hash:await judgmentHash("other")}),
    await row({event_id:"past",recorded_at:now-8*day}),await row({event_id:"future",recorded_at:now}),{old:true}];
  await writeFile(file,rows.map(JSON.stringify).join("\n")+"\ninvalid\n");
  const r=await judgmentReport({file,project:"p",now});
  assert.equal(r.current[0].events,2);assert.equal(r.current[0].calls,1);assert.equal(r.current[0].cache_hits,1);
  assert.equal(r.current[0].unique_candidate_snapshots,1);assert.equal(r.current[0].provider_cost,.001);
  assert.equal(r.current[0].api_elapsed_mean_ms,20);assert.equal(r.previous[0].events,1);
  assert.equal(r.duplicate_events,1);assert.equal(r.legacy_unattributable_lines,1);assert.equal(r.malformed_lines,1);
  assert.equal(r.accuracy,null);assert.equal(r.task_success_improvement,null);assert.equal(r.activation_qualified,false);
}));
test("periodic report keeps unknown costs unknown and policy/model changes separate",()=>fixture(async file=>{
  await writeFile(file,[await row(),await row({event_id:"fail",status:"fallback",provider_cost:null}),
    await row({event_id:"new",policy_hash:"changed"})].map(JSON.stringify).join("\n"));
  const r=await judgmentReport({file,project:"p",now});
  assert.equal(r.current.length,2);assert.equal(r.current[0].provider_cost,null);assert.equal(r.current[0].unknown_cost_calls,1);
  assert.equal(r.current[0].fallbacks,1);
}));
test("missing logs and legacy-only logs do not imply successful operation",()=>fixture(async file=>{
  assert.equal((await judgmentReport({file,project:"p",now})).source_missing,true);
  await writeFile(file,JSON.stringify({status:"judged"}));
  const r=await judgmentReport({file,project:"p",now});assert.equal(r.status,"insufficient_evidence");assert.equal(r.current.length,0);
  await assert.rejects(judgmentReport({file,project:"p",days:-1,now}),/invalid_report_options/);
}));
