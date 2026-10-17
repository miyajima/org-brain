// Exact local text tokenization with o200k_base, not provider usage/billing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const name=process.argv[2];
if(!/^implementation-v\d+$/.test(name??''))throw new Error('supply the preserved run name');
const workspace=path.resolve(new URL('../..',import.meta.url).pathname);
const root=path.join(os.homedir(),'.org-brain/evaluations/extraction-coverage-20261017',name);
const summary=JSON.parse(fs.readFileSync(path.join(root,'summary.json'),'utf8'));
const req=createRequire(path.join(workspace,'packages/shared/package.json'));
const {Tiktoken}=req('js-tiktoken/lite');
const ranks=req('js-tiktoken/ranks/o200k_base');
const tokenizer=new Tiktoken(ranks.default??ranks);
const cases=[];
for(const c of summary.cases){
  const provider=await import(pathToFileURL(path.join(root,c.variant,'packages/shared/src/memory-extraction-provider-contract-runtime.mjs')).href);
  const saved=JSON.parse(fs.readFileSync(path.join(root,c.variant,`${c.case_id}-${c.profile}.json`),'utf8'));
  const request=saved.request;
  const count=request?{prompt_tokens:tokenizer.encode(provider.buildMemoryExtractionPrompt(request)).length,
    schema_tokens:tokenizer.encode(JSON.stringify(provider.MEMORY_EXTRACTION_OUTPUT_SCHEMA)).length,
    tool_name_tokens:tokenizer.encode('orgbrain_memory_extraction').length,envelope_reserve_tokens:256}:null;
  if(count)count.local_estimated_input_tokens=Object.values(count).reduce((n,v)=>n+v,0);
  cases.push({variant:c.variant,profile:c.profile,case_id:c.case_id,reference_count:count});
}
const aggregate=summary.aggregate.map(row=>{
  const values=cases.filter(c=>c.variant===row.variant&&c.profile===row.profile&&c.reference_count).map(c=>c.reference_count.local_estimated_input_tokens);
  return {variant:row.variant,profile:row.profile,requests_counted:values.length,
    reference_input_tokens_min:values.length?Math.min(...values):null,reference_input_tokens_max:values.length?Math.max(...values):null,
    reference_input_tokens_mean:values.length?values.reduce((n,v)=>n+v,0)/values.length:null};
});
const loader=[];
const turn=await import(pathToFileURL(path.join(root,'after-2000/packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs')).href);
for(const c of summary.cases.filter(c=>c.variant==='after-2000'&&c.profile==='legacy')){
  let diagnostic;
  await turn.loadTurnEvidenceRows({transcript_path:path.join(root,'inputs',`${c.case_id}.jsonl`),on_diagnostic:value=>{diagnostic=value;}});
  loader.push({case_id:c.case_id,diagnostic});
}
const output={schema:'memory-extraction-local-token-diagnostic/v1',run:name,encoding:'o200k_base',
  tokenizer_version:JSON.parse(fs.readFileSync(path.join(workspace,'packages/shared/node_modules/js-tiktoken/package.json'),'utf8')).version,
  ranks_sha256:crypto.createHash('sha256').update(fs.readFileSync(req.resolve('js-tiktoken/ranks/o200k_base'))).digest('hex'),
  meaning:'Exact local counts of prompt/schema/name plus a 256-token reserve; not verified model tokenization, API usage, or fees',
  provider_calls:0,aggregate,cases,loader};
for(const file of [path.join(root,'local-token-diagnostic.json'),path.join(workspace,'artifacts/hy-memory-evaluation-20261017',`${name}-local-token-diagnostic.json`)]){
  fs.writeFileSync(file,JSON.stringify(output,null,2),{mode:0o600});
}
console.log(JSON.stringify({aggregate,coordination_rows_excluded:loader.reduce((n,c)=>n+(c.diagnostic.skipped.coordination??0),0)}));
