import {readFile} from 'node:fs/promises';
const request=JSON.parse(process.argv.at(-1)),{target,records}=request.input??{},bytes=await readFile(request.source_files?.[0]);
const rule=JSON.parse(bytes.toString('utf8')).rules?.[target],memory=request.memories?.[0];
const sourceValid=rule&&['mode','region'].every(k=>typeof rule[k]==='string'&&rule[k].length>0)&&Number.isSafeInteger(rule.batch_size)&&rule.batch_size>0&&Number.isSafeInteger(rule.retain_days)&&rule.retain_days>=0&&Number.isSafeInteger(rule.version)&&rule.version>0;
const body=rule?`Synthetic ${target} planning rules: ${JSON.stringify(rule)}. For records=N, partitions=ceil(N/batch_size). Always deduplicate.`:'';
const ok=Boolean(sourceValid&&Number.isSafeInteger(records)&&records>0&&request.memories.length===1&&request.source_files.length===1&&memory.id==='synthetic-'+target&&memory.content===body&&memory.reuse_rule===`Only for ${target}.plan, using this source version.`);
const fields=['target','mode','batch_size','region','retain_days','deduplicate','partitions'];
console.log(JSON.stringify({ok,source_bytes_read:bytes.length,coverage:{kind:ok?'complete_source':'incomplete_source',fields:ok?fields:[]}}));
