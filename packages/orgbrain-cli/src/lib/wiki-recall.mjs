import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { recallTargets, targetSearchTerms, targetMatches, focusSettings, focusExcerpt } from "./wiki-recall-focus.mjs";

const normalize = text => text.normalize("NFKC").toLowerCase();
const clean = text => text.replace(/\]\(source:[^)]*\)/g, "]");
const has = (text, term) => {
  const normalized = normalize(clean(text));
  return /^\d+$/.test(term) ? new RegExp(`(^|[^a-z0-9])${term}($|[^a-z0-9])`).test(normalized) : normalized.includes(term);
};
const secret = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9_]{20,}|(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9._/+~-]{16,})/i;

function excerpt(text, terms, max) {
  const chars = [...text];
  if(chars.length <= max) return text;
  const normalized = normalize(text);
  const positions = terms.map(t=>normalized.indexOf(t)).filter(p=>p>=0);
  const position = positions.length ? [...normalized.slice(0,Math.min(...positions))].length : 0;
  const start = Math.max(0, position - Math.floor(max/4));
  return chars.slice(start,start+max).join("");
}

async function sessionEvidence(input, terms) {
  if(!input.workspace || !isAbsolute(input.workspace)) throw Error("session_workspace_required");
  if(!Array.isArray(input.session_files)||input.session_files.length>16) throw Error("invalid_session_files");
  const since=input.session_since ? Date.parse(input.session_since) : null;
  const until=input.session_until ? Date.parse(input.session_until) : null;
  if((since!==null&&!Number.isFinite(since))||(until!==null&&!Number.isFinite(until))||(since!==null&&until!==null&&since>=until)) throw Error("invalid_session_time_range");
  let bytes=0; const evidence=[];
  for(const file of input.session_files) {
    if(typeof file!=="string"||!isAbsolute(file)) throw Error("invalid_session_file");
    const stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16_000_000||(bytes+=stat.size)>64_000_000) throw Error("session_file_limit");
    const data=await readFile(file,"utf8");
    if(Buffer.byteLength(data)>16_000_000) throw Error("session_file_limit");
    const fileHash=createHash("sha256").update(data).digest("hex");
    const rows=data.split(/\r?\n/).map((line,i)=>line.trim()?{row:JSON.parse(line),line:i+1}:null).filter(Boolean);
    const meta=rows.find(r=>r.row.type==="session_meta")?.row.payload;
    if(meta?.cwd!==input.workspace||typeof meta?.id!=="string") throw Error("session_workspace_mismatch");
    for(const {row,line} of rows) {
      const p=row.payload;
      if(row.type!=="response_item"||p?.type!=="message"||!["user","assistant"].includes(p.role)||(p.role==="assistant"&&p.phase!=="final")) continue;
      const time=Date.parse(row.timestamp);
      if((since!==null||until!==null)&&(!Number.isFinite(time)||(since!==null&&time<since)||(until!==null&&time>=until))) continue;
      const text=typeof p.content==="string"?p.content:(p.content??[]).filter(c=>["text","input_text","output_text"].includes(c.type)).map(c=>c.text??"").join("\n");
      if(!terms.some(t=>has(text,t))||secret.test(text)) continue;
      const safe=text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g,"");
      evidence.push({kind:"session",id:`session:${meta.id}@${fileHash.slice(0,12)}#L${line}`,session_id:meta.id,start_line:line,end_line:line,timestamp:row.timestamp,role:p.role,
        file_hash:fileHash,verification_state:"recorded_message_not_execution_attestation",text:excerpt(safe,terms,3200)});
    }
  }
  return evidence;
}

