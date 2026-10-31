import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse,recordReuseAction,reuseDigest} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
import {handleLocalMcpRequest} from '../packages/orgbrain-cli/src/local-mcp.mjs';
import {collectMemoryUse} from '../packages/orgbrain-cli/src/lib/memory-use-collector.mjs';

const [command,rootArg,runId,raw]=process.argv.slice(2),root=resolve(rootArg);
const processStarted=performance.now();
const runtimeDigest=reuseDigest({adapter:await readFile(fileURLToPath(import.meta.url),'utf8'),engine:await readFile(new URL('../packages/orgbrain-cli/src/lib/memory-reuse.mjs',import.meta.url),'utf8'),node:process.version});
const save=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const rows=async p=>{try{return (await readFile(p,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
const store=new LocalMemoryStore(join(root,'memory.sqlite'),{denseEmbeddingProvider:null,memoryJudge:null,relevanceSelector:null});
const common={tenant_id:'default',project_id:'org-brain',work_type:'implementation'};
const scope=principal=>({...common,principal_id:principal});
const targetRef=(target,version)=>({source_id:'synthetic-'+target,source_version:version});
const fingerprint=(c,rule)=>reuseDigest({target:c.target,records:c.records,source_version:rule.version,source_digest:reuseDigest(rule),runtime:runtimeDigest,environment:'local-test'});
const expected=(c,rule)=>({target:c.target,mode:rule.mode,batch_size:rule.batch_size,region:rule.region,retain_days:rule.retain_days,deduplicate:true,partitions:Math.ceil(c.records/rule.batch_size)});
function validatePlan(plan,state){const errors=Object.keys(state.expected).filter(k=>JSON.stringify(plan?.[k])!==JSON.stringify(state.expected[k]));return {ok:errors.length===0,violated_fields:errors,applied_plan:plan};}
async function seedRule(target,rule) {
  const owner=['queue','ledger'].includes(target)?'alice':'author';
  const permissions=['queue','ledger'].includes(target)?[{principal_type:'principal',principal_id:'alice',permissions:['read']}]:[];
  const captured=await store.capture({id:'synthetic-'+target,external_key:'reuse-loop:'+target,...common,kind:'fact',source:'synthetic-reuse-corpus',capture_origin:'synthetic',
    content:`Synthetic ${target} planning rules: ${JSON.stringify(rule)}. For records=N, partitions=ceil(N/batch_size). Always deduplicate.`,
    summary:`${target} planning rules`,rationale:'These constraints are defined in the synthetic source document.',reuse_rule:`Only for ${target}.plan, using this source version.`,
    source_references:[{ref:`synthetic:${target}.json`}],actor_id:owner,permissions});
  const memory=await store.get('default',captured.memory_id);
  await new MemoryReuse(store,scope(owner)).link({...targetRef(target,memory.current_version),object_type_key:'service',object_id:target,operation:target+'.plan',unresolved:target==='queue'});
  return memory.current_version;
}
if(command==='setup') {
  await mkdir(root,{recursive:true});await store.init();await store.useHistory('configure',{mode:'a',collect:true});
  const rules={queue:{mode:'serial',batch_size:8,region:'east',retain_days:14,version:1},ledger:{mode:'atomic',batch_size:5,region:'west',retain_days:30,version:1},archive:{mode:'append',batch_size:6,region:'north',retain_days:60,version:1},billing:{mode:'reconcile',batch_size:7,region:'south',retain_days:90,version:1},sandbox:{mode:'preview',batch_size:4,region:'east',retain_days:1,version:1},scratch:{mode:'preview',batch_size:3,region:'west',retain_days:2,version:1}};
  for(const target of ['queue','ledger','archive','billing'])await seedRule(target,rules[target]);
  const cases=[['queue',17],['queue',33],['ledger',15],['ledger',29],['sandbox',11],['archive',21],['archive',31],['billing',19],['billing',25],['scratch',13]].map(([target,records],i)=>({id:i+1,target,records,principal:i<5?'alice':'bob',audience:i<5?'personal':'team',eligible:!['sandbox','scratch'].includes(target)}));
  await save(join(root,'corpus.json'),{rules,cases,origin:'Manually seeded synthetic source-backed facts; historical capture/admission and real team adoption are not claimed.'});
  console.log(JSON.stringify({ready:true,cases:cases.length}));
} else if(command==='prepare') {
  const info=JSON.parse(raw),corpus=await load(join(root,'corpus.json'));
  const cases=info.cohort==='B'?(await load(join(root,'holdout-B.json'))).cases:corpus.cases;
  const baseCase=cases.find(c=>c.id===info.case_id);
  const c={...baseCase,records:baseCase.records+(info.phase==='preparation'&&info.cohort!=='B'?info.revision*101:0),
    principal:info.phase==='preparation'&&info.actor?info.actor:baseCase.principal};
  const rule=corpus.rules[c.target],service=new MemoryReuse(store,scope(c.principal));
  const started=performance.now();
  let recall={context:'',items:[],references:[],elapsed_ms:0};
  if(info.condition==='memory') {
    const response=await handleLocalMcpRequest(store,{method:'tools/call',params:{name:'orgbrain_context_enrich',arguments:{...scope(c.principal),task_id:runId,query:c.target+' planning',usage_purpose:'test',object_type_key:'service',object_id:c.target,reuse:{channel:info.channel,operation:c.target+'.plan',fingerprint:fingerprint(c,rule),artifact_cutoff_ms:info.artifact_cutoff_ms,cross_principal:c.audience==='team',flags:{[info.channel]:true}}}}});
    if(response.isError)throw Error(response.content[0].text);recall=JSON.parse(response.content[0].text);
  }
  const dir=join(root,'runs',runId);await mkdir(dir,{recursive:true});
  await save(join(dir,'state.json'),{...info,...c,task_id:runId,scope:scope(c.principal),rule,expected:expected(c,rule),fingerprint:fingerprint(c,rule),recall});
  await save(join(dir,'recall.json'),recall);
  console.log(JSON.stringify({case:c,recall,prepare_ms:performance.now()-started}));
} else if(command==='revise') {
  const corpus=await load(join(root,'corpus.json')),c=corpus.cases.find(c=>c.id===Number(runId));
  if(c.eligible){corpus.rules[c.target].retain_days++;corpus.rules[c.target].version++;
    const actual=await seedRule(c.target,corpus.rules[c.target]);
    if(actual!==corpus.rules[c.target].version)throw Error('source_version_diverged');await save(join(root,'corpus.json'),corpus);}
  console.log(JSON.stringify({revised:c.eligible}));
} else if(command==='promote') {
  const corpus=await load(join(root,'corpus.json'));const artifacts=[];
  for(const target of ['queue','ledger','archive','billing']) {
    const principal=['queue','ledger'].includes(target)?'alice':'author';
    artifacts.push(await new MemoryReuse(store,scope(principal)).createArtifact({kind:'procedure',object_type_key:'service',object_id:target,
      refs:[targetRef(target,corpus.rules[target].version)],payload:{rules:corpus.rules[target],formula:'partitions=ceil(records/batch_size); deduplicate=true'},allowed_principals:principal==='author'?['bob']:[]}));
  }
  console.log(JSON.stringify({artifacts}));
} else if(command==='api') {
  const args=JSON.parse(raw),dir=join(root,'runs',runId),state=await load(join(dir,'state.json'));
  const started=performance.now();let result;
  if(args.op==='index')result={documents:Object.keys((await load(join(root,'corpus.json'))).rules).map(t=>t+'.json')};
  else if(args.op==='read') {
    const key=String(args.document??'').replace(/\.json$/u,'');
    const rule=(await load(join(root,'corpus.json'))).rules[key];
    result=rule?{document:key+'.json',rules:rule,formula:'partitions=ceil(records/batch_size); deduplicate=true'}:{error:'document_not_found'};
  } else if(args.op==='apply') {
    if(state.channel==='result'&&state.condition==='memory'&&state.recall.artifact_id) {
      result=await new MemoryReuse(store,state.scope).applyArtifact({artifact_id:state.recall.artifact_id,fingerprint:state.fingerprint,task_id:runId},async(payload)=>{
        const equal=args.plan&&Object.keys(args.plan).length===Object.keys(payload).length&&Object.keys(payload).every(k=>args.plan[k]===payload[k]);
        return equal?{ok:true,violated_fields:[],applied_plan:args.plan,validation_source:'prior_verified_identical_input'}:
          {...validatePlan(args.plan,state),reuse_applied:false};
      });
    } else result=validatePlan(args.plan,state);
  } else if(args.op==='apply_artifact') {
    if(!state.recall.artifact_id||args.artifact_id!==state.recall.artifact_id)result={error:'artifact_not_provided'};
    else result=await new MemoryReuse(store,state.scope).applyArtifact({artifact_id:args.artifact_id,fingerprint:state.fingerprint,task_id:runId},async(payload,kind)=>{
      if(kind==='result')return validatePlan(payload,state);
      const r=payload.rules;
      const plan={target:state.target,mode:r.mode,batch_size:r.batch_size,region:r.region,retain_days:r.retain_days,deduplicate:true,
        partitions:Math.trunc((state.records+r.batch_size-1)/r.batch_size)};
      return validatePlan(plan,state);
    });
  } else if(args.used===true) {
    result=await new MemoryReuse(store,state.scope).reportUse(args,runId,{task:'synthetic batch planning',target:state.target,constraints:'preserve all source constraints',conditions:`${state.target}.plan current source version ${state.rule.version}`});
  } else result={error:'unsupported_operation'};
  result={...result,adapter_call_id:randomUUID()};
  await appendFile(join(dir,'calls.jsonl'),JSON.stringify({args,result,elapsed_ms:performance.now()-started})+'\n');
  console.log(JSON.stringify(result));
} else if(command==='hook') {
  const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>resolve(s));}));
  const dir=join(root,'runs',runId),state=await load(join(dir,'state.json')),calls=await rows(join(dir,'calls.jsonl'));
  const response=JSON.stringify(input.tool_response),entry=calls.find(c=>response.includes(c.result.adapter_call_id));
  let hint={};
  if(entry) {
    const cache=entry.args.op==='apply'&&entry.result.ok&&state.eligible?{object_type_key:'service',object_id:state.target,refs:[targetRef(state.target,state.rule.version)],payload:entry.result.applied_plan,fingerprint:state.fingerprint}:null;
    await recordReuseAction(store,state.scope,{call_id:input.tool_use_id,task_id:runId,completed:true,ok:entry.result.ok===true,args:entry.args,result:entry.result,cache});
    if(entry.result.derived_application_token)await new MemoryReuse(store,state.scope).confirmApplication(entry.result.derived_application_token,
      {call_id:input.tool_use_id,task_id:runId,args:entry.args,result:entry.result});
    if(entry.args.op==='apply'&&entry.result.ok&&state.eligible) {
      await new MemoryReuse(store,state.scope).createArtifact({kind:'result',object_type_key:'service',object_id:state.target,refs:[targetRef(state.target,state.rule.version)],payload:entry.result.applied_plan,fingerprint:state.fingerprint,action_ref:input.tool_use_id,
        allowed_principals:state.audience==='team'?['bob','author']:[]});
    }
    if(entry.args.op==='apply'&&!entry.result.derived_application_token&&state.recall.items?.length) {
      const signals=state.recall.items.map(item=>({used:true,usage_item_id:item.usage_item_id,action_call_id:input.tool_use_id}));
      hint={hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'If the provided reference actually informed the completed action, explicitly invoke the same adapter with this JSON OBJECT (not an array) and print its returned use_receipt: '+JSON.stringify(signals[0])+'. Otherwise do not report use. Delivery and receipt issuance do not establish usefulness.'}};
    }
  }
  await appendFile(join(dir,'hooks.jsonl'),JSON.stringify({input,matched:!!entry,hint})+'\n');console.log(JSON.stringify(hint));
} else if(command==='collect') {
  const dir=join(root,'runs',runId),state=await load(join(dir,'state.json')),events=await rows(join(dir,'events.jsonl'));
  const normalized=[];if(state.recall.context)normalized.push({payload:{type:'message',role:'developer',content:state.recall.context}});
  for(const e of events)for(const b of e.message?.content??[]) {
    if(b.type==='tool_use')normalized.push({payload:{type:'function_call',call_id:b.id,name:b.name,arguments:JSON.stringify(b.input)}});
    if(b.type==='tool_result')normalized.push({payload:{type:'function_call_output',call_id:b.tool_use_id,output:typeof b.content==='string'?b.content:JSON.stringify({content:b.content})}});
  }
  const start=performance.now();const collection=await collectMemoryUse(store,{tenantId:'default',projectId:'org-brain',taskId:runId,principal:state.principal,turnId:'trial',rows:normalized});
  const applications=await new MemoryReuse(store,state.scope).applications(runId);
  await save(join(dir,'collection.json'),{...collection,applications});
  console.log(JSON.stringify({...collection,applications,collector_ms:performance.now()-start}));
} else throw Error('unknown_command');
if(['setup','revise','promote'].includes(command))await appendFile(join(root,'lifecycle.jsonl'),JSON.stringify({command,elapsed_ms:performance.now()-processStarted,model_calls:0})+'\n');
