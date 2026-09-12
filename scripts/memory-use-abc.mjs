#!/usr/bin/env node
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {localUseService,storeLocalUseProof} from '../packages/orgbrain-cli/src/lib/local-memory-use.mjs';
import {useHash,MEMORY_USE_POLICY} from '../packages/shared/src/memory-use-history-runtime.mjs';
const raw=await readFile(new URL('./fixtures/memory-use-history/abc-v1.json',import.meta.url),'utf8');
const fixture=JSON.parse(raw),cutoff=Date.parse(fixture.evidence_cutoff),queryAt=Date.parse(fixture.query_time);
const dir=await mkdtemp(join(tmpdir(),'orgbrain-use-abc-'));
const store=new LocalMemoryStore(join(dir,'db.sqlite'),{denseEmbeddingProvider:null});
const output=process.argv[2]||join(dir,'results.json');
const percentile=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
try {
  await store.init();
  await store.useHistory('configure',{mode:'c',collect:true,sync:true});
  for(const c of fixture.cases) {
    for(const [id,body] of [[c.relevant_id,c.body],...c.distractors.map((body,i)=>[`d-${c.id}-${i}`,body])]) {
      await store.capture({id,tenant_id:'abc',project_id:'project',work_type:'implementation',content:body,summary:body,kind:'fact',source:'synthetic-fixture',created_at:cutoff-86400000});
    }
    if(!c.context) continue;
    const db=store.open();
    try {
      const service=localUseService(db,'abc','local',()=>cutoff);
      // Distinct pre-cutoff task IDs. No query task contributes its own evidence.
      for(let i=0;i<3;i++) {
        const task=`history-${c.id}-${i}`,item=`item-${c.id}-${i}`,id=`use-${c.id}-${i}`;
        await store.recordUsage({id:`retrieval-${c.id}-${i}`,tenant_id:'abc',project_id:'project',task_id:task,access_path:'search',request_source:'local',requested_work_type:'implementation',created_at:cutoff-1,items:[{id:item,source_type:'memory',source_id:c.relevant_id,source_version:1}]});
        const scope={tenant_id:'abc',principal:'local',project_id:'project',task_id:task,source_id:c.relevant_id,usage_item_id:item,created_at:cutoff};
        const evidence=[];
        for(const proof of [{role:'action',text:`Fixture executed ${c.relevant_id}`},{role:'outcome',text:`Fixture verified ${c.id}`}]) evidence.push(await storeLocalUseProof(db,{...scope,...proof}));
        await service.record({id,usage_item_id:item,project_id:'project',task_id:task,work_type:'implementation',context:c.context,evidence});
        await service.evaluate({id:`evaluation-${c.id}-${i}`,context_id:id,feedback:{contribution:c.rating,statement:`Predeclared synthetic rating for ${c.id}`}});
      }
    } finally {db.close();}
  }
  const modes={};
  for(const mode of ['a','b','c']) {
    await store.useHistory('configure',{mode,collect:true,sync:true});
    const cases=[],durations=[];
    for(const c of fixture.cases) {
      const input={tenant_id:'abc',project_id:'project',work_type:'implementation',task_id:`query-${c.id}`,query:c.query,limit:5,at:queryAt,search_mode:'hybrid_v4'};
      for(let i=0;i<5;i++) await store.search(input);
      let result;
      for(let i=0;i<40;i++) {
        const start=performance.now();result=await store.search(input);durations.push(performance.now()-start);
      }
      const ids=result.map(x=>x.memory.id),rank=ids.indexOf(c.relevant_id);
      cases.push({id:c.id,group:c.group,ids,recall5:rank>=0?1:0,ndcg5:rank>=0?1/Math.log2(rank+2):0,snapshots:[...new Set(result.map(x=>x.use_history?.snapshot_id).filter(Boolean))],degraded_reasons:[...new Set(result.flatMap(x=>x.use_history_meta?.degraded_reasons??[]))]});
    }
    modes[mode]={recall5:mean(cases.map(c=>c.recall5)),ndcg5:mean(cases.map(c=>c.ndcg5)),p95_ms:percentile(durations),samples:durations.length,cases};
  }
  const {a,b,c}=modes;
  const group=(mode,name,metric)=>mean(mode.cases.filter(c=>c.group===name).map(c=>c[metric]));
  const gates={context_recall_b_gt_a:group(b,'context','recall5')>group(a,'context','recall5'),rated_ndcg_c_gt_b:group(c,'rated','ndcg5')>group(b,'rated','ndcg5'),important_regressions:c.cases.filter((q,i)=>q.group==='important'&&(q.recall5<a.cases[i].recall5||q.ndcg5<a.cases[i].ndcg5)).length,overall_at_least_a:[b,c].every(m=>m.recall5>=a.recall5&&m.ndcg5>=a.ndcg5),p95_b_ratio:b.p95_ms/a.p95_ms,p95_c_ratio:c.p95_ms/a.p95_ms,p95_within_1_15:[b,c].every(m=>m.p95_ms<=1.15*a.p95_ms)};
  const result={fixture_version:fixture.version,fixture_sha256:await useHash(raw),policy:MEMORY_USE_POLICY,runtime_sha256:await useHash(await readFile(new URL('../packages/shared/src/memory-use-history-runtime.mjs',import.meta.url),'utf8')),evidence_cutoff:fixture.evidence_cutoff,query_time:fixture.query_time,created_at:new Date().toISOString(),node:process.version,backend:'LocalMemoryStore + SQLite; hybrid_v4, dense provider disabled',modes,gates,offline_task_measures:{completion_rate:null,reinvestigations:null,input_tokens:null,wall_time:null,reason:'No real agent task execution; retrieval latency is measured separately. No model or external effect replay.'},conclusion:'Synthetic retrieval evidence only. Real task usefulness remains unconfirmed.'};
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,modes:Object.fromEntries(Object.entries(modes).map(([k,{cases,...v}])=>[k,v])),gates},null,2));
} finally {if(process.argv[2]) await rm(dir,{recursive:true,force:true});}
