import test from "node:test";
import assert from "node:assert/strict";
import { recallWiki } from "../packages/orgbrain-cli/src/lib/wiki-recall.mjs";

const report = "# alpha beta復旧\n12件成功。\nただし配備は未確認。\n理由は権限不足。\n同じ版の場合に限る。\n";
function fixture({origin2=false}={}) {
  const origin={session_id:"s",turn_id:"t",recorded_at:"2026-10-20T01:00:00Z"};
  const manifest={schema:"wiki-report-preservation/v1",origin,original:{source_id:"original",version:2,hash:"a".repeat(64)},items:[{start_line:1,end_line:5,text:report,categories:["number","state","condition"]}]};
  const wiki={async request(input){
    if(input.op==="search") {
      if(input.scope==="wiki")return {hits:[{kind:"page",owner_id:"page",chunk_id:1,heading:"Copied",snippet:report,start_line:1,end_line:5}]};
      return {hits:[
        {kind:"source",owner_id:"inventory",version:1,chunk_id:2,heading:"",snippet:JSON.stringify(manifest)},
        {kind:"source",owner_id:"original",version:2,chunk_id:3,heading:"",snippet:report},
        {kind:"source",owner_id:"partial",version:1,chunk_id:4,heading:"",snippet:"alphaだけの無関係な背景。"},
        ...(origin2?[{kind:"source",owner_id:"inventory2",version:1,chunk_id:5,heading:"",snippet:JSON.stringify(manifest)}]:[]),
      ]};
    }
    if(input.source_id==="inventory"||input.source_id==="inventory2") return {name:"report-inventory.json",text:JSON.stringify({...manifest,...(input.source_id==="inventory2"?{origin:{...origin,turn_id:"later",recorded_at:"2026-10-21T01:00:00Z"}}:{})}),truncated:false,hash:"b".repeat(64)};
    return {name:"report.md",source_id:input.source_id,version:input.version,hash:"a".repeat(64),text:input.source_id==="original"?report:"alphaだけの無関係な背景。",start_line:1,end_line:5,truncated:false};
  }};
  return wiki;
}

test("focused recall sends report text once, retaining qualifiers and exact original provenance",async()=>{
  const result=await recallWiki(fixture(),{query:"alpha beta"});
  assert.equal(result.evidence.length,1);
  const e=result.evidence[0];
  assert.equal(e.source_id,"original");assert.equal(e.version,2);
  assert.equal(e.text,report);
  assert.equal(e.timestamp,"2026-10-20T01:00:00Z");
  assert.ok(e.id.includes("source:original@2"));
  assert.equal(e.inventory_source_id,"inventory");
  assert.equal(result.text_characters,[...report].length);
  assert.ok(!e.text.includes('"categories"'));
});

test("broad recall remains available for background and incomplete query matches",async()=>{
  const result=await recallWiki(fixture(),{query:"alpha beta",context_mode:"broad"});
  assert.ok(result.evidence.some(e=>e.source_id==="partial"));
  await assert.rejects(recallWiki(fixture(),{query:"alpha",context_mode:"unknown"}),/invalid_context_mode/);
});

test("same report bytes at different reported times keep both provenance records",async()=>{
  const result=await recallWiki(fixture({origin2:true}),{query:"alpha beta"});
  const reports=result.evidence.filter(e=>e.kind==="preserved_report");
  assert.deepEqual(reports.map(e=>e.timestamp).sort(),["2026-10-20T01:00:00Z","2026-10-21T01:00:00Z"]);
});

test("a conflicting original hash cannot inherit report provenance",async()=>{
  const wiki=fixture();const request=wiki.request;
  wiki.request=async input=>{
    const result=await request(input);
    return input.op==="source_read"&&input.source_id==="original"?{...result,hash:"c".repeat(64)}:result;
  };
  await assert.rejects(recallWiki(wiki,{query:"alpha beta"}),/preserved_report_hash_mismatch/);
});
