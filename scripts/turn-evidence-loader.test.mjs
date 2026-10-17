import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadTurnEvidenceRows} from '../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs';

const context=(id,cwd='/workspace/project')=>({type:'turn_context',payload:{turn_id:id,cwd}});
const message=(role,text,phase)=>({type:'response_item',payload:{type:'message',role,phase,content:[{type:role==='user'?'input_text':'output_text',text}]}});
const complete=id=>({type:'event_msg',payload:{type:'task_complete',turn_id:id}});
async function read(rows,options={}){
  const root=await mkdtemp(join(tmpdir(),'orgbrain-turn-loader-'));
  try{
    const file=join(root,'turn.jsonl');
    await writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n'));
    return await loadTurnEvidenceRows({transcript_path:file,...options});
  }finally{await rm(root,{recursive:true,force:true});}
}
test('same-turn repeated contexts retain early human input, tools and the final without the next turn',async()=>{
  const early=message('user','Use API because retries are bounded. Except during recovery.');
  const tool={type:'response_item',payload:{type:'function_call_output',call_id:'check',output:'exit_code=0'}};
  const final=message('assistant','Checked the recovery boundary.','final_answer');
  const rows=await read([context('a'),early,context('a'),tool,final,complete('a'),context('b'),message('user','unrelated')],{turn_id:'a'});
  assert.ok(rows.some(r=>r.payload?.role==='user'));
  assert.ok(rows.some(r=>r.payload?.call_id==='check'));
  assert.ok(rows.some(r=>r.payload?.phase==='final_answer'));
  assert.equal(JSON.stringify(rows).includes('unrelated'),false);
});
test('completion-required reads reject an unfinished turn and accept its actual completion marker',async()=>{
  const rows=[context('a'),message('user','fix'),message('assistant','checked','final_answer')];
  assert.deepEqual(await read(rows,{turn_id:'a',require_completed:true}),[]);
  assert.ok((await read([...rows,complete('a')],{turn_id:'a',require_completed:true})).length>0);
  assert.deepEqual(await read([...rows,complete('other')],{turn_id:'a',require_completed:true}),[]);
});
test('does not merge equal IDs separated by another turn',async()=>{
  const rows=await read([context('a'),message('user','old segment'),context('b'),message('user','other'),context('a'),message('user','new segment')],{turn_id:'a'});
  assert.equal(JSON.stringify(rows).includes('old segment'),false);
  assert.equal(JSON.stringify(rows).includes('new segment'),true);
});
test('excludes instruction roles and internal reasoning but keeps evidence mentioning reasoning',async()=>{
  const rows=await read([context('a'),message('developer','hidden policy'),message('system','hidden system'),
    message('assistant','hidden chain','analysis'),{type:'response_item',payload:{type:'reasoning',text:'private'}},
    message('user','The "reasoning" setting is unavailable.'),message('assistant','ordinary progress','commentary'),
    message('assistant','done','final_answer')],{turn_id:'a'});
  assert.doesNotMatch(JSON.stringify(rows),/hidden policy|hidden system|hidden chain|"text":"private"/u);
  assert.ok(rows.some(r=>r.payload?.role==='user'));
});
test('rejects child/guardian session histories before returning evidence',async()=>{
  await assert.rejects(read([{type:'session_meta',payload:{source:{subagent:{other:'guardian'}}}},context('a'),message('user','x')]),/subagent_session/u);
});
test('excludes direct coordination calls and their child results',async()=>{
  const rows=await read([context('a'),message('user','x'),
    {type:'response_item',payload:{type:'function_call',name:'collaboration.spawn_agent',call_id:'child',arguments:'{}'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'child',output:'child history'}},
    message('assistant','done','final_answer')]);
  assert.doesNotMatch(JSON.stringify(rows),/child history|spawn_agent/u);
});
test('excludes named MCP chat reads, including standalone end events and paired results',async()=>{
  const rows=await read([context('a'),message('user','actual input'),
    {type:'event_msg',payload:{type:'mcp_tool_call_begin',call_id:'read',invocation:{tool:'mcp__codex_app__read_thread'}}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'read',output:'foreign paired body'}},
    {type:'event_msg',payload:{type:'mcp_tool_call_end',call_id:'standalone',invocation:{tool:'mcp__codex_app__read_thread'},result:'foreign end body'}},
    {type:'response_item',payload:{type:'mcp_tool_call',call_id:'direct',name:'mcp__codex_app__read_thread',arguments:'{}'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'direct',output:'foreign direct body'}},
    {type:'response_item',payload:{type:'mcp_tool_call',call_id:'server',server:'read_thread',arguments:'{}'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'server',output:'foreign fallback body'}},
    message('assistant','done','final_answer')]);
  assert.doesNotMatch(JSON.stringify(rows),/foreign|read_thread/u);
  assert.match(JSON.stringify(rows),/actual input/u);
});
test('same ID cannot silently cross workspace scope',async()=>{
  await assert.rejects(read([context('a','/workspace/one'),message('user','x'),context('a','/workspace/two'),message('user','y')]),/scope_mismatch/u);
});
test('the 8MiB limit applies to the logical turn across repeated contexts',async()=>{
  const rows=[];
  for(let i=0;i<9;i++)rows.push(context('a'),message('user','x'.repeat(1024*1024)));
  await assert.rejects(read(rows),/turn_too_large/u);
});
test('read diagnostics expose stage counts without message bodies',async()=>{
  let diagnostic;
  await read([context('a'),message('developer','private policy'),message('user','private user text'),context('a'),message('assistant','done','final_answer')],{turn_id:'a',on_diagnostic:value=>{diagnostic=value;}});
  assert.equal(diagnostic.turn_context_count,2);
  assert.equal(diagnostic.skipped.instructions,1);
  assert.doesNotMatch(JSON.stringify(diagnostic),/private policy|private user text/u);
});
test('an oversized unrelated historical turn does not block a requested bounded turn',async()=>{
  const rows=[];
  for(let i=0;i<9;i++)rows.push(context('old'),message('user','x'.repeat(1024*1024)));
  rows.push(context('wanted'),message('user','bounded input'),message('assistant','done','final_answer'));
  const selected=await read(rows,{turn_id:'wanted'});
  assert.equal(selected.filter(r=>r.payload?.role==='user').length,1);
  assert.match(JSON.stringify(selected),/bounded input/u);
});
