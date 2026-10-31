import {readFile} from 'node:fs/promises';
const request=JSON.parse(process.argv.at(-1)),{target,records}=request.input??{},source=request.source_files?.[0];
const bytes=await readFile(source),rule=JSON.parse(bytes.toString('utf8')).rules?.[target];
const body=rule?`Synthetic ${target} planning rules: ${JSON.stringify(rule)}. For records=N, partitions=ceil(N/batch_size). Always deduplicate.`:'';
const memory=request.memories?.[0];
const ok=Boolean(rule&&Number.isSafeInteger(records)&&records>0&&request.memories.length===1&&request.source_files.length===1&&memory.id==='synthetic-'+target&&memory.content===body&&memory.reuse_rule===`Only for ${target}.plan, using this source version.`);
console.log(JSON.stringify({ok,source_bytes_read:bytes.length}));
