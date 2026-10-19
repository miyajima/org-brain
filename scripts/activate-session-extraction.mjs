// Bounded local activation for the user's explicit shared-extraction request.
// Prepare first; apply verifies byte hashes before any change. No inference.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {runConnectorCommand,sessionExtractionHooksPlan,mergeClaudeHooks,mergeCursorHooks} from '../packages/orgbrain-cli/src/connector-setup.mjs';
const home=os.homedir(),repo=path.resolve(new URL('..',import.meta.url).pathname),root=path.join(home,'.org-brain/evaluations/shared-extraction-20261019');
const source=path.join(repo,'packages/orgbrain-cli/dist/orgbrain.mjs');
const runtime=path.join(home,'.org-brain/runtimes/attempt-pilot-current/node_modules/orgbrain/dist/orgbrain.mjs');
const envfile=path.join(home,'.config/org-brain/hooks.env');
const targets=[runtime,envfile,path.join(home,'.claude/settings.json'),path.join(home,'.cursor/hooks.json')];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const hashFile=f=>fs.existsSync(f)?sha(fs.readFileSync(f)):null;
const revision='review-v4';const planFile=path.join(root,`activation-plan-${revision}.json`);
function validateHookMerges(){for(const client of ['claude','cursor']){const plan=sessionExtractionHooksPlan(client,{cliPath:runtime});const raw=fs.existsSync(plan.files.hooks)?fs.readFileSync(plan.files.hooks,'utf8'):'';const merged=(client==='claude'?mergeClaudeHooks:mergeCursorHooks)(raw,plan.handlers);JSON.parse(merged);}}
const flags={ORGBRAIN_SESSION_EXTRACTION_MODE:'on',ORGBRAIN_SESSION_EXTRACTION_PROJECTS:'consentside,org-brain,AIma,socia,sfk-shinsa,jrg,factoreview,smart-block,tsugi',ORGBRAIN_SESSION_EXTRACTION_EXCLUDE_SESSIONS:'01a14729-306e-76d1-8e9e-79cee515fe12'};
const args={flags:new Set(['--execute','--approve-hooks']),get:(key,fallback)=>({'--mode':'extraction-hooks','--scope':'user','--workspace':repo,'--cli-path':runtime}[key]??fallback)};
const cursorVersion=()=>execFileSync('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-','/Applications/Cursor.app/Contents/Info.plist'],{encoding:'utf8'}).trim();
if(process.argv[2]==='prepare'){
 validateHookMerges();
 if(!fs.existsSync(runtime)||!fs.existsSync(envfile))throw Error('existing_runtime_and_hooks_env_required');
 const plan={source,source_hash:hashFile(source),targets:Object.fromEntries(targets.map(f=>[f,hashFile(f)])),flags,cursor_version:cursorVersion(),changes:['copy identical checked bundle into existing local runtime','Claude/Cursor Stop-only hooks preserving other configuration','enable extraction for exact project allowlist; exclude evaluation session'],no_model_calls:true,no_new_schedule:true};
 fs.writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({prepared:true,source_sha256:plan.source_hash,existing_files:targets.length,projects:flags.ORGBRAIN_SESSION_EXTRACTION_PROJECTS.split(',').length,cursor_version:plan.cursor_version}));
}else if(process.argv[2]==='apply'){
 const receipt=path.join(root,`activation-result-${revision}.json`);if(fs.existsSync(receipt))throw Error('activation_already_recorded');const plan=JSON.parse(fs.readFileSync(planFile));
 if(plan.source_hash!==hashFile(source)||JSON.stringify(plan.flags)!==JSON.stringify(flags)||cursorVersion()!==plan.cursor_version)throw Error('activation_plan_changed');
 for(const [f,h]of Object.entries(plan.targets))if(hashFile(f)!==h)throw Error('activation_target_changed');
 validateHookMerges();
 const backup=path.join(root,`activation-backup-${revision}`);fs.mkdirSync(backup,{mode:0o700});for(const [i,f]of targets.entries())if(fs.existsSync(f))fs.writeFileSync(path.join(backup,String(i)+'.original'),fs.readFileSync(f),{flag:'wx',mode:0o600});
 // The existing credential and backend values are byte-preserved.
 let env=fs.readFileSync(envfile,'utf8');for(const [k,v]of Object.entries(flags)){const lines=env.split('\n').filter(l=>!l.startsWith(k+'='));env=lines.join('\n').replace(/\n*$/u,'')+`\n${k}=${v}\n`;}
 const staged=envfile+'.session-extraction.tmp';fs.writeFileSync(staged,env,{flag:'wx',mode:0o600});
 const runtimeStaged=runtime+'.session-extraction.tmp';fs.writeFileSync(runtimeStaged,fs.readFileSync(source),{flag:'wx',mode:0o755});fs.renameSync(runtimeStaged,runtime);
 fs.renameSync(staged,envfile);fs.chmodSync(envfile,0o600);
 const installed=[];for(const client of ['claude','cursor'])installed.push(await runConnectorCommand('setup',[client],args,{cursorVersionOutput:plan.cursor_version}));
 if(hashFile(runtime)!==plan.source_hash)throw Error('installed_bundle_mismatch');
 const unchangedEnv=text=>text.split('\n').filter(l=>!Object.keys(flags).some(k=>l.startsWith(k+'='))).join('\n').replace(/\n*$/u,'');
 if(unchangedEnv(fs.readFileSync(path.join(backup,'1.original'),'utf8'))!==unchangedEnv(fs.readFileSync(envfile,'utf8')))throw Error('unrelated_env_changed');
 const result={installed:true,model:'anthropic/claude-sonnet-5.5',effort:'low',runner_model:'gpt-6.1-sol',runner_effort:'low',source_sha256:plan.source_hash,targets_changed:targets.length,stop_clients:installed.map(r=>r.agent),existing_schedule_changed:false,existing_backend_and_credentials_preserved:true,evaluation_session_excluded:true,client_restart_and_next_real_stop_unverified:true,model_calls:0,measured_at:new Date().toISOString()};
 fs.writeFileSync(receipt,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
}else throw Error('prepare|apply');
