import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalMemoryStore} from '../../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {localUseService,storeLocalUseProof} from '../../packages/orgbrain-cli/src/lib/local-memory-use.mjs';
export async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'orgbrain-use-'));
  const store=new LocalMemoryStore(join(dir,'db.sqlite'),{denseEmbeddingProvider:null});
  await store.init();
  await store.useHistory('configure',{mode:'c',collect:true});
  const captured=await store.capture({tenant_id:'t',project_id:'p',content:'alpha procedure for idempotent execution',summary:'alpha procedure',kind:'fact',work_type:'implementation',source:'test',tags:[]});
  const id=captured.memory_id;
  const usage=await store.recordUsage({id:'usage',tenant_id:'t',project_id:'p',task_id:'prior-task',access_path:'search',request_source:'local',requested_work_type:'implementation',items:[{id:'item',source_type:'memory',source_id:id,source_version:1}]});
  const db=store.open();
  let now=Date.now();
  const service=localUseService(db,'t','local',()=>now);
  const scope={tenant_id:'t',principal:'local',project_id:'p',task_id:'prior-task',source_id:id,usage_item_id:'item',created_at:now};
  const evidence=await Promise.all([
    {role:'action',text:'used alpha to reconcile the timed out operation'},
    {role:'outcome',text:'operation reconciled; no duplicate'},
    {role:'assessment',text:'alpha was useful',contribution:'positive'}
  ].map(e=>storeLocalUseProof(db,{...scope,...e})));
  const payload={id:'context',usage_item_id:'item',project_id:'p',task_id:'prior-task',work_type:'implementation',context:{task:'recover timeout',target:'duplicate transaction',constraints:'',conditions:''},evidence};
  return {dir,store,db,service,payload,id,usage,evidence,setNow:v=>{now=v;},now,
    close:async()=>{db.close();await rm(dir,{recursive:true,force:true});}};
}
