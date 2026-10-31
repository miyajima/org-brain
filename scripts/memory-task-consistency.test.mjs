import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRetainedContext,checkJoinedConsistency} from '../packages/orgbrain-cli/src/lib/memory-task-consistency.mjs';

const prior={id:'real-result',content_digest:'original-digest',sections:{start:'設定は `.local/memory-reuse/config.json`、フックは `.claude/settings.local.json`。別案件には適用しない。',totals:'各群 n=10 タスク。分母は control の合計153,274トークン、114,237ms、0.1690 USD。',evidence:'10組すべてで改善し、total_tokens の変化は-36.58%、total_ms は-34.81%。各条件 n=1 の canary は一般化できない。',hidden:'Not requested and must not be delivered.'}};
const topics={start:['configuration_paths'],totals:['sample_size','denominator'],evidence:['measured_effect']};
const make=()=>buildRetainedContext({prior,requested_units:['start','totals','evidence','new'],allowed_units:['new'],topics,max_chars:1800});

test('source-scoped absence does not deny the facts retained in the joined document',()=>{
 for(const text of ['この出典には分母(n)の記載がない。保持済みの全体集計(各群 n=10)とは区別する。','差分資料には設定場所の記載がない。','本ソースには対象件数の記載がない。','この出典には時間の削減効果の記載がない。']){
  assert.equal(checkJoinedConsistency({retained:make(),sections:{...prior.sections,new:text},added_units:['new']}).status,'passed',text);
 }
});
test('a source qualifier cannot hide a global unknown claim or a conflicting count',()=>{
 for(const text of ['この出典には分母(n)の記載がなく不明。','この出典には分母の記載がないため再集計できない。','この出典には分母の記載がない。分母は不明。','この出典には対象件数の記載がない。各群 n=12 で比較した。','設定ファイルの場所は出典に記載がなく不明。']){
  assert.equal(checkJoinedConsistency({retained:make(),sections:{...prior.sections,new:text},added_units:['new']}).status,'contradiction',text);
 }
});
test('a source item can omit its count without denying the retained count',()=>{
 for(const text of ['この項目には件数の記載がなく、変化率の分母が前段の control(n=10)と同一かは、この出典だけでは確認できません。','この項目には件数の記載がなく、前段の全体集計は各群 n=10 です。']){
  assert.equal(checkJoinedConsistency({retained:make(),sections:{...prior.sections,new:text},added_units:['new']}).status,'passed',text);
 }
 for(const text of ['この項目には件数の記載がなく不明。','この項目には件数の記載がなく、対象件数は不明。','この項目には件数の記載がなく、各群 n=12 です。']){
  assert.equal(checkJoinedConsistency({retained:make(),sections:{...prior.sections,new:text},added_units:['new']}).status,'contradiction',text);
 }
});

test('retained facts are bounded exact source spans with original identity',()=>{
 const c=make();assert.equal(c.prior_id,prior.id);assert.equal(c.prior_content_digest,prior.content_digest);assert.ok(c.snippets.length>0);assert.ok(c.character_count<=1800);
 for(const s of c.snippets){assert.equal(s.text,prior.sections[s.unit].slice(s.start,s.end));assert.notEqual(s.unit,'hidden');}
 assert.deepEqual(new Set(c.snippets.flatMap(x=>x.topics)),new Set(['configuration_paths','sample_size','denominator','measured_effect']));
});
test('known fact denials from the earlier actual failures are rejected',()=>{
 for(const text of ['設定ファイルの具体的な場所はこの資料に記載がなく不明。','設定ファイルの場所は出典に記載がなく不明。','分母は対照側で、件数は元データに記載がない。','対照側の絶対値(分母)は本ソースに無く、再集計できない。','時間や費用の削減効果は未検証である。']){
  const x=checkJoinedConsistency({retained:make(),sections:{...prior.sections,new:text},added_units:['new']});assert.equal(x.status,'contradiction',text);assert.ok(x.issues.length>0);
 }
});
test('measured facts do not turn unknown human, billing or general effects into known facts',()=>{
 for(const text of ['設定場所は保持済みの節を参照する。人の確認時間は未観測。','人の確認を含む時間削減は未検証である。実請求額も不明。','実チームでの削減効果は未検証。各条件n=1では一般化できない。','差分資料には設定場所の再掲はない。保持済みの開始節を参照する。','分母は保持済みの集計節を参照する。サンプル数は各群 n=10。']){
  const x=checkJoinedConsistency({retained:make(),sections:{...prior.sections,new:text},added_units:['new']});assert.equal(x.status,'passed',text);
 }
});
test('explicit total sample-size drift is rejected without rejecting subgroup counts',()=>{
 assert.equal(checkJoinedConsistency({retained:make(),sections:{new:'各群 n=12 タスクで比較した。'},added_units:['new']}).status,'contradiction');
 assert.equal(checkJoinedConsistency({retained:make(),sections:{new:'個人とチームは各群 n=5 である。全体は各群 n=10。'},added_units:['new']}).status,'passed');
});
test('Japanese task counts carry the same retained fact without requiring n-equals notation',()=>{
 const p={...prior,sections:{totals:'各群10タスクの比較。分母は対照の153274トークン。'}};
 const retained=buildRetainedContext({prior:p,requested_units:['totals','new'],allowed_units:['new'],topics:{totals:['sample_size','denominator']},max_chars:1200});
 assert.ok(retained.snippets.some(s=>s.topics.includes('sample_size')));
 for(const text of ['対象件数は不明。','各群12タスクで比較した。'])assert.equal(checkJoinedConsistency({retained,sections:{totals:p.sections.totals,new:text},added_units:['new']}).status,'contradiction');
});
test('an unknown human or billing clause cannot negate a known configuration or sample count',()=>{
 for(const text of ['設定ファイルの場所は .local/memory-reuse/config.json にあり、実請求額は不明。','各群 n=10 の分母は保持済みの値であり、人による採用件数は不明。','後から不足が判明して再開した件数は不明。','The configuration location is documented; actual billing is unknown.']){
  assert.equal(checkJoinedConsistency({retained:make(),sections:{...prior.sections,new:text},added_units:['new']}).status,'passed',text);
 }
});
test('long evidence is omitted explicitly instead of cutting a condition in half',()=>{
 const p={...prior,sections:{start:'設定は '+'.local/config.json と条件 '.repeat(100)+'すべてが一致する場合だけ。'}};
 const c=buildRetainedContext({prior:p,requested_units:['start','new'],allowed_units:['new'],topics:{start:['configuration_paths']},max_chars:80});assert.equal(c.snippets.length,0);assert.deepEqual(c.omitted_units,['start']);
 assert.deepEqual(c.uncovered_topics,[{unit:'start',topic:'configuration_paths'}]);
});
test('uncovered topics are not claimed checked and retained facts cannot expand edit scope',()=>{
 const c=buildRetainedContext({prior,requested_units:['start','new'],allowed_units:['new'],topics:{start:['configuration_paths']},max_chars:1800});
 assert.equal(checkJoinedConsistency({retained:c,sections:{new:'人の採用率は不明。'},added_units:['new']}).status,'passed');
 assert.throws(()=>checkJoinedConsistency({retained:c,sections:{new:'text'},added_units:['start','new']}),/retained_unit_cannot_be_edited/);
});
