import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {projectWorkRequest} from './memory-task-project-install.mjs';
import {workObservationSummary} from '../packages/orgbrain-cli/src/lib/memory-task-observation.mjs';
const argv=process.argv.slice(2),root=resolve(process.env.ORGBRAIN_REUSE_ROOT||process.cwd());
if(argv[0]==='status'){console.log(JSON.stringify(await workObservationSummary(root),null,2));process.exit(0);}
const config=JSON.parse(await readFile(join(root,'.local/memory-reuse/config.json'),'utf8'));
if(!argv.length||argv[0]==='list'){
 for(const [id,w] of Object.entries(config.task_workflows??{}).filter(([,w])=>w.source_mode==='project_files'))console.log(`${w.kind}: ${w.title}\n  ${id}: ${Object.entries(w.units).map(([u,title])=>u+'='+title).join(', ')}`);
 console.log('Usage: pnpm claude:work research|analysis|document [--units a,b] [--prompt TEXT] [--prepare-only] [--control]');process.exit(0);
}
const value=flag=>{const i=argv.indexOf(flag);return i<0?undefined:argv[i+1];};
const request=projectWorkRequest(config,argv[0],{prompt:value('--prompt'),units:value('--units')?.split(','),observation_origin:value('--origin')??'organic'}),directory=join(root,'.local/memory-reuse/work-requests');
await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,request.session_id+'.json');await writeFile(path,JSON.stringify(request),{mode:0o600,flag:'wx'});
const launcher=fileURLToPath(new URL('./memory-reuse-task-local.mjs',import.meta.url)),child=spawn(process.execPath,[launcher,'--request',path,...argv.filter(x=>['--prepare-only','--control'].includes(x))],{cwd:root,env:{...process.env,ORGBRAIN_REUSE_ROOT:root},stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
