import {readFile,realpath,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {reuseContentAllowed} from './memory-reuse.mjs';

const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
async function original(root,name){
 if(typeof name!=='string'||name.startsWith('/')||name.split('/').includes('..'))throw Error('source_outside_project');
 const base=await realpath(root),path=await realpath(resolve(root,name));if(!path.startsWith(base+'/'))throw Error('source_outside_project');
 const bytes=await readFile(path);if(bytes.length>65536||!Buffer.from(bytes.toString('utf8')).equals(bytes)||!reuseContentAllowed(bytes.toString('utf8')))throw Error('unsafe_document_source');
 return bytes.toString('utf8');
}
function selection(text,descriptor){
 if(descriptor.heading){
  const lines=text.split('\n'),matches=[];
  for(let i=0;i<lines.length;i++){const m=lines[i].match(/^(#{1,6}) (.+?)\s*$/u);if(m?.[2]===descriptor.heading)matches.push([i,m[1].length]);}
  if(matches.length!==1)throw Error('document_section_not_found_or_ambiguous');
  const [start,level]=matches[0];let end=lines.length;
  for(let i=start+1;i<lines.length;i++){const m=lines[i].match(/^(#{1,6}) /u);if(m&&m[1].length<=level){end=i;break;}}
  return lines.slice(start,end).join('\n');
 }
 if(descriptor.pointer!==undefined){
  if(typeof descriptor.pointer!=='string'||descriptor.pointer!==''&&!descriptor.pointer.startsWith('/'))throw Error('invalid_document_pointer');
  let value=JSON.parse(text);for(const key of descriptor.pointer===''?[]:descriptor.pointer.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'))){if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))throw Error('document_pointer_missing');value=value[key];}
  return JSON.stringify(value,null,2);
 }
 return text;
}
export async function runDocumentWork({root,workflow:w,workflow_id,input:x}){
 if(!/^[\w-]{1,100}$/u.test(workflow_id)||w.source_mode!=='project_files'||!Array.isArray(x?.units)||!x.units.length||new Set(x.units).size!==x.units.length||x.units.some(u=>!Object.hasOwn(w.units,u)))throw Error('invalid_document_work');
 if(x.op==='read'){
  const source_sections={};for(const u of x.units){const descriptors=w.document_units?.[u];if(!Array.isArray(descriptors)||!descriptors.length)throw Error('unconfigured_document_unit');
   const parts=[];for(const d of descriptors){if(!w.source_files.includes(d.path))throw Error('unconfigured_document_source');parts.push('Source: '+d.path+(d.heading?' # '+d.heading:d.pointer??'')+'\n'+selection(await original(root,d.path),d));}source_sections[u]=parts.join('\n\n');
  }
  if(Buffer.byteLength(JSON.stringify(source_sections))>60000)throw Error('document_source_too_large');return {ok:true,source_sections};
 }
 if(x.op!=='write'||!x.sections||!same(Object.keys(x.sections),x.units)||Object.values(x.sections).some(v=>typeof v!=='string'||!v.trim())||!reuseContentAllowed(x.sections))throw Error('invalid_document_output');
 const body='# '+w.title+'\n\n'+x.units.map(u=>'## '+w.units[u]+'\n\n'+x.sections[u]).join('\n\n')+'\n';if(Buffer.byteLength(body)>65536)throw Error('document_output_too_large');
 const directory=join(root,'.local/memory-reuse/work-results',workflow_id);await mkdir(directory,{recursive:true,mode:0o700});
 // Check the real result directory as well as every input, including symlinks.
 const base=await realpath(root),actual=await realpath(directory);if(!actual.startsWith(base+'/'))throw Error('output_outside_project');
 const path='.local/memory-reuse/work-results/'+workflow_id+'/'+randomUUID()+'.md';await writeFile(join(root,path),body,{mode:0o600,flag:'wx'});
 return {ok:true,artifact:{path,sha256:createHash('sha256').update(body).digest('hex'),sections:x.sections}};
}
