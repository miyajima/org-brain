import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const execute=promisify(execFile);
const PAGE_CHARS = 16000;
const MAX_PAGES = 256;
const MAX_SOURCE_CHARS = PAGE_CHARS * MAX_PAGES;
// A source receipt verifies immutable bytes and provenance, never historical execution.
export async function resolveWikiSourceEvidence(ref, digest=null, {configPath=join(homedir(),'.config/org-brain/wiki-integration.json'), run=execute}={}) {
  const parsed=/^source:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})@(\d+)(?:#L(\d+)-L(\d+))?$/iu.exec(ref);
  if(!parsed || Number(parsed[2])<1) return {ok:false,reason:'wiki_source_ref_invalid'};
  try {
    const config=JSON.parse(await readFile(configPath,'utf8'));
    if(config.enabled!==true||config.wiki_id!=='personal'||!Array.isArray(config.wiki_command)||!config.wiki_command.length) return {ok:false,reason:'wiki_source_unavailable'};
    const chunks = [];
    let cursor = 0, sourceHash = null, complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const {stdout}=await run(config.wiki_command[0],[...config.wiki_command.slice(1),'source-read','--source-id',parsed[1],'--version',parsed[2],'--max-chars',String(PAGE_CHARS),'--char-offset',String(cursor),'--wiki-id','personal'],{encoding:'utf8',timeout:10000,maxBuffer:131072});
      const source=JSON.parse(stdout);
      if(source.source_id!==parsed[1]||source.version!==Number(parsed[2])||typeof source.text!=='string') return {ok:false,reason:'wiki_source_incomplete'};
      if(typeof source.hash!=='string'||!/^[a-f0-9]{64}$/u.test(source.hash)||(sourceHash!==null&&source.hash!==sourceHash)) return {ok:false,reason:'wiki_source_digest_mismatch'};
      sourceHash = source.hash;
      // The native Wiki uses Unicode character offsets, not UTF-16 code units.
      const length = Array.from(source.text).length;
      if(length>PAGE_CHARS||cursor+length>MAX_SOURCE_CHARS) return {ok:false,reason:'wiki_source_incomplete'};
      chunks.push(source.text);
      const next = source.next_char_offset;
      if(!source.truncated&&next==null) { complete=true; break; }
      if(source.truncated!==true||!Number.isSafeInteger(next)||length===0||next!==cursor+length) return {ok:false,reason:'wiki_source_incomplete'};
      cursor = next;
    }
    if(!complete) return {ok:false,reason:'wiki_source_incomplete'};
    const text = chunks.join('');
    const hash=createHash('sha256').update(text).digest('hex');
    if(sourceHash!==hash || (digest&&digest.replace(/^sha256:/,'')!==hash)) return {ok:false,reason:'wiki_source_digest_mismatch'};
    if(parsed[3]&&(Number(parsed[3])<1||Number(parsed[4])<Number(parsed[3])||Number(parsed[4])>text.split('\n').length)) return {ok:false,reason:'wiki_source_range_invalid'};
    return {ok:true,evidence:{type:'doc',ref,content_hash:hash,observed_at:Date.now(),attestation_ref:'wiki:personal:immutable-source',verification_scope:'source_provenance'}};
  } catch {return {ok:false,reason:'wiki_source_unavailable'};}
}
