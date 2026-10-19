import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {memoryExtractionProviderInputUpperBound} from '../../packages/shared/src/memory-extraction-provider-contract-runtime.mjs';

export const MODEL = 'qwen/qwen3-235b-a22b-2507';
export const MAX_CALLS = 201;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export function readCallLedger(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(f=>f.endsWith('.intent.json')).map(file=>{
    const intent=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
    const resultPath=path.join(directory,file.replace('.intent.json','.result.json'));
    const result=fs.existsSync(resultPath)?JSON.parse(fs.readFileSync(resultPath,'utf8')):null;
    return {intent,result};
  });
}

export async function runGeneration({directory,callKey,body,apiKey,budgetUsd=1,fetchFn=fetch,timeoutMs=60000}) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(callKey)) throw Error('invalid_call_key');
  const p=body.provider;
  if (body.model!==MODEL || body.models || body.max_tokens!==800) throw Error('model_contract');
  if (!p || p.zdr!==true || p.data_collection!=='deny' || p.allow_fallbacks!==false || p.require_parameters!==true || !Array.isArray(p.only) || p.only.length!==1) throw Error('privacy_contract');
  if (p.max_price?.prompt!==0.5 || p.max_price?.completion!==2 || p.max_price?.request!==0) throw Error('price_contract');
  if (body.response_format?.type!=='json_schema' || body.response_format.json_schema?.strict!==true || body.plugins || body.tools) throw Error('schema_contract');
  const prompt=body.messages.map(m=>m.content).join('\n');
  const upper=memoryExtractionProviderInputUpperBound(prompt);
  if (upper>2000) throw Error('input_ceiling');
  const reserve=(2000*0.5+800*2)/1e6;
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const ledger=readCallLedger(directory);
  if (ledger.some(x=>x.intent.call_key===callKey)) throw Error('already_dispatched_do_not_resend');
  const committed=ledger.reduce((n,x)=>n+(typeof x.result?.cost_usd==='number'?x.result.cost_usd:x.intent.reserved_usd),0);
  if (ledger.length>=MAX_CALLS || committed+reserve>Math.min(1,budgetUsd)) throw Error('budget_ceiling');
  const requestText=JSON.stringify(body);
  const prefix=path.join(directory,callKey);
  const started=Date.now();
  fs.writeFileSync(prefix+'.request.json',requestText,{mode:0o600,flag:'wx'});
  fs.writeFileSync(prefix+'.intent.json',JSON.stringify({call_key:callKey,request_sha256:sha(requestText),reserved_usd:reserve,input_upper_bound:upper,started_at:new Date(started).toISOString()}),{mode:0o600,flag:'wx'});
  let result;
  try {
    const response=await fetchFn('https://openrouter.ai/api/v1/chat/completions',{
      method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','X-OpenRouter-Title':'OrgBrain isolated extraction evaluation'},
      body:requestText,signal:AbortSignal.timeout(timeoutMs)
    });
    const text=await response.text();
    fs.writeFileSync(prefix+'.response.txt',text,{mode:0o600,flag:'wx'});
    let parsed=null;try{parsed=JSON.parse(text);}catch{}
    result={status:response.ok&&parsed&&!parsed.error?'response_received':'http_error',http_status:response.status,
      error_code:typeof parsed?.error?.code==='number'?parsed.error.code:null,
      response_sha256:sha(text),generation_id:parsed?.id??null,model:parsed?.model??null,provider:parsed?.provider??null,
      finish_reason:parsed?.choices?.[0]?.finish_reason??null,
      prompt_tokens:parsed?.usage?.prompt_tokens??null,completion_tokens:parsed?.usage?.completion_tokens??null,
      cached_tokens:parsed?.usage?.prompt_tokens_details?.cached_tokens??null,
      cost_usd:typeof parsed?.usage?.cost==='number'?parsed.usage.cost:null};
  } catch {
    // An uncertain external outcome is retained, never retried automatically.
    result={status:'transport_unknown',cost_usd:null};
  }
  result.elapsed_ms=Date.now()-started;
  fs.writeFileSync(prefix+'.result.json',JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});
  return result;
}
