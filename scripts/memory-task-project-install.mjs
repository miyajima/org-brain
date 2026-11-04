import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {mergeReuseHooks} from '../packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs';
import {runDocumentWork} from '../packages/orgbrain-cli/src/lib/memory-task-document-adapter.mjs';

const OWNER='orgbrain-project-work/v1';
export function projectWorkProfiles(root){
 const report='artifacts/memory-task-delta-20261030/report.json',guide='docs/MEMORY_REUSE_TASK_CONFIRMATION.md',ordinary='docs/MEMORY_REUSE_ORDINARY_WORK.md',core='packages/orgbrain-cli/src/lib/memory-reuse-task-confirmation.mjs',consistency='packages/orgbrain-cli/src/lib/memory-task-consistency.mjs';
 const pointer=p=>({path:report,pointer:p}),heading=h=>({path:guide,heading:h});
 const definitions={
  research:{title:'OrgBrain再利用の実装調査',target:'project:reuse-implementation',units:{flow:'現行実装の流れと実行制限',evidence:'確認できた再利用と効果',limits:'条件と未観測事項'},document_units:{flow:[{path:core},{path:consistency}],evidence:[pointer('/reuse_counts'),pointer('/paired_improvement_checks'),pointer('/serial_validation_canaries')],limits:[heading('観測と評価'),pointer('/real_human_wait_ms'),pointer('/actual_billing_usd'),pointer('/parent_implementation_and_audit_cost')]},assignment:'現行実装を調べ、どの条件で元の成果を使えるか、実際の証拠と未検証の範囲を区別した調査メモを作成してください。'},
  analysis:{title:'OrgBrain再利用効果の再集計',target:'project:reuse-measurements',units:{totals:'記憶なしとのトークン・時間・費用の比較',audience:'個人とチーム模擬の比較',accounting:'作成費用と未観測費用を含む評価'},document_units:{totals:[pointer('/groups'),pointer('/change_vs_control_pct')],audience:[pointer('/by_group'),pointer('/by_kind')],accounting:[pointer('/overhead_accounting'),pointer('/prior_creation_allocation_reference'),pointer('/real_human_wait_ms'),pointer('/actual_billing_usd')]},assignment:'測定原資料から数値を再集計し、各比較の分母、単位、対象件数を明記してください。集計表と、確認できる効果・結論の限界を含む分析メモを作成してください。'},
  document:{title:'OrgBrain通常Claude作業の手順書',target:'project:reuse-operating-guide',units:{start:'設定と作業開始',choice:'既存成果・差分・全体の選び方',verify:'完了確認と測定上の注意'},document_units:{start:[{path:ordinary,heading:'作業開始'}],choice:[{path:ordinary,heading:'作業範囲の選択'}],verify:[{path:ordinary,heading:'記録と効果の確認'}]},assignment:'このプロジェクトの利用者が実行できる手順書を作成してください。操作、判断、完了の確認を分け、現在の設定場所と不足する測定を明示してください。'}
 };
 const retainedTopics={research:{evidence:['measured_effect']},analysis:{totals:['sample_size','denominator']},document:{start:['configuration_paths']}};
 return Object.fromEntries(Object.entries(definitions).map(([kind,d])=>['project-'+kind,{...d,kind,retained_fact_topics:retainedTopics[kind],source_mode:'project_files',source_refs:[],source_files:[...new Set(Object.values(d.document_units).flat().map(x=>x.path))],default_units:Object.keys(d.units),phrases:[d.title],valid_for_ms:7*86400000,allowed_principals:[],local_source_field:'source_sections',adapter:'project-'+kind,environment:{contract:'project-documents/v1'},dependency_files:['packages/orgbrain-cli/src/lib/memory-task-document-adapter.mjs','packages/orgbrain-cli/src/lib/memory-reuse-task-confirmation.mjs','packages/orgbrain-cli/src/lib/memory-reuse-bundled.mjs','packages/orgbrain-cli/src/lib/memory-task-transport.mjs','packages/orgbrain-cli/src/lib/memory-task-runtime-config.mjs','packages/orgbrain-cli/src/lib/memory-task-consistency.mjs','packages/orgbrain-cli/src/lib/memory-reuse.mjs','scripts/memory-reuse-claude.mjs'].map(p=>resolve(root,p))}]));
}
export async function installProjectWork({root,profiles=projectWorkProfiles(root),dry_run=true}){
 root=resolve(root);const path=join(root,'.local/memory-reuse/config.json'),settingsPath=join(root,'.claude/settings.local.json'),before=await readFile(path,'utf8'),original=JSON.parse(before),settingsRaw=await readFile(settingsPath,'utf8'),settings=JSON.parse(settingsRaw);
 if(original.observation_purpose==='test')throw Error('cannot_install_normal_work_in_test_configuration');
 for(const [id,w] of Object.entries(profiles)){
  if(original.task_workflows?.[id]&&original.task_profile_owner!==OWNER)throw Error('existing_workflow_owned_elsewhere');
  await runDocumentWork({root,workflow:w,workflow_id:id,input:{op:'read',units:w.default_units}});
 }
 const config={...original,task_confirmation_mode:'ask',task_local_mode:'on',task_observation_mode:'on',observation_purpose:'task',task_model:'claude-sonnet-5-5',task_effort:'medium',task_profile_owner:OWNER,task_workflows:{...original.task_workflows,...profiles},action_adapters:{...original.action_adapters}};
 const adapter=resolve(fileURLToPath(new URL('./memory-task-document-adapter.mjs',import.meta.url)));
 for(const [id,w] of Object.entries(profiles))config.action_adapters[w.adapter]={argv:[process.execPath,adapter,id],operations:['read','write'],object_type_key:'completed_work',object_id:id,task_workflow:id};
 const word=s=>/^[\w./:-]+$/u.test(s)?s:"'"+s.replaceAll("'","'\\''")+"'",helper=fileURLToPath(new URL('./memory-reuse-claude.mjs',import.meta.url)),prefix=[process.execPath,helper].map(word).join(' '),merged=mergeReuseHooks(settings,prefix,{bundled:config.tracking_mode==='bundled',taskConfirmation:true});
 const report={installed:!dry_run,scope:'project-local',profiles:Object.keys(profiles),model_starts:0,cloud_deploy:false};
 if(dry_run)return report;
 const backup=join(root,'.local/memory-reuse/install-backups',Date.now()+'-'+randomUUID());await mkdir(backup,{recursive:true,mode:0o700});await copyFile(path,join(backup,'config.json'));await copyFile(settingsPath,join(backup,'settings.local.json'));
 try{await writeFile(path,JSON.stringify(config,null,2)+'\n',{mode:0o600});await writeFile(settingsPath,JSON.stringify(merged,null,2)+'\n',{mode:0o600});}
 catch(e){await writeFile(path,before,{mode:0o600});await writeFile(settingsPath,settingsRaw,{mode:0o600});throw e;}
 return {...report,backup};
}
export function projectWorkRequest(config,kind,{prompt,units,observation_origin='organic'}={}){
 const found=Object.entries(config.task_workflows??{}).filter(([,w])=>w.kind===kind&&w.source_mode==='project_files');if(found.length!==1)throw Error('unknown_or_ambiguous_project_work');const [id,w]=found[0],selected=units??w.default_units;
 if(!selected?.length||new Set(selected).size!==selected.length||selected.some(u=>!Object.hasOwn(w.units,u)))throw Error('invalid_task_units');
 return {session_id:randomUUID(),observation_origin,prompt:(prompt??w.assignment??w.title)+'\n原資料にない事実を加えず、数値と出典、未観測の範囲を明記してください。\n<reuse_task>'+JSON.stringify({workflow:id,units:selected})+'</reuse_task>'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await installProjectWork({root:process.env.ORGBRAIN_REUSE_ROOT||process.cwd(),dry_run:!process.argv.includes('--execute')})));
