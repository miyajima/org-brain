import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallWiki } from "../packages/orgbrain-cli/src/lib/wiki-recall.mjs";

function fixture() {
  const calls = [];
  const wiki = { async request(input) {
    calls.push(input);
    if (input.op === "search") {
      if (input.scope === "wiki") return { hits: [{ kind:"page",owner_id:"p",chunk_id:1,heading:"General",snippet:"一般の背景だけ。",start_line:1,end_line:2 }],truncated:false };
      return { hits: [{kind:"source",owner_id:"unlinked",version:2,chunk_id:2,heading:"Result",snippet:"needle復旧。146件成功、配備は未確認。",start_line:5,end_line:7}],truncated:false };
    }
    if(input.op === "source_read") return {source_id:input.source_id,version:input.version,hash:"a".repeat(64),text:"needle復旧。146件成功、配備は未確認。",start_line:5,end_line:7,query_in_excerpt:true};
    if(input.op === "links") return {citations:[]};
    throw Error("unexpected op "+input.op);
  }};
  return {wiki,calls};
}

test("recall searches unlinked originals even when a generic Wiki page matched", async()=>{
  const {wiki,calls}=fixture();
  const result=await recallWiki(wiki,{query:"needle 復旧",max_chars:2000});
  assert.ok(result.evidence.some(e=>e.source_id==="unlinked"&&e.version===2));
  assert.ok(calls.some(c=>c.op==="search"&&c.scope==="sources"&&!c.page_id));
  assert.equal(result.writes_performed,false);
  assert.equal(result.session_accessed,false);
  assert.ok(result.evidence.every(e=>e.text.length>0));
});

test("recall keeps exact filters through every search and pinned source read",async()=>{
  const {wiki,calls}=fixture();
  await recallWiki(wiki,{query:"needle",project_id:"one",source_id:"s",since:"2026-01-01T00:00:00Z",until:"2027-01-01T00:00:00Z"});
  for(const c of calls.filter(c=>c.op==="search")) {assert.equal(c.project_id,"one");assert.equal(c.source_id,"s");assert.equal(c.until,"2027-01-01T00:00:00Z");}
  assert.ok(calls.some(c=>c.op==="source_read"&&c.version===2));
});

test("explicit session fallback is bounded, cites locations and does not persist text",async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),"wiki-session-")));
  try {
    const file=join(home,"session.jsonl");
    const rows=[{type:"session_meta",payload:{id:"s1",cwd:"/project"}},
      {timestamp:"2026-10-20T01:00:00Z",type:"response_item",payload:{type:"message",role:"assistant",phase:"final",content:[{type:"output_text",text:"# 結果\nneedle復旧、768次元成功。\n索引利用は未確認。"}]}},
      {timestamp:"2026-11-03T01:00:00Z",type:"response_item",payload:{type:"message",role:"assistant",phase:"final",content:[{type:"output_text",text:"future needle秘密の別時点"}]}}];
    await writeFile(file,rows.map(r=>JSON.stringify(r)).join("\n\n"));
    const wiki={async request(){return {hits:[],truncated:false};}};
    const result=await recallWiki(wiki,{query:"needle 復旧",session_files:[file],workspace:"/project",session_until:"2026-11-02T00:00:00Z",max_chars:2000});
    assert.equal(result.session_accessed,true);
    assert.equal(result.writes_performed,false);
    assert.ok(result.evidence.some(e=>e.kind==="session"&&e.session_id==="s1"&&e.start_line===3));
    assert.equal(result.evidence.find(e=>e.kind==="session").end_line,3);
    assert.ok(!JSON.stringify(result).includes("future needle"));
    assert.ok(!JSON.stringify(result).includes(file));
    await assert.rejects(recallWiki(wiki,{query:"needle",session_files:[file],workspace:"/other"}),/session_workspace_mismatch/);
  } finally {await rm(home,{recursive:true,force:true});}
});

test("session fallback is not read without an explicit file and workspace",async()=>{
  const {wiki}=fixture();
  await assert.rejects(recallWiki(wiki,{query:"needle",session_files:["/not/read"]}),/session_workspace_required/);
});

test("a title-only source match can be read without an empty excerpt query",async()=>{
  const wiki={async request(input){
    if(input.op==="search") return {hits:input.scope==="sources"?[{kind:"source",owner_id:"s",version:1,chunk_id:1,title:"needle",heading:"",snippet:"本文。"}]:[]};
    if(input.query==="") throw Error("invalid_query_terms");
    return {text:"本文。",truncated:true,source_id:"s",version:1};
  }};
  const result=await recallWiki(wiki,{query:"needle"});
  assert.ok(result.evidence.length>0);
});

test("a long preservation inventory keeps its event provenance when read",async()=>{
  const manifest={schema:"wiki-report-preservation/v1",origin:{recorded_at:"2026-10-20T01:00:00Z",session_id:"s"},original:{source_id:"original",version:1},items:[{text:"needle復旧、146件成功。"}]};
  const wiki={async request(input){
    if(input.op==="search") return {hits:input.scope==="sources"?[{kind:"source",owner_id:"inventory",version:1,chunk_id:1,heading:"",snippet:"needle復旧"}]:[]};
    if(input.source_id==="original") return {name:"report.md",text:"needle復旧、146件成功。",truncated:false};
    if(input.max_chars===64000) return {name:"report-inventory.json",text:JSON.stringify(manifest),truncated:false};
    return {name:"report-inventory.json",text:'{"items":[',truncated:true};
  }};
  const result=await recallWiki(wiki,{query:"needle 復旧"});
  assert.equal(result.evidence[0].kind,"preserved_report");
  assert.equal(result.evidence[0].timestamp,"2026-10-20T01:00:00Z");
  assert.equal(result.evidence[0].text,"needle復旧、146件成功。");
});
