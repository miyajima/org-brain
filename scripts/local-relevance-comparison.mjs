#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { localDenseEmbeddingProviderFromEnvironment } from "../packages/orgbrain-cli/src/lib/local-dense-embedding.mjs";
import { LocalRelevanceSelector } from "../packages/orgbrain-cli/src/lib/local-relevance-selection.mjs";

const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const selectedIds=(row,arm,threshold)=>row.arms[arm].map((id,index)=>({id,index,score:row.scores[id]}))
  .filter(x=>x.score>=threshold).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,5).map(x=>x.id);
const rank=(ids,expected)=>ids.findIndex(id=>expected.includes(id))+1;
function metrics(rows,idsFor){
  const positives=rows.filter(x=>x.expected_ids.length),negatives=rows.filter(x=>!x.expected_ids.length);
  const ranks=positives.map(x=>rank(idsFor(x),x.expected_ids));
  return {positive_count:positives.length,hit_at_1:mean(ranks.map(x=>Number(x===1))),hit_at_5:mean(ranks.map(x=>Number(x>0))),
    mrr_at_5:mean(ranks.map(x=>x?1/x:0)),negative_count:negatives.length,
    negative_any_result_rate:mean(negatives.map(x=>Number(idsFor(x).length>0))),mean_result_count:mean(rows.map(x=>idsFor(x).length))};
}
export function armMetrics(rows,arm,threshold){
  return {raw:metrics(rows,x=>x.arms[arm].slice(0,5)),selected:metrics(rows,x=>selectedIds(x,arm,threshold)),
    lost_targets:rows.filter(x=>x.expected_ids.length&&rank(x.arms[arm].slice(0,5),x.expected_ids)>0&&!rank(selectedIds(x,arm,threshold),x.expected_ids)).length};
}
export function chooseThreshold(rows,thresholds){
  const arms=Object.keys(rows[0].arms);
  const grid=thresholds.map(threshold=>{
    const evaluated=arms.map(arm=>armMetrics(rows,arm,threshold));
    return {threshold,lost_targets:evaluated.reduce((n,x)=>n+x.lost_targets,0),
      mean_negative_rate:mean(evaluated.map(x=>x.selected.negative_any_result_rate)),mean_hit_at_5:mean(evaluated.map(x=>x.selected.hit_at_5))};
  });
  const feasible=grid.filter(x=>x.lost_targets===0).sort((a,b)=>a.mean_negative_rate-b.mean_negative_rate||b.mean_hit_at_5-a.mean_hit_at_5||a.threshold-b.threshold);
  return {qualified:feasible.length>0,threshold:feasible[0]?.threshold??null,grid};
}
export function assertReusableProjection(rows,provider,dimensions,unitCount){
  if(rows.length!==1||rows[0].provider!==provider||rows[0].feature_count!==dimensions||rows[0].vector_format!=="dense-f32"||rows[0].count!==unitCount||!unitCount)throw Error("projection incomplete or mismatched");
}
export function verifyProjection(db,provider,dimensions){
  const units=db.prepare("SELECT count(*) AS count FROM memory_retrieval_units_v4").get().count;
  const rows=db.prepare("SELECT provider,feature_count,vector_format,count(*) AS count FROM memory_retrieval_unit_embeddings_v4 GROUP BY provider,feature_count,vector_format").all();
  assertReusableProjection(rows,provider,dimensions,units);
  const invalid=db.prepare(`SELECT count(*) AS count FROM memory_retrieval_units_v4 u
    LEFT JOIN memory_retrieval_unit_embeddings_v4 e ON e.unit_id=u.id AND e.tenant_id=u.tenant_id
    WHERE e.unit_id IS NULL OR e.vector_blob IS NULL OR length(e.vector_blob) != e.feature_count*4`).get().count;
  const orphans=db.prepare(`SELECT count(*) AS count FROM memory_retrieval_unit_embeddings_v4 e
    LEFT JOIN memory_retrieval_units_v4 u ON e.unit_id=u.id AND e.tenant_id=u.tenant_id WHERE u.id IS NULL`).get().count;
  if(invalid||orphans)throw Error("projection contains missing, orphaned or malformed vectors");
  return rows;
}
const corpus=dbPath=>{
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try {const rows=db.prepare("SELECT id,tenant_id,project_id,current_version,content_hash,lifecycle_state FROM memories ORDER BY id").all();return {hash:hash(JSON.stringify(rows)),count:rows.length};}
  finally {db.close();}
};
async function main(){
  const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
  const directory=resolve(args.get("--directory"));const phase=args.get("--phase");
  if(!["calibration","holdout"].includes(phase))throw Error("invalid phase");
  const policyBytes=await readFile(join(directory,"policy-frozen.json"));const policy=JSON.parse(policyBytes);
  const frozen=phase==="holdout"?JSON.parse(await readFile(join(directory,"threshold-frozen.json"),"utf8")):null;
  if(frozen&&(!frozen.qualified||frozen.policy_hash!==hash(policyBytes)))throw Error("unqualified or changed policy");
  // The holdout file is opened only after a qualified common threshold has been frozen on disk.
  const queryBytes=await readFile(join(directory,`${phase}-queries.json`));const queries=JSON.parse(queryBytes).queries;
  if(!Array.isArray(queries)||!queries.length)throw Error("no queries");
  const off=async()=>({mode:"off",applied:false});
  const arms={gemma:{provider:"embeddinggemma2-ollama",model:policy.models[0]},qwen:{provider:"qwen-ollama",model:policy.models[1]}};
  let corpusHash=null;
  for(const [name,arm]of Object.entries(arms)){
    const dbPath=join(directory,`${name}.sqlite`);const identity=corpus(dbPath);
    if(corpusHash&&corpusHash!==identity.hash)throw Error("corpus mismatch");corpusHash=identity.hash;
    const provider=localDenseEmbeddingProviderFromEnvironment({ORGBRAIN_LOCAL_EMBEDDING_PROVIDER:arm.provider,ORGBRAIN_LOCAL_EMBEDDING_MODEL:arm.model,ORGBRAIN_LOCAL_EMBEDDING_TIMEOUT_MS:"120000"});
    if(!provider)throw Error("provider unavailable");
    arm.store=new LocalMemoryStore(dbPath,{denseEmbeddingProvider:provider,relevanceSelector:null,memoryJudge:off});
    if(phase==="calibration"&&args.get("--reuse-projection")!=="yes"){
      process.stderr.write(`Projecting ${name}\n`);
      arm.projection=await arm.store.rebuildDenseEmbeddings({tenant_id:"default"});
    }
    const check=new DatabaseSync(dbPath,{readOnly:true});
    try{
      arm.projection_identity=verifyProjection(check,provider.provider,provider.dimensions);
    }finally{check.close();}
    arm.provider=provider.provider;arm.dimensions=provider.dimensions;
    const tags=await(await fetch(`${provider.endpoint}/api/tags`)).json();
    const tag=tags.models?.find(x=>x.name===arm.model);arm.digest=tag?.digest;arm.details=tag?.details;
  }
  const at=frozen?.at??Date.now();
  const selector=new LocalRelevanceSelector({revision:policy.reranker_revision,minimum_score:0,candidate_limit:50,timeout_ms:120000});
  const rows=[];
  for(const [index,query] of queries.entries()){
    const row={...query,arms:{},search_ms:{},scores:{}};const union=new Map();
    for(const[name,arm]of Object.entries(arms)){
      const start=performance.now();
      const candidates=await arm.store.search({tenant_id:"default",query:query.query,project_id:null,limit:policy.candidate_limit,search_mode:"hybrid_v4",at});
      row.search_ms[name]=performance.now()-start;row.arms[name]=candidates.map(x=>x.memory.id);
      for(const candidate of candidates)union.set(candidate.memory.id,candidate);
    }
    const started=performance.now();const scored=await selector.select(query.query,[...union.values()]);
    if(scored.metadata.status!=="complete"||scored.metadata.scored_count!==union.size)throw Error(`reranker unavailable at ${index}`);
    for(const result of scored.results)row.scores[result.memory.id]=result.relevance.score;
    row.common_rerank_ms=performance.now()-started;row.union_count=union.size;rows.push(row);
    process.stderr.write(`${phase} ${index+1}/${queries.length} scored ${union.size}\n`);
    await writeFile(join(directory,`${phase}-progress.json`),JSON.stringify({rows,corpus_hash:corpusHash,query_hash:hash(queryBytes)},null,2),{mode:0o600});
  }
  let choice=frozen;
  if(phase==="calibration"){
    choice={...chooseThreshold(rows,policy.threshold_grid),at,policy_hash:hash(policyBytes),calibration_query_hash:hash(queryBytes),corpus_hash:corpusHash};
    await writeFile(join(directory,"threshold-frozen.json"),JSON.stringify(choice,null,2)+"\n",{mode:0o600,flag:"wx"});
  }
  if(choice.corpus_hash!==corpusHash)throw Error("corpus changed after threshold freeze");
  const report={schema:"local-relevance-comparison/v1",phase,at,policy_hash:hash(policyBytes),corpus_hash:corpusHash,query_hash:hash(queryBytes),
    threshold:choice.threshold,qualified:choice.qualified,
    query_origin:"Authored from frozen active memories; disjoint calibration and holdout targets; incomplete relevance labels",
    latency_note:"Search times exclude reranking. Rerank times score the union once for both arms, not end-to-end serving latency.",
    models:Object.fromEntries(Object.entries(arms).map(([name,{store,...metadata}])=>[name,metadata])),
    metrics:choice.qualified?Object.fromEntries(Object.keys(arms).map(name=>[name,armMetrics(rows,name,choice.threshold)])):null,rows};
  for(const[name]of Object.entries(arms))if(corpus(join(directory,`${name}.sqlite`)).hash!==corpusHash)throw Error("corpus mutation");
  await writeFile(join(directory,`${phase}-result.json`),JSON.stringify(report,null,2)+"\n",{mode:0o600,flag:"wx"});
  process.stdout.write(JSON.stringify({phase,qualified:choice.qualified,threshold:choice.threshold,metrics:report.metrics})+"\n");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error);process.exitCode=1;});
