import {readFile,realpath} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
export async function loadTaskRuntimeConfig(root,env=process.env){
 root=await realpath(root);const normal=JSON.parse(await readFile(join(root,'.local/memory-reuse/config.json'),'utf8'));
 if(!env.ORGBRAIN_TASK_EVAL_CONFIG)return normal;
 if(env.ORGBRAIN_TASK_EVAL_SIMULATION!=='1')throw Error('evaluation_config_requires_explicit_test');
 const path=await realpath(resolve(root,env.ORGBRAIN_TASK_EVAL_CONFIG)),allowed=join(root,'.local/memory-reuse/evaluation')+'/';if(!path.startsWith(allowed))throw Error('evaluation_config_outside_project');
 const config=JSON.parse(await readFile(path,'utf8'));
 if(config.observation_purpose!=='test'||config.tenant_id!==normal.tenant_id||config.project_id!==normal.project_id)throw Error('evaluation_config_identity_mismatch');
 if(JSON.stringify(config.task_workflows)!==JSON.stringify(normal.task_workflows)||JSON.stringify(config.action_adapters)!==JSON.stringify(normal.action_adapters))throw Error('evaluation_config_source_or_adapter_changed');
 const db=resolve(root,config.db_path),parent=await realpath(dirname(db));if(!join(parent,basename(db)).startsWith(root+'/'))throw Error('evaluation_database_outside_project');
 return config;
}
