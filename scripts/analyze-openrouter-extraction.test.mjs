import {describe,it,expect} from 'vitest';
import {quotedUnitRetained,acceptedContent,rawContent,facetSentences,quotedCoverage,matchedRows} from './analyze-openrouter-extraction.mjs';
describe('quoted extraction evidence scoring',()=>{
 it('excludes an uncertain arm from both sides of the paired comparison',()=>{
  const good={arms:{before:{status:'valid_output'},after:{status:'valid_output'}}};
  expect(matchedRows([good,{arms:{before:{status:'valid_output'},after:{status:'transport_unknown'}}}])).toEqual([good]);
 });
 it('recognizes exact partitions but not a lost exception',()=>{
  expect(quotedUnitRetained('APIを使う。ただし本番では使わない。',['APIを使う。','ただし本番では使わない。'])).toBe(true);
  expect(quotedUnitRetained('APIを使う。ただし本番では使わない。',['APIを使う。'])).toBe(false);
 });
 it('scores a reason and exception separately without crediting a dropped exception',()=>{
  const units=facetSentences([{text:'キャッシュを使う。理由は同じ入力が繰り返されるため。\nただし本番では使わない。',source:'assistant',role:'assistant'}]);
  expect(units.map(u=>[u.facet,u.text])).toEqual([['reason','理由は同じ入力が繰り返されるため。'],['condition','ただし本番では使わない。']]);
  expect(quotedCoverage(units[1].text,['ただし本番'])).toBeGreaterThan(0);
  expect(quotedCoverage(units[1].text,['ただし本番'])).toBeLessThan(1);
  expect(quotedCoverage(units[1].text,['ただし本番では使わない。'])).toBe(1);
 });
 it('does not credit provenance, gaps, or controls as retained lesson content',()=>{
  const c={observation:{lesson_type:'success',procedure:'APIを使う。',evidence_selectors:[{ref:'ただし本番では使わない。'}],gaps:['ただし本番では使わない。']}};
  expect(quotedUnitRetained('ただし本番では使わない。',acceptedContent([c]))).toBe(false);
  expect(rawContent([{fields:[{name:'action',values:['create']},{name:'procedure',values:['APIを使う。']}]}])).toEqual(['APIを使う。']);
  expect(rawContent([{fields:[{name:'procedure',values:['','  ']}]}])).toEqual([]);
 });
});
