import {describe,it,expect} from 'vitest';
import {parseUtilityReview,utilityKey,validJudgment} from './memory-utility-review';
const fixture=()=>({contract:'memory-utility-review/v1',experiment_id:'utility-test',cases:Array.from({length:10},(_,i)=>({id:'c'+i,task:'タスク',answers:[1,2,3].map(j=>({id:'answer-'+j,text:'回答'}))}))});
describe('isolated utility review',()=>{
 it('accepts only blind fields and all ten cases',()=>{expect(parseUtilityReview(fixture()).cases).toHaveLength(10);expect(()=>parseUtilityReview({...fixture(),mapping:['A','B','C']})).toThrow();const value=fixture();Object.assign(value.cases[0],{score:4});expect(()=>parseUtilityReview(value)).toThrow();});
 it('uses a new per-experiment namespace',()=>{expect(utilityKey('a')).not.toBe(utilityKey('b'));expect(utilityKey('a')).toBe('orgbrain:memory-utility:v1:a');});
 it('requires explicit human confirmation',()=>{expect(validJudgment({choice:'equal'})).toBe(false);expect(validJudgment({choice:'hold',errors:{'answer-1':'','answer-2':'','answer-3':''},note:'',confirmed_at:'2026-01-01T00:00:00Z'})).toBe(true);});
});
