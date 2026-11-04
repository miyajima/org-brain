import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { recallWiki } from "../packages/orgbrain-cli/src/lib/wiki-recall.mjs";

function fixture(reports, extra = []) {
  const calls = [];
  const manifests = reports.map((r, i) => ({ schema:"wiki-report-preservation/v1",
    origin:{ recorded_at:r.time, session_id:"session", turn_id:String(i) },
    original:{source_id:r.id,version:1,hash:createHash("sha256").update(r.text).digest("hex")},
    items:[{text:r.text}],
  }));
  const wiki = { async request(input) {
    calls.push(input);
    if(input.op === "search") return {hits:input.scope === "sources" ? [
      ...reports.map((r,i)=>({kind:"source",owner_id:`inventory-${i}`,version:1,chunk_id:i,heading:"",snippet:JSON.stringify(manifests[i])})),
      ...extra.map((r,i)=>({kind:"source",owner_id:r.id,version:1,chunk_id:100+i,heading:"",snippet:r.text,recorded_at:r.time})),
    ] : [], truncated:false};
    const index = /^inventory-(\d+)$/.exec(input.source_id)?.[1];
    if(index !== undefined) return {name:"report-inventory.json",text:JSON.stringify(manifests[Number(index)]),truncated:false};
    const r = [...reports,...extra].find(x=>x.id===input.source_id);
    return {name:"report.md",source_id:r.id,version:1,text:r.text,start_line:1,end_line:r.text.split("\n").length,
      hash:createHash("sha256").update(r.text).digest("hex"),truncated:false};
  }};
  return {wiki,calls};
}

const target = {event_since:"2026-10-20T10:00:00+09:00",event_until:"2026-10-20T10:01:00+09:00"};

test("event targets use reported time, honor offsets and exclude ingestion-only dates",async()=>{
  const {wiki,calls}=fixture([
    {id:"wanted",time:"2026-10-20T01:00:00Z",text:"alpha beta 12件成功。配備は未確認。"},
    {id:"before",time:"2026-10-20T00:59:59Z",text:"alpha beta wrong earlier"},
    {id:"after",time:"2026-10-20T01:01:00Z",text:"alpha beta wrong later"},
  ],[{id:"ingested",time:"2026-10-20T01:00:20Z",text:"alpha beta ingestion-only"}]);
  const result=await recallWiki(wiki,{query:"alpha beta",targets:[target]});
  assert.deepEqual(result.evidence.map(x=>x.source_id),["wanted"]);
  assert.equal(result.evidence[0].timestamp,"2026-10-20T01:00:00Z");
  assert.deepEqual(result.evidence[0].target_indices,[0]);
  assert.ok(!calls.some(c=>c.op==="source_read"&&["before","after"].includes(c.source_id)));
  assert.deepEqual(result.unmatched_targets,[]);
});

test("a missing explicit target never widens to an unrelated report, including broad mode",async()=>{
  const {wiki}=fixture([{id:"old",time:"2026-10-01T01:00:00Z",text:"alpha beta 99件成功。"}]);
  const result=await recallWiki(wiki,{query:"alpha beta",targets:[target],context_mode:"broad"});
  assert.deepEqual(result.evidence,[]);
  assert.deepEqual(result.unmatched_targets,[0]);
  assert.equal(result.answer_completeness_verified,false);
});

test("precise event discovery is not crowded out by many reports from the same day",async()=>{
  const reports=Array.from({length:80},(_,i)=>({id:`background-${i}`,time:"2026-10-20T05:00:10Z",text:"alpha beta 別の時間の報告。[原本](artifacts/run-a/REPORT.md)"}));
  reports.push({id:"wanted",time:"2026-10-20T01:00:10Z",text:"alpha beta 12件、配備は未確認。[原本](artifacts/run-a/REPORT.md)"});
  const {wiki}=fixture(reports);
  const request=wiki.request;
  wiki.request=async input=>{
    const value=await request(input);
    if(input.op==="search"&&input.query.includes("T")) value.hits=value.hits.filter(h=>h.snippet.includes(input.query));
    return value;
  };
  const result=await recallWiki(wiki,{query:"alpha beta",targets:[target]});
  assert.deepEqual(result.evidence.map(e=>e.source_id),["wanted"]);
  assert.deepEqual(result.unmatched_targets,[]);
  const byExperiment=await recallWiki(wiki,{query:"alpha beta",targets:[{...target,experiment_id:"run-a"}]});
  assert.deepEqual(byExperiment.evidence.map(e=>e.source_id),["wanted"]);
});

