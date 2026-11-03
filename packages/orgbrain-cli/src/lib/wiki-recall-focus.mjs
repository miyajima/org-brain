const DAY = 86_400_000;

function timestamp(value) {
  if(typeof value!=="string") throw Error("invalid_recall_target_time");
  const match=/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  const parsed=Date.parse(value);
  if(!match||!Number.isFinite(parsed)) throw Error("invalid_recall_target_time");
  const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));
  if(date.getUTCFullYear()!==Number(match[1])||date.getUTCMonth()+1!==Number(match[2])||date.getUTCDate()!==Number(match[3])) throw Error("invalid_recall_target_time");
  return parsed;
}

export function recallTargets(input) {
  if(input.targets===undefined) return [];
  if(!Array.isArray(input.targets)||input.targets.length<1||input.targets.length>8) throw Error("invalid_recall_targets");
  return input.targets.map(target=>{
    if(!target||typeof target!=="object"||Array.isArray(target)||Object.keys(target).some(k=>!["event_since","event_until","experiment_id"].includes(k))) throw Error("invalid_recall_target");
    const timed=target.event_since!==undefined||target.event_until!==undefined;
    const since=timed?timestamp(target.event_since):null;
    const until=timed?timestamp(target.event_until):null;
    if(timed&&(since>=until||until-since>31*DAY)) throw Error("invalid_recall_target_range");
    if(target.experiment_id!==undefined&&(typeof target.experiment_id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(target.experiment_id))) throw Error("invalid_recall_target_experiment");
    if(!timed&&!target.experiment_id) throw Error("invalid_recall_target");
    return {...target,since,until};
  });
}

export function targetSearchTerms(targets) {
  const seeds=new Set();
  for(const target of targets) {
    if(target.experiment_id) seeds.add(target.experiment_id);
    if(target.since!==null) {
      if(target.until-target.since<=5*60_000) {
        for(let minute=Math.floor(target.since/60_000);minute<=Math.floor((target.until-1)/60_000);minute++) seeds.add(new Date(minute*60_000).toISOString().slice(0,16));
      }
      // Stored RFC3339 offsets may place an event on an adjacent textual date.
      const first=Math.floor(target.since/DAY)-1;
      const last=Math.floor((target.until-1)/DAY)+1;
      for(let day=first;day<=last;day++) seeds.add(new Date(day*DAY).toISOString().slice(0,10));
    }
  }
  if(seeds.size>64) throw Error("invalid_recall_target_discovery_limit");
  return [...seeds];
}

export function targetMatches(evidence,targets,{timeOnly=false}={}) {
  const time=Date.parse(evidence.timestamp);
  const ids=new Set([...String(evidence.text??"").matchAll(/(?:^|[/(\s])artifacts\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\//g)].map(m=>m[1]));
  if(typeof evidence.origin?.experiment_id==="string") ids.add(evidence.origin.experiment_id);
  return targets.flatMap((target,index)=>{
    if(target.since!==null&&(!Number.isFinite(time)||time<target.since||time>=target.until)) return [];
    if(!timeOnly&&target.experiment_id&&!ids.has(target.experiment_id)) return [];
    return [index];
  });
}

export function focusSettings(input) {
  const mode=input.excerpt_mode??"passages";
  const chars=input.passage_chars??1800;
  const context=input.context_lines??2;
  if(!["passages","full"].includes(mode)) throw Error("invalid_excerpt_mode");
  if(!Number.isInteger(chars)||chars<128||chars>4000) throw Error("invalid_passage_chars");
  if(!Number.isInteger(context)||context<0||context>20) throw Error("invalid_context_lines");
  return {mode,chars,context};
}

export function focusExcerpt(evidence,terms,settings,has,max) {
  const cap=Math.min(settings.mode==="full"?4000:settings.chars,max);
  const lines=evidence.text.split("\n");
  const base=evidence.start_line??1;
  const chars=[...evidence.text];
  let ranges=[];
  if(settings.mode==="full"||chars.length<=cap) ranges=[[0,lines.length-1]];
  else {
    const blocks=[];
    for(let i=0;i<lines.length;i++) {
      if(!lines[i].trim()) continue;
      const first=i;
      while(i+1<lines.length&&lines[i+1].trim()) i++;
      const text=lines.slice(first,i+1).join("\n");
      blocks.push({first,last:i,score:terms.filter(t=>has(text,t)).length});
    }
    const ranked=blocks.filter(b=>b.score).sort((a,b)=>b.score-a.score||a.first-b.first).slice(0,3);
    for(const block of ranked) {
      const start=Math.max(0,block.first-settings.context);
      let end=Math.min(lines.length-1,block.last+settings.context);
      // Keep a whole adjacent paragraph of caveats, not only its first line.
      const next=blocks.find(b=>b.first>block.last);
      if(settings.context&&next&&/ただし|未確認|未検証|未実施|不明|条件|理由|限る|保留|訂正|however|unless/i.test(lines.slice(next.first,next.last+1).join("\n"))) end=Math.max(end,next.last);
      ranges.push([start,end]);
    }
    if(!ranges.length) ranges=[[0,lines.length-1]];
  }
  ranges.sort((a,b)=>a[0]-b[0]);
  const merged=[];
  for(const range of ranges) {
    const previous=merged.at(-1);
    if(previous&&range[0]<=previous[1]+1) previous[1]=Math.max(previous[1],range[1]);
    else merged.push([...range]);
  }
  const parts=[];let used=0;
  for(const [first,last] of merged) {
    const separator=parts.length?5:0;
    const remaining=cap-used-separator;
    if(remaining<32) break;
    const text=lines.slice(first,last+1).join("\n");
    const sequence=[...text];
    let offset=0;
    if(sequence.length>remaining&&settings.mode!=="full") {
      const normalized=text.normalize("NFKC").toLowerCase();
      const positions=terms.map(t=>normalized.indexOf(t)).filter(p=>p>=0);
      const position=positions.length?[...normalized.slice(0,Math.min(...positions))].length:0;
      offset=Math.max(0,position-Math.floor(remaining/4));
    }
    const selected=sequence.slice(offset,offset+remaining).join("");
    const start=first+sequence.slice(0,offset).filter(c=>c==="\n").length;
    const end=start+selected.split("\n").length-1;
    parts.push({text:selected,start_line:base+start,end_line:base+end});
    used += [...selected].length+separator;
  }
  const text=parts.map(p=>p.text).join("\n\n…\n\n");
  return {text,excerpt_ranges:parts.map(({start_line,end_line})=>({start_line,end_line})),
    start_line:parts[0]?.start_line??base,end_line:parts.at(-1)?.end_line??base,
    truncated:Boolean(evidence.truncated)||text!==evidence.text};
}
