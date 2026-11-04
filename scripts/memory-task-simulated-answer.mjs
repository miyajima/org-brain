// Evaluation only: this substitutes a synthetic participant's answer, never a model response.
import {readFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {taskQuestionMatches} from '../packages/orgbrain-cli/src/lib/memory-reuse-task-confirmation.mjs';
const root=process.env.ORGBRAIN_REUSE_ROOT;
const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>resolve(s));}));
let output={};
if(input.tool_name==='AskUserQuestion'){
 const deny=reason=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}});
 if(process.env.ORGBRAIN_TASK_EVAL_SIMULATION!=='1')output=deny('Synthetic answers are restricted to the explicit local evaluation.');
 else{
  const config=JSON.parse(await readFile(join(root,'.local/memory-reuse/config.json'),'utf8')),task=JSON.parse(await readFile(join(root,'case.json'),'utf8')),state=JSON.parse(await readFile(join(root,'.local/memory-reuse/task-confirmations',input.session_id+'.json'),'utf8'));
  const labels={existing:'既存成果で完了',delta:'差分だけ実施',full:'全体を実施'},answer=labels[task.choice];
  if(config.observation_purpose!=='test'||state.choice!=='pending'||!taskQuestionMatches(input.tool_input.questions,state.question)||!answer)output=deny('The simulated question does not match the predeclared scenario.');
  else{
   const answers={[state.question.question]:answer};await appendFile(join(root,'simulated-answers.jsonl'),JSON.stringify({tool_use_id:input.tool_use_id,question:state.question,answer,provenance:'synthetic_participant',human_wait_ms:0})+'\n');
   output={hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{questions:input.tool_input.questions,answers}}};
  }
 }
}
console.log(JSON.stringify(output));
