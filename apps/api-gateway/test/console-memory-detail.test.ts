import {describe,expect,it} from "vitest";
import {getMemoryDetails} from "../src/memory-service";
import type {Env} from "../src/types";

function environment(record:Record<string,unknown>|null) {
 return {OPEN_BRAIN_DB:{prepare:()=>({bind(){return this;},first:async()=>record,all:async()=>({results:[]})})}} as unknown as Env;
}
describe("console memory detail diagnostics",()=>{
 it("returns source verification and current use caution as separate states",async()=>{
  const result=await getMemoryDetails(environment({id:"memory-review",source:"manual",project_id:null,content:"Current content",summary:"Reviewed source",tags_json:"[]",created_at:1,deleted_at:null,lifecycle_state:"active",verification_state:"verified",confidence_score:0.9,valid_until:null,conflicts_json:'["conflicting evidence"]'}),"default","memory-review");
  expect(result.memory).toMatchObject({verification_state:"verified",answer_eligibility:"caution",attention_severity:"critical",attention_reasons:["conflicted"]});
 });
 it("does not invent diagnostics for an absent or unreadable record",async()=>{
  const result=await getMemoryDetails(environment(null),"default","missing");
  expect(result).toEqual({tenant_id:"default",memory_id:"missing",memory:null,versions:[],rationales:[]});
 });
});
