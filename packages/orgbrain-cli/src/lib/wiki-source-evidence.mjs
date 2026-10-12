import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const execute=promisify(execFile);
// A source receipt verifies immutable bytes and provenance, never historical execution.
export async function resolveWikiSourceEvidence(ref, digest=null, {configPath=join(homedir(),'.config/org-brain/wiki-integration.json'), run=execute}={}) {
  const parsed=/^source:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})@(\d+)(?:#L(\d+)-L(\d+))?$/iu.exec(ref);
  if(!parsed || Number(parsed[2])<1) return {ok:false,reason:'wiki_source_ref_invalid'};
  try {
    const config=JSON.parse(await readFile(configPath,'utf8'));
    if(config.enabled!==true||config.wiki_id!=='personal'||!Array.isArray(config.wiki_command)||!config.wiki_command.length) return {ok:false,reason:'wiki_source_unavailable'};
    const {stdout}=await run(config.wiki_command[0],[...config.wiki_command.slice(1),'source-read','--source-id',parsed[1],'--version',parsed[2],'--max-chars','16000','--wiki-id','personal'],{encoding:'utf8',timeout:10000,maxBuffer:131072});
    const source=JSON.parse(stdout);
    if(source.source_id!==parsed[1]||source.version!==Number(parsed[2])||source.truncated||source.next_char_offset!=null||typeof source.text!=='string') return {ok:false,reason:'wiki_source_incomplete'};
    const hash=createHash('sha256').update(source.text).digest('hex');
    if(source.hash!==hash || (digest&&digest.replace(/^sha256:/,'')!==hash)) return {ok:false,reason:'wiki_source_digest_mismatch'};
    if(parsed[3]&&(Number(parsed[3])<1||Number(parsed[4])<Number(parsed[3])||Number(parsed[4])>source.text.split('\n').length)) return {ok:false,reason:'wiki_source_range_invalid'};
    return {ok:true,evidence:{type:'doc',ref,content_hash:hash,observed_at:Date.now(),attestation_ref:'wiki:personal:immutable-source',verification_scope:'source_provenance'}};
  } catch {return {ok:false,reason:'wiki_source_unavailable'};}
}
