import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalRelevanceSelector, localRelevanceSelectorFromSettings } from "../packages/orgbrain-cli/src/lib/local-relevance-selection.mjs";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { buildCompactMemoryContext } from "../packages/orgbrain-cli/src/lib/compact-memory-context.mjs";

const revision = "e61197ed45024b0ed8a2d74b80b4d909f1255473";
const candidate = (id) => ({memory:{id,content:`content ${id}`,summary:`summary ${id}`},score:{total:0.5}});
async function serverFor(handler) {
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(handler(JSON.parse(raw))));
  });
  await new Promise((resolve) => server.listen(0,"127.0.0.1",resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise((resolve)=>server.close(resolve))};
}
const response = (scores) => ({model:"Qwen/Qwen3-Reranker-0.6B",revision,scoring_version:"memory-relevance-yes-no/v1",instruction_hash:"74da2544e72fb2ef80f31edb1eee497aee6121eaf5c74b679fdc190ac890118e",scores});

test("local selection applies a calibrated score cutoff, ranks retained candidates and bounds the request", async () => {
  let sent;
  const server = await serverFor((body) => {sent=body;return response([{id:"a",score:0.2},{id:"b",score:0.9}]);});
  try {
    const selector = new LocalRelevanceSelector({url:server.url,revision,minimum_score:0.5,candidate_limit:2});
    const result = await selector.select("question",[candidate("a"),candidate("b"),candidate("c")]);
    assert.deepEqual(result.results.map((row)=>row.memory.id),["b"]);
    assert.equal(sent.documents.length,2);
    assert.equal(result.metadata.scored_count,2);
    assert.equal(result.metadata.unscored_count,1);
  } finally {await server.close();}
});

test("unknown, missing, duplicated or nonfinite scores and changed model revisions abstain", async () => {
  for (const scores of [[{id:"unknown",score:0.9}],[{id:"a",score:null}],[],[{id:"a",score:0.8},{id:"a",score:0.7}]]) {
    const server=await serverFor(()=>response(scores));
    try {
      const result=await new LocalRelevanceSelector({url:server.url,revision}).select("q",[candidate("a")]);
      assert.equal(result.results.length,0);assert.equal(result.metadata.status,"unavailable");
    } finally {await server.close();}
  }
  assert.throws(()=>new LocalRelevanceSelector({url:"https://example.com",revision}),/loopback/);
  const server=await serverFor(()=>({...response([{id:"a",score:0.9}]),revision:"other"}));
  try {assert.equal((await new LocalRelevanceSelector({url:server.url,revision}).select("q",[candidate("a")])).metadata.status,"unavailable");}
  finally {await server.close();}
});

