import test from 'node:test';
import assert from 'node:assert/strict';
test('a prior result import refuses a successful-looking record without native completion',async()=>{
 const {validatePrior}=await import('./memory-reuse-result-import.mjs');
 const value={outcome:{status:'observed',success:true,meaning_preserved:true,native_arguments_match:true,hook_errors:[]},invocation:{status:'completed',request:{input:{op:'apply',plan:{target:'rules'}}},output:{ok:true,exit_code:0,applied_plan:{target:'rules'}}},state:{target:'rules',records:25,expected:{target:'rules'}},native:[]};
 assert.throws(()=>validatePrior(value,{target:'rules',records:25}),/prior_native_completion_required/);
 value.invocation.native_call_id='fabricated';assert.throws(()=>validatePrior(value,{target:'rules',records:25}),/prior_native_completion_required/);
});
