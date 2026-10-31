// Exact prior-result excerpts, not new inferred facts or a general semantic judge.
const TOPICS=new Set(['configuration_paths','sample_size','denominator','measured_effect']);
const unknown=/(?:不明|未(?:検証|確認|記載)|記載.{0,8}(?:ない|なく)|(?:ソース|資料).{0,8}に無[いく]|unknown|not (?:provided|available|stated))/iu;
const scopedUnknown=/(?:人(?:を含|の確認|間)|実請求|請求額|一般化|実運用|実チーム|統計|長期|human|billing|invoice|generaliz)/iu;
const resolution=/(?:保持|既存)(?:済み)?(?:の)?(?:節|部分|記載|成果).{0,32}(?:参照|にある|に記載されている|で確認でき)/u;
// A complete source-only absence statement does not deny the retained fact.
// Anchoring prevents appended conclusions such as "therefore unknown" escaping.
const sourceAbsence=/^\s*(?:(?:この|本|当該)(?:出典|資料|ソース|項目)|(?:差分|追加)資料)には?(?:分母(?:[（(]n[)）])?|対象件数|サンプル数|件数|設定(?:ファイルの|の)?場所|(?:時間|費用|トークン|API)の削減効果)の記載がな(?:い|く)[。]?\s*$/u;
function sentences(text){return [...text.matchAll(/[^。！？\n]+[。！？]?/gu)].map(m=>({start:m.index,end:m.index+m[0].length,text:m[0]}));}
function sampleValues(text){return [...text.matchAll(/(?:\bn\s*[=＝]\s*|各群\s*|対象件数\s*[=:：]?\s*)(\d+)\s*(?:件|タスク|回)?/giu)].map(m=>m[1]);}
function hasTopic(text,topic){
 if(topic==='configuration_paths')return /[.\w/-]*(?:config|settings)[.\w-]*\.(?:json|ya?ml|toml)/iu.test(text)&&text.includes('/');
 if(topic==='sample_size')return sampleValues(text).length>0;
 if(topic==='denominator')return /(?:control|対照|分母)/iu.test(text)&&/\d/u.test(text);
 return /(?:改善|削減|変化|total_tokens|total_ms).*[\d.]+\s*[%％]|\d+(?:組|件).{0,12}(?:すべて|全て).*(?:改善|減)/iu.test(text);
}
export function buildRetainedContext({prior,requested_units,allowed_units,topics={},max_chars=1200}){
 if(!Number.isInteger(max_chars)||max_chars<80||max_chars>6000)throw Error('invalid_retained_fact_budget');
 const retained_units=requested_units.filter(u=>!allowed_units.includes(u)),candidates=[];
 for(const unit of retained_units){
  const text=prior.sections[unit];if(typeof text!=='string')throw Error('missing_retained_section');
  const spans=sentences(text),rules=topics[unit]??[];if(!Array.isArray(rules)||rules.some(t=>!TOPICS.has(t)))throw Error('unknown_retained_fact_topic');
  for(const span of spans){const matched=rules.filter(t=>hasTopic(span.text,t));if(matched.length)candidates.push({unit,...span,topics:matched});}
 }
 // First provide topic-bearing complete sentences, then a short source pointer per remaining unit.
 const snippets=[];let character_count=0;
 for(const item of candidates){
  if(character_count+item.text.length>max_chars||snippets.filter(s=>s.unit===item.unit).length>=4)continue;
  snippets.push(item);character_count+=item.text.length;
 }
 for(const unit of retained_units){
  if(snippets.some(s=>s.unit===unit))continue;
  const span=sentences(prior.sections[unit])[0];if(span&&character_count+span.text.length<=max_chars){snippets.push({unit,...span,topics:[]});character_count+=span.text.length;}
 }
 const uncovered_topics=retained_units.flatMap(unit=>(topics[unit]??[]).filter(topic=>!snippets.some(s=>s.unit===unit&&s.topics.includes(topic))).map(topic=>({unit,topic})));
 return {version:'retained-excerpts/v1',prior_id:prior.id,prior_content_digest:prior.content_digest,retained_units,snippets,character_count,omitted_units:retained_units.filter(u=>!snippets.some(s=>s.unit===u)),uncovered_topics,meaning:'Exact excerpts from the accepted prior result. They provide retained context, not independently verified truth. Missing excerpts do not mean a fact is unknown.'};
}
export function checkJoinedConsistency({retained,sections,added_units}){
 if(added_units.some(u=>retained.retained_units.includes(u)))throw Error('retained_unit_cannot_be_edited');
 const checked_topics=[...new Set(retained.snippets.flatMap(s=>s.topics))],issues=[];
 for(const unit of added_units){
  const text=sections[unit];if(typeof text!=='string')throw Error('missing_added_section');
  const spans=sentences(text);
  for(const [index,span] of spans.entries()){
   const sentence=span.text,near=sentence+(spans[index+1]?.text??'');
   for(const clause of sentence.split(/[、，；;]|,(?!\d)/u))if(unknown.test(clause)&&!sourceAbsence.test(clause)&&!resolution.test(near)&&!/(?:不明|未検証).{0,12}(?:ではない|としない|と書かない)/u.test(clause)){
    for(const topic of checked_topics){
     let contradicts=false;
     if(topic==='configuration_paths')contradicts=/(?:設定(?:ファイル)?(?:の具体的な|の)?(?:場所|保存先|パス)|configuration.{0,10}(?:path|location))/iu.test(clause);
     if(topic==='sample_size')contradicts=/(?:対象件数|件数|サンプル数|sample size)/iu.test(clause)&&!/(?:採用|導入|再開|省略|人(?:の|間)|実際)/u.test(clause);
     if(topic==='denominator')contradicts=/(?:対照側の絶対値|分母|control.{0,12}(?:value|total)|denominator)/iu.test(clause)&&!scopedUnknown.test(clause);
     if(topic==='measured_effect')contradicts=/(?:時間|費用|トークン|API|cost|time).{0,18}(?:削減|効果|saving)|削減効果/iu.test(clause)&&!scopedUnknown.test(clause);
     if(contradicts)issues.push({unit,topic,kind:'known_fact_denied',statement:clause.trim()});
    }
   }
   if(checked_topics.includes('sample_size')&&!/(?:personal|team|個人|チーム|種別)/iu.test(sentence)){
    const expected=new Set(retained.snippets.filter(s=>s.topics.includes('sample_size')).flatMap(s=>sampleValues(s.text)));
    if(/(?:各群|全体|総数|対象件数)/u.test(sentence))for(const value of sampleValues(sentence))if(expected.size===1&&!expected.has(value))issues.push({unit,topic:'sample_size',kind:'explicit_value_conflict',statement:sentence.trim()});
   }
  }
 }
 return {version:'known-fact-consistency/v3',status:issues.length?'contradiction':checked_topics.length?'passed':'not_applicable',checked_topics,issues,coverage:'Known fact denials and explicit overall sample-size conflicts only. Source-only absence is not a global denial. Full semantic quality still needs review.'};
}