test("selector settings are scoped to one DB and explicit off wins", async () => {
  const dir=await mkdtemp(join(tmpdir(),"local-relevance-settings-"));
  try {
    const db=join(dir,"memory.sqlite");
    await writeFile(`${db}.retrieval.json`,JSON.stringify({version:1,provider:"qwen3-reranker-mlx",revision,minimum_score:0.5}));
    assert.ok(localRelevanceSelectorFromSettings({},db));
    assert.equal(localRelevanceSelectorFromSettings({},join(dir,"other.sqlite")).provider,"working-llm");
    assert.equal(localRelevanceSelectorFromSettings({ORGBRAIN_LOCAL_RELEVANCE_PROVIDER:"off"},db),null);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("a local endpoint cannot redirect memory content and changed instructions are rejected", async () => {
  let forwarded=0;const target=await serverFor(()=>{forwarded++;return response([{id:"a",score:0.9}]);});
  const redirect=createServer((_req,res)=>{res.writeHead(307,{location:`${target.url}/rerank`});res.end();});
  await new Promise(resolve=>redirect.listen(0,"127.0.0.1",resolve));
  try {
    const result=await new LocalRelevanceSelector({url:`http://127.0.0.1:${redirect.address().port}`,revision}).select("q",[candidate("a")]);
    assert.equal(forwarded,0);assert.equal(result.metadata.status,"unavailable");
  } finally {await target.close();await new Promise(resolve=>redirect.close(resolve));}
  const changed=await serverFor(()=>({...response([{id:"a",score:0.9}]),instruction_hash:"changed"}));
  try {assert.equal((await new LocalRelevanceSelector({url:changed.url,revision}).select("q",[candidate("a")])).metadata.status,"unavailable");}
  finally {await changed.close();}
});

test("the shared store selector gates context even when memory-judgment omission is disabled", async () => {
  const dir=await mkdtemp(join(tmpdir(),"local-relevance-context-"));
  try {
    let scored=[];
    const selector={async select(_query,rows){scored=rows.map((row)=>row.memory.id);return {results:[],metadata:{status:"complete",scored_count:rows.length,kept_count:0}};}};
    const store=new LocalMemoryStore(join(dir,"memory.sqlite"),{denseEmbeddingProvider:null,relevanceSelector:selector});
    await store.capture({id:"public",tenant_id:"default",project_id:"test",kind:"fact",content:"Database backup",summary:"backup",lifecycle_state:"active",scope_type:"project",scope_key:"test",permissions:[],source:"test",tags:[],entities:[],source_references:[],actor_type:"principal",actor_id:"alice",conflicts:[],evidence:[]});
    const raw=await store.search({tenant_id:"default",query:"database backup"});assert.ok(raw.length);
    const selected=await store.selectMemorySearchResults(raw,{tenant_id:"default",query:"database backup",apply_selection:false});
    assert.equal(selected.results.length,0);assert.ok(scored.includes("public"));
    const context=await store.retrieveContext({tenant_id:"default",query:"database backup",context_format:"compact",token_budget:2000});
    assert.equal(context.results.length,0);assert.equal(context.meta.local_relevance.status,"complete");
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("revoked access is excluded before local inference and changed sources are excluded after inference", async () => {
  const dir=await mkdtemp(join(tmpdir(),"local-relevance-freshness-"));
  try {
    const stored=candidate("a").memory;
    const active={...stored,tenant_id:"default",project_id:"test",lifecycle_state:"active",permissions:[],current_version:1};
    let current={...active,permissions:[{principal_id:"bob",permissions:["read"]}]};let calls=0;
    const selector={async select(_query,rows){calls++;current={...active,content:"new source version",current_version:2};return {results:rows,metadata:{status:"complete"}};}};
    const store=new LocalMemoryStore(join(dir,"memory.sqlite"),{denseEmbeddingProvider:null,relevanceSelector:selector,memoryJudge:async()=>({mode:"off"})});
    store.get=async()=>current;
    const options={tenant_id:"default",principal_id:"alice",query:"q"};
    const revoked=await store.selectMemorySearchResults([{memory:active}],options);
    assert.equal(revoked.results.length,0);assert.equal(calls,0);
    current=active;
    const changed=await store.selectMemorySearchResults([{memory:active}],options);
    assert.equal(calls,1);assert.equal(changed.results.length,0);assert.equal(changed.local_relevance.source_changed_count,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("unavailable local verification returns an explicit compact-context omission within its budget", async () => {
  const dir=await mkdtemp(join(tmpdir(),"local-relevance-unavailable-"));
  try {
    const selector={async select(){return {results:[],metadata:{status:"unavailable",reason:"local_relevance_unavailable",kept_count:0}};}};
    const store=new LocalMemoryStore(join(dir,"memory.sqlite"),{denseEmbeddingProvider:null,relevanceSelector:selector});
    await store.capture({id:"available",tenant_id:"default",project_id:"test",kind:"fact",content:"Database backup",summary:"backup",lifecycle_state:"active",scope_type:"project",scope_key:"test",permissions:[],source:"test",tags:[],entities:[],source_references:[],actor_type:"principal",actor_id:"alice",conflicts:[],evidence:[]});
    const context=await store.retrieveContext({tenant_id:"default",query:"database backup",context_format:"compact",token_budget:1000});
    assert.equal(context.results.length,0);assert.equal(context.meta.local_relevance.status,"unavailable");
    assert.ok(JSON.stringify(context).includes("local_relevance_unavailable"));
    assert.ok(context.evidence_bundle.estimated_tokens<=1000);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("records moved outside requested category or work type never enter local inference", async () => {
  const dir=await mkdtemp(join(tmpdir(),"local-relevance-scope-"));
  try {
    const before={...candidate("a").memory,lifecycle_state:"active",project_id:"test",business_category_id:"engineering",work_type:"implementation",permissions:[]};
    let called=0;const selector={async select(_q,rows){called++;return {results:rows,metadata:{status:"complete"}};}};
    const store=new LocalMemoryStore(join(dir,"memory.sqlite"),{denseEmbeddingProvider:null,relevanceSelector:selector,memoryJudge:async()=>({mode:"off"})});
    for(const change of [{business_category_id:"sales"},{work_type:"support"}]){
      store.get=async()=>({...before,...change});
      const selection=await store.selectMemorySearchResults([{memory:before}],{tenant_id:"default",query:"q",business_category_id:"engineering",work_type:"implementation"});
      assert.equal(selection.results.length,0);assert.equal(called,0);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("minimum compact budget preserves explicit abstention when verifier metadata is large", () => {
  const localRelevance={model:"Qwen/Qwen3-Reranker-0.6B",revision,scoring_version:"memory-relevance-yes-no/v1",instruction_hash:"74da2544e72fb2ef80f31edb1eee497aee6121eaf5c74b679fdc190ac890118e",minimum_score:0.5,candidate_count:20,scored_count:0,kept_count:0,unscored_count:0,status:"unavailable",reason:"local_relevance_unavailable",source_changed_count:0};
  const {response}=buildCompactMemoryContext({results:[],query:"backup",topK:5,tokenBudget:512,at:Date.now(),usageId:"11111111-1111-1111-1111-111111111111",localRelevance,
    retrieval:{dense_provider:"ollama:embeddinggemma-2:270m-bf16-text:retrieval-v1",dimensions:768,query_embedding_completed:true,dense_scored_unit_count:1329,dense_candidate_count:20}});
  assert.ok(response.evidence_bundle.estimated_tokens<=512);assert.equal(response.evidence_bundle.abstention_recommended,true);
  assert.equal(response.meta.local_relevance.status,"unavailable");assert.ok(response.evidence_bundle.missing_evidence.includes("local_relevance_unavailable"));
});