export async function recallWiki(wiki,input) {
  if(typeof input.query!=="string"||!input.query.trim()||input.query.length>2000) throw Error("invalid_recall_query");
  const terms=[...new Set(normalize(input.query).trim().split(/\s+/))];
  if(terms.length>8) throw Error("invalid_recall_terms");
  if(input.session_files?.length&&!input.workspace) throw Error("session_workspace_required");
  const max=Math.max(128,Math.min(64000,Number(input.max_chars)||12000));
  const limit=Math.max(1,Math.min(20,Number(input.limit)||8));
  const contextMode=input.context_mode??"focused";
  if(!["focused","broad"].includes(contextMode)) throw Error("invalid_context_mode");
  const targets=recallTargets(input);
  const focus=focusSettings(input);
  const discovery=targets.length?targetSearchTerms(targets):terms;
  const filters=Object.fromEntries(["project_id","page_id","source_id","path_prefix","heading","since","until"].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));
  const candidates=new Map(); const stages=[]; let searchTruncated=false;
  for(const scope of targets.length?["sources"]:["wiki","sources"]) {
    let count=0;
    for(const term of discovery) {
      const result=await wiki.request({...filters,op:"search",query:term,scope,match_mode:"all",limit:100,per_owner_limit:8,max_chars:2400});
      searchTruncated ||= Boolean(result.truncated);
      for(const hit of result.hits??[]) {
        const key=`${hit.kind}:${hit.owner_id}:${hit.version??0}:${hit.chunk_id}`;
        const priority=targets.length&&/^\d{4}-\d{2}-\d{2}T/.test(term)?0:targets.some(t=>t.experiment_id===term)?1:2;
        candidates.set(key,{...hit,discovery_priority:Math.min(priority,candidates.get(key)?.discovery_priority??2)});count++;
      }
    }
    stages.push({stage:scope,candidate_hits:count});
  }
  const pool=[...candidates.values()];
  const weights=new Map(terms.map(t=>[t,Math.log(1+pool.length/(1+pool.filter(h=>has(`${h.title??""}\n${h.heading??""}\n${h.snippet}`,t)).length))]));
  const score=text=>terms.reduce((s,t)=>s+(has(text,t)?weights.get(t):0),0);
  pool.sort((a,b)=>(targets.length?a.discovery_priority-b.discovery_priority:0)||score(b.snippet)-score(a.snippet)||String(a.owner_id).localeCompare(String(b.owner_id)));
  const evidence=[]; const seen=new Set(); const reads=new Map();
  async function readSource(id,version,hit) {
    const key=`${id}@${version}`;
    if(reads.has(key)) return reads.get(key);
    let read=await wiki.request({op:"source_read",source_id:id,version,max_chars:4000});
    if(read.truncated&&read.name==="report-inventory.json") read=await wiki.request({op:"source_read",source_id:id,version,max_chars:64000});
    if(read.truncated) {
      const matching=terms.filter(t=>has(`${hit.heading??""}\n${hit.snippet}`,t));
      try {if(matching.length) read=await wiki.request({op:"source_read",source_id:id,version,query:matching.join(" "),match_mode:"any",context_lines:10,max_chars:3200});}
      catch(error) {if(error.message!=="query_not_found") throw error;}
    }
    reads.set(key,read);
    return read;
  }
  for(const hit of pool.filter(h=>h.kind==="source")) {
    const key=`${hit.owner_id}@${hit.version}`; if(seen.has(key)) continue; seen.add(key);
    if(seen.size>(targets.length?64:16)) {searchTruncated=true;break;}
    let read=await readSource(hit.owner_id,hit.version,hit);
    let manifest=null;
    if(!read.truncated&&read.text.trim().startsWith("{")) {
      try {const value=JSON.parse(read.text);if(value.schema==="wiki-report-preservation/v1"&&typeof value.original?.source_id==="string"&&Number.isInteger(value.original.version)&&value.original.version>0) manifest=value;}
      catch(error) {if(!(error instanceof SyntaxError)) throw error;}
    }
    const sourceId=manifest?.original.source_id??hit.owner_id;
    const version=manifest?.original.version??hit.version;
    if(targets.length&&manifest&&!targetMatches({timestamp:manifest.origin?.recorded_at},targets,{timeOnly:true}).length) continue;
    if(manifest) {
      read=await readSource(sourceId,version,hit);
      if(manifest.original.hash&&read.hash!==manifest.original.hash) throw Error("preserved_report_hash_mismatch");
    }
    const item={kind:manifest?"preserved_report":"source",id:`source:${sourceId}@${version}#L${read.start_line??1}-L${read.end_line??1}`,source_id:sourceId,version,
      inventory_source_id:manifest?hit.owner_id:undefined,inventory_version:manifest?hit.version:undefined,
      original:manifest?.original,origin:manifest?.origin,timestamp:manifest?.origin?.recorded_at??null,timestamp_basis:manifest?"reported_event_time":"unknown_event_time",verification_state:"reported_unverified",hash:read.hash,
      heading:hit.heading,text:read.text,start_line:read.start_line??1,end_line:read.end_line??1,truncated:Boolean(read.truncated)};
    if(targets.length) {
      item.target_indices=targetMatches(item,targets);
      if(!item.target_indices.length||!terms.some(t=>has(item.text,t))) continue;
    }
    evidence.push(item);
  }
  for(const hit of pool.filter(h=>h.kind==="page").slice(0,12)) evidence.push({kind:"wiki",id:`wiki:${hit.owner_id}#L${hit.start_line}-L${hit.end_line}`,page_id:hit.owner_id,heading:hit.heading,text:hit.snippet,start_line:hit.start_line,end_line:hit.end_line});
  const missing=terms.filter(t=>!evidence.some(e=>has(e.text,t)));
  const policy=input.session_policy??"missing_terms";
  if(!["missing_terms","always"].includes(policy)) throw Error("invalid_session_policy");
  let sessionAccessed=false;
  const absentTarget=targets.some((_,i)=>!evidence.some(e=>e.target_indices?.includes(i)));
  if(input.session_files?.length&&(missing.length||absentTarget||policy==="always")) {
    let sessions=await sessionEvidence(input,terms);
    if(targets.length) sessions=sessions.map(e=>({...e,target_indices:targetMatches(e,targets)})).filter(e=>e.target_indices.length);
    evidence.push(...sessions);sessionAccessed=true;
    stages.push({stage:"sessions",candidate_hits:sessions.length});
  }
  const fullOriginals=evidence.filter(e=>e.kind!=="wiki"&&terms.every(t=>has(e.text,t)));
  const focused=contextMode==="focused"&&fullOriginals.length>0;
  const ranked=focused?(targets.length?evidence.filter(e=>fullOriginals.includes(e)||e.target_indices.some(i=>!fullOriginals.some(f=>f.target_indices.includes(i)))):fullOriginals):evidence;
  ranked.sort((a,b)=>score(b.text)-score(a.text)||(a.kind==="preserved_report"?-1:0)-(b.kind==="preserved_report"?-1:0)||a.id.localeCompare(b.id));
  if(targets.length) {
    const first=targets.map((_,i)=>ranked.find(e=>e.target_indices?.includes(i))).filter(Boolean);
    ranked.splice(0,ranked.length,...new Set([...first,...ranked]));
  }
  let used=0; const selected=[]; const originals=new Map();
  for(const e of ranked) {
    const canonical=e.original?`${e.original.source_id}@${e.original.version}`:e.kind==="source"?`${e.source_id}@${e.version}`:null;
    const event=e.kind==="preserved_report"?JSON.stringify(e.origin):"source";
    if(canonical&&originals.has(canonical)&&(event==="source"||originals.get(canonical).has(event))) continue;
    const remaining=max-used; if(remaining<128||selected.length>=limit) break;
    const passage=focusExcerpt(e,terms,focus,has,remaining);
    if(e.kind==="session") {
      passage.start_line=e.start_line;passage.end_line=e.end_line;
      passage.excerpt_ranges=[{start_line:e.start_line,end_line:e.end_line}];
    }
    const text=passage.text;
    if(secret.test(text)) continue;
    const id=e.source_id?`source:${e.source_id}@${e.version}#L${passage.start_line}-L${passage.end_line}`:e.id;
    selected.push({...e,...passage,id});used += [...text].length;
    if(canonical) {if(!originals.has(canonical)) originals.set(canonical,new Set());originals.get(canonical).add(event);}
  }
  return {evidence:selected,stages,text_characters:used,query_terms:terms,missing_query_terms:terms.filter(t=>!selected.some(e=>has(e.text,t))),
    answer_completeness_verified:false,context_mode:contextMode,focused_on_full_match:focused,excerpt_mode:focus.mode,
    unmatched_targets:targets.flatMap((_,i)=>selected.some(e=>e.target_indices?.includes(i))?[]:[i]),
    target_coverage:targets.map((_,i)=>({index:i,missing_query_terms:terms.filter(t=>!selected.some(e=>e.target_indices?.includes(i)&&has(e.text,t)))})),
    session_accessed:sessionAccessed,session_policy:policy,writes_performed:false,truncated:searchTruncated||selected.length<evidence.length||selected.some(e=>e.truncated)};
}
