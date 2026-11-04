import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const request=JSON.parse(process.argv.at(-1)),source=JSON.parse(await readFile('source.json','utf8')),task=JSON.parse(await readFile('case.json','utf8')),data=source[task.workflow],start=performance.now();let result;
if(request.op==='read'){
 const sections=Object.fromEntries(request.units.map(u=>[u,data.units[u]]));result={ok:true,source_sections:sections};
}else if(request.op==='write'){
 const errors=[];
 if(JSON.stringify(Object.keys(request.sections??{}).sort())!==JSON.stringify([...task.units].sort()))errors.push('units');
 for(const u of task.units){const text=request.sections?.[u]??'',d=data.units[u];const phrases=task.kind==='analysis'?[`revenue=${d.revenue}`,`cost=${d.cost}`,`profit=${d.revenue-d.cost}`]:d.facts;
  if(phrases.some(p=>!text.includes(p))||/\b(?:not|never|unknown|unverified)\b/iu.test(text))errors.push(u);
 }
 if(errors.length)result={ok:false,violated_units:errors};
 else{
  await mkdir('results',{recursive:true});const path=join('results',randomUUID()+'.md'),body='# '+data.title+'\n\n'+task.units.map(u=>'## '+data.labels[u]+'\n\n'+request.sections[u]).join('\n\n')+'\n';await writeFile(path,body);
  result={ok:true,artifact:{path,sha256:createHash('sha256').update(body).digest('hex'),sections:request.sections}};
 }
}else result={ok:false,error:'unsupported_task_operation'};
result.adapter_call_id=randomUUID();await appendFile('calls.jsonl',JSON.stringify({args:request,result,elapsed_ms:performance.now()-start})+'\n');console.log(JSON.stringify(result));