test("each requested event keeps its own evidence rather than borrowing a later state",async()=>{
  const {wiki}=fixture([
    {id:"earlier",time:"2026-10-20T01:00:10Z",text:"alpha beta 12件、配備は未確認。"},
    {id:"later",time:"2026-10-21T01:00:10Z",text:"alpha beta 13件、配備済み。"},
  ]);
  const second={event_since:"2026-10-21T01:00:00Z",event_until:"2026-10-21T01:01:00Z"};
  const result=await recallWiki(wiki,{query:"alpha beta",targets:[target,second]});
  assert.equal(result.evidence.length,2);
  assert.deepEqual(result.evidence.map(e=>e.target_indices[0]).sort(),[0,1]);
  assert.deepEqual(result.unmatched_targets,[]);
});

test("a complete match for one event cannot suppress a partial match for another",async()=>{
  const {wiki}=fixture([
    {id:"earlier",time:"2026-10-20T01:00:10Z",text:"alpha beta 12件、配備は未確認。"},
    {id:"later",time:"2026-10-21T01:00:10Z",text:"alpha 13件、配備済み。"},
  ]);
  const result=await recallWiki(wiki,{query:"alpha beta",targets:[target,{event_since:"2026-10-21T01:00:00Z",event_until:"2026-10-21T01:01:00Z"}]});
  assert.deepEqual(result.evidence.map(e=>e.source_id).sort(),["earlier","later"]);
  assert.deepEqual(result.target_coverage[1].missing_query_terms,["beta"]);
});

test("experiment identifiers match artifact path segments, not another experiment or bare words",async()=>{
  const {wiki}=fixture([
    {id:"wanted",time:"2026-10-20T01:00:10Z",text:"alpha beta 12件。[原本](artifacts/run-a/REPORT.md)"},
    {id:"different",time:"2026-10-20T01:00:10Z",text:"alpha beta 13件。[原本](artifacts/run-ab/REPORT.md)"},
    {id:"bare",time:"2026-10-20T01:00:10Z",text:"alpha beta run-a についての説明だけ。"},
  ]);
  const result=await recallWiki(wiki,{query:"alpha beta",targets:[{...target,experiment_id:"run-a"}]});
  assert.deepEqual(result.evidence.map(e=>e.source_id),["wanted"]);
  const byId=await recallWiki(wiki,{query:"alpha beta",targets:[{experiment_id:"run-a"}]});
  assert.deepEqual(byId.evidence.map(e=>e.source_id),["wanted"]);
});

test("invalid targets are rejected before searching",async()=>{
  const {wiki,calls}=fixture([]);
  for(const targets of [[{}],[{event_since:target.event_since}],[{...target,event_until:target.event_since}],
    [{...target,event_since:"2026-02-30T01:00:00Z"}],[{...target,event_since:"2026-10-20T01:00:00"}],
    [{...target,event_until:"2027-01-01T00:00:00Z"}],Array(9).fill(target),[{experiment_id:"../run"}]]) {
    await assert.rejects(recallWiki(wiki,{query:"alpha",targets}),/invalid_recall_target/);
  }
  assert.equal(calls.length,0);
});

test("passages retain matching table headers, values and adjacent qualifications with original lines",async()=>{
  const prefix=Array(60).fill("背景の長い説明です。必要な結果は後にあります。").join("\n\n");
  const section="## 結果\n\n| 条件 | 件数 |\n|---|---:|\n| alpha beta | 12 |\n\nただし配備は未確認。理由は権限不足。\n同じ版の場合に限る。";
  const suffix=Array(60).fill("無関係な背景の続きです。ここは今回の根拠ではありません。").join("\n\n");
  const text=prefix+"\n\n"+section+"\n\n"+suffix;
  const {wiki}=fixture([{id:"long",time:"2026-10-20T01:00:10Z",text}]);
  const result=await recallWiki(wiki,{query:"alpha beta",targets:[target],passage_chars:800,context_lines:2});
  const e=result.evidence[0];
  assert.ok(e.text.includes("| 条件 | 件数 |"));
  assert.ok(e.text.includes("| alpha beta | 12 |"));
  assert.ok(e.text.includes("ただし配備は未確認"));
  assert.ok(e.text.includes("同じ版の場合に限る"));
  assert.ok(!e.text.includes("無関係な背景"));
  assert.ok([...e.text].length<=800);
  assert.ok(e.excerpt_ranges.every(r=>r.start_line>60&&r.end_line>=r.start_line));
  assert.equal(e.hash,createHash("sha256").update(text).digest("hex"));
  assert.equal(e.version,1);
});

test("full excerpts remain an explicit option and invalid excerpt settings fail",async()=>{
  const text="alpha beta\n"+"背景。\n".repeat(100);
  const {wiki}=fixture([{id:"report",time:"2026-10-20T01:00:10Z",text}]);
  const result=await recallWiki(wiki,{query:"alpha beta",targets:[target],excerpt_mode:"full"});
  assert.equal(result.evidence[0].text,text);
  await assert.rejects(recallWiki(wiki,{query:"alpha",excerpt_mode:"bad"}),/invalid_excerpt_mode/);
  await assert.rejects(recallWiki(wiki,{query:"alpha",passage_chars:10}),/invalid_passage_chars/);
});
