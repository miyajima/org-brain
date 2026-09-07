export type UtilityAnswer = {id:string;text:string};
export type UtilityCase = {id:string;task:string;answers:UtilityAnswer[]};
export type UtilityReview = {contract:'memory-utility-review/v1';experiment_id:string;cases:UtilityCase[]};
export type HumanJudgment = {choice:string;errors:Record<string,string>;note:string;confirmed_at:string};
const record=(x:unknown):x is Record<string,unknown>=>Boolean(x)&&typeof x==='object'&&!Array.isArray(x);
function exact(x:Record<string,unknown>,keys:string[]) {return Object.keys(x).sort().join('|')===keys.sort().join('|');}
export function parseUtilityReview(raw:unknown):UtilityReview {
  if(!record(raw))throw Error('活用比較JSONを選んでください。');
  const {content_hash: _hash,...value}=raw;
  if(!exact(value,['contract','experiment_id','cases'])||value.contract!=='memory-utility-review/v1'||typeof value.experiment_id!=='string'||!value.experiment_id||!Array.isArray(value.cases)||value.cases.length!==10)throw Error('活用比較v1・10場面のJSONが必要です。');
  const ids=new Set();
  for(const c of value.cases){
    if(!record(c)||!exact(c,['id','task','answers'])||typeof c.id!=='string'||ids.has(c.id)||typeof c.task!=='string'||!Array.isArray(c.answers)||c.answers.length!==3)throw Error('場面データが不正です。');
    ids.add(c.id);
    for(const [i,a] of c.answers.entries())if(!record(a)||!exact(a,['id','text'])||a.id!=='answer-'+(i+1)||typeof a.text!=='string'||!a.text.trim())throw Error('ブラインド回答が不正です。');
  }
  return value as UtilityReview;
}
export function utilityKey(experimentId:string){return 'orgbrain:memory-utility:v1:'+experimentId;}
export function validJudgment(x:unknown):x is HumanJudgment {
  if(!record(x)||!exact(x,['choice','errors','note','confirmed_at'])||!['answer-1','answer-2','answer-3','equal','none','hold'].includes(String(x.choice))||!record(x.errors)||!exact(x.errors,['answer-1','answer-2','answer-3'])||Object.values(x.errors).some(v=>typeof v!=='string')||typeof x.note!=='string'||!Number.isFinite(Date.parse(String(x.confirmed_at))))return false;
  return true;
}
function stable(value:unknown):unknown {if(Array.isArray(value))return value.map(stable);if(record(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value;}
export async function utilityHash(value:unknown):Promise<string>{const bytes=new TextEncoder().encode(JSON.stringify(stable(value)));const digest=await crypto.subtle.digest('SHA-256',bytes);return 'sha256:'+Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');}
