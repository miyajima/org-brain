import {afterEach,describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runGeneration} from './lib/openrouter-extraction-eval.mjs';
const roots=[];
afterEach(()=>{for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true});});
const setup=()=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'orgbrain-qwen-eval-'));roots.push(p);return p;};
const body=()=>({model:'qwen/qwen3-235b-a22b-2507',messages:[{role:'user',content:'Return an empty candidate list.'}],max_tokens:800,
 response_format:{type:'json_schema',json_schema:{name:'memory_extraction',strict:true,schema:{type:'object'}}},
 provider:{only:['DeepInfra'],allow_fallbacks:false,require_parameters:true,data_collection:'deny',zdr:true,max_price:{prompt:0.5,completion:2,request:0}}});
describe('isolated OpenRouter evaluation transport',()=>{
 it('never resends a call after a transport outcome becomes unknown',async()=>{
  const dir=setup();let calls=0;
  const args={directory:dir,callKey:'pair-a-before',body:body(),apiKey:'test-only',budgetUsd:1,fetchFn:async()=>{calls++;throw new Error('timeout');}};
  const first=await runGeneration(args);expect(first.status).toBe('transport_unknown');
  await expect(runGeneration(args)).rejects.toThrow('already_dispatched');expect(calls).toBe(1);
 });
 it('retains a result and usage without persisting the authorization header',async()=>{
  const dir=setup();
  const result=await runGeneration({directory:dir,callKey:'a',body:body(),apiKey:'test-only-value',budgetUsd:1,
   fetchFn:async()=>new Response(JSON.stringify({id:'gen-test',model:'qwen/qwen3-235b-a22b-2507',provider:'DeepInfra',choices:[{finish_reason:'stop',message:{content:'{"candidates":[]}'}}],usage:{prompt_tokens:40,completion_tokens:5,cost:0.0001}}),{status:200})});
  expect(result.status).toBe('response_received');expect(result.cost_usd).toBe(0.0001);
  const all=fs.readdirSync(dir).map(f=>fs.readFileSync(path.join(dir,f),'utf8')).join('');
  expect(all).not.toContain('test-only-value');expect(all).not.toContain('Authorization');
 });
 it('checks the reserved spend ceiling before sending another request',async()=>{
  const dir=setup();let called=false;
  await expect(runGeneration({directory:dir,callKey:'a',body:body(),apiKey:'test-only',budgetUsd:0.00001,fetchFn:async()=>{called=true;}})).rejects.toThrow('budget_ceiling');
  expect(called).toBe(false);
 });
 it('does not relax model or privacy requirements on a failure',async()=>{
  const dir=setup();const b=body();b.provider.zdr=false;
  await expect(runGeneration({directory:dir,callKey:'a',body:b,apiKey:'test-only',budgetUsd:1,fetchFn:async()=>{throw Error('must not send');}})).rejects.toThrow('privacy_contract');
 });
});
