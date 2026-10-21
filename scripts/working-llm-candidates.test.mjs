import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { localRelevanceSelectorFromSettings } from "../packages/orgbrain-cli/src/lib/local-relevance-selection.mjs";
import { handleLocalMcpRequest } from "../packages/orgbrain-cli/src/local-mcp.mjs";
import { buildCodexMemoryContext } from "../packages/orgbrain-cli/src/codex-memory-context.mjs";
import { countContextTokens } from "../packages/orgbrain-cli/src/lib/compact-memory-context.mjs";

const run = promisify(execFile);
const captured = (id, overrides = {}) => ({ id, tenant_id:"default", project_id:"test", work_type:"implementation",
  kind:"decision", content:"Database backup full original body", summary:"Database backup policy", rationale:"Protect database backups",
  reuse_rule:"Only after checking current backup identity; do not reuse after expiry.", source:"fixture", source_references:[{ref:"event:backup"}], ...overrides });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "working-llm-candidates-"));
  const store = new LocalMemoryStore(join(dir,"memory.sqlite"), {denseEmbeddingProvider:null, env:{}, memoryJudge:async()=>({mode:"off"}), contextSearchJudge:async()=>({mode:"off"})});
  return {dir,store,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
async function call(store,name,args) {
  const result=await handleLocalMcpRequest(store,{method:"tools/call",params:{name,arguments:args}});
  return {result,body:JSON.parse(result.content[0].text)};
}

test("default host selection makes zero provider calls and returns pending candidates only", async () => {
  const selector=localRelevanceSelectorFromSettings({});
  assert.equal(selector?.provider,"working-llm");
  const before=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw new Error("network forbidden");};
  try {
    const rows=[{memory:captured("m1",{current_version:3}),score:{total:0.8}}];
    const original=structuredClone(rows);
    const selected=await selector.select("backup",rows);
    assert.deepEqual(selected.results,[]);assert.equal(selected.metadata.status,"pending_host_selection");
    assert.equal(selected.candidates[0].memory_id,"m1");assert.equal(selected.candidates[0].current_version,3);
    assert.equal(calls,0);assert.deepEqual(rows,original);
  } finally {globalThis.fetch=before;}
  assert.equal(localRelevanceSelectorFromSettings({ORGBRAIN_LOCAL_RELEVANCE_PROVIDER:"off"}),null);
  assert.equal(localRelevanceSelectorFromSettings({ORGBRAIN_LOCAL_RELEVANCE_PROVIDER:""}),null);
});

test("pure previews keep complete conditions, deduplicate exact text and disclose omitted body", async () => {
  const {workingLlmCandidate}=await import("../packages/orgbrain-cli/src/lib/working-llm-candidates.mjs");
  const rule="Only when source identity matches. "+"Retain this exception. ".repeat(300)+"Never repeat after failure.";
  const memory=captured("m2",{current_version:4,rationale:"Database backup policy",reuse_rule:rule,metadata:{secret_like_blob:"unused".repeat(10000)}});
  const before=structuredClone(memory);const candidate=workingLlmCandidate(memory);
  assert.equal(candidate.preview.split("Database backup policy").length-1,1);
  assert.ok(candidate.preview.endsWith(rule));assert.equal(candidate.full_body_omitted,true);
  const scoped=workingLlmCandidate(memory,{principal_id:"alice",project_id:"test",business_category_id:"engineering",work_type:"implementation"});
  assert.deepEqual(scoped.detail_ref.arguments,{tenant_id:"default",memory_id:"m2",expected_version:4,principal_id:"alice",project_id:"test",business_category_id:"engineering",work_type:"implementation"});
  assert.equal(candidate.detail_ref.arguments.expected_version,4);assert.equal(candidate.detail_ref.tool,"orgbrain_memory_get");
  assert.ok(!JSON.stringify(candidate).includes("secret_like_blob"));assert.deepEqual(memory,before);
  const fallback=workingLlmCandidate(captured("fallback",{summary:null,current_version:1}));
  assert.ok(fallback.preview.startsWith("Database backup full original body"));
});

test("detail reads reject stale, forbidden, expired, missing and out-of-scope records uniformly", async () => {
  const f=await fixture();
  try {
    await f.store.capture(captured("private",{permissions:[{principal_id:"alice",permissions:["read"]}]}));
    const scope={tenant_id:"default",memory_id:"private",expected_version:1,principal_id:"alice",project_id:"test",work_type:"implementation"};
    const good=await call(f.store,"orgbrain_memory_get",scope);assert.equal(good.result.isError,false);
    assert.equal(good.body.memory.content,"Database backup full original body");
    for (const change of [{expected_version:2},{expected_version:null},{memory_id:"missing"},{tenant_id:"other"},{principal_id:"bob"},{principal_id:null},{project_id:"other"},{business_category_id:"other"},{work_type:"support"}]) {
      const rejected=await call(f.store,"orgbrain_memory_get",{...scope,...change});
      assert.equal(rejected.result.isError,true,JSON.stringify(change));assert.deepEqual(rejected.body,{error:"memory_detail_unavailable"});
    }
    await f.store.capture(captured("expired",{expires_at:Date.now()-1}));
    assert.deepEqual((await call(f.store,"orgbrain_memory_get",{...scope,memory_id:"expired"})).body,{error:"memory_detail_unavailable"});
    await f.store.suppress("default","private","fixture",{actor_type:"principal",actor_id:"alice"});
    assert.deepEqual((await call(f.store,"orgbrain_memory_get",scope)).body,{error:"memory_detail_unavailable"});
  } finally {await f.cleanup();}
});

test("pending context packs whole previews before issuing version-pinned returned receipts", async () => {
  const f=await fixture();
  try {
    await f.store.capture(captured("fits"));
    await f.store.capture(captured("too-large",{rationale:"バックアップ適用条件を必ず確認する。".repeat(700)}));
    const context=await f.store.retrieveContext({tenant_id:"default",project_id:"test",query:"database backup",token_budget:1300,context_format:"compact"});
    assert.deepEqual(context.results,[]);assert.equal(context.meta.local_relevance.status,"pending_host_selection");
    assert.ok(context.candidates.some(x=>x.memory_id==="fits"));assert.ok(!context.candidates.some(x=>x.memory_id==="too-large"));
    assert.deepEqual(context.evidence_bundle.evidence,[]);assert.equal(context.evidence_bundle.abstention_recommended,true);
    assert.ok(countContextTokens(context)<=1300);assert.ok(context.evidence_bundle.budget_limited);
    assert.deepEqual(context.meta.usage_items.map(x=>[x.source_id,x.source_version]),context.candidates.map(x=>[x.memory_id,x.current_version]));
    const db=f.store.open({readOnly:true});try {
      const items=db.prepare("SELECT source_id,reference_type,used_state FROM memory_usage_items WHERE usage_event_id=?").all(context.meta.usage_id);
      assert.ok(items.every(x=>x.reference_type==="returned"&&x.used_state==="unknown"));
      assert.ok(!items.some(x=>x.source_id==="too-large"));
    } finally {db.close();}
  } finally {await f.cleanup();}
});

test("CLI and MCP search deliver the same preview projection and honor an explicit limit", async () => {
  const f=await fixture();
  try {
    for(let i=0;i<3;i++)await f.store.capture(captured(`m${i}`));
    const mcp=await call(f.store,"orgbrain_memory_search",{tenant_id:"default",project_id:"test",query:"database backup",limit:1,search_mode:"hybrid_v4"});
    const cli=await run(process.execPath,["packages/orgbrain-cli/src/local-memory.mjs","memory","search","database backup","--db",f.store.dbPath,"--project-id","test","--limit","1"],{cwd:process.cwd(),env:{...process.env,ORGBRAIN_LOCAL_RELEVANCE_PROVIDER:"working-llm",ORGBRAIN_LOCAL_DENSE_PROVIDER:"off"}});
    const body=JSON.parse(cli.stdout);assert.equal(body.candidates.length,1);assert.deepEqual(body.candidates,mcp.body.candidates);
    assert.deepEqual(body.results,[]);assert.equal(body.meta.usage_items.length,1);
  } finally {await f.cleanup();}
});

test("hook ordinary candidates are pending previews, bounded to two and perform no extra inference", async () => {
  const f=await fixture();const original=globalThis.fetch;
  try {
    const workspace=join(f.dir,"project"),workspacesFile=join(f.dir,"workspaces.json");
    await writeFile(workspacesFile,JSON.stringify({version:1,workspaces:{[workspace]:{tenant_id:"default",project_id:"test",default_work_type:"implementation"}}}));
    for(let i=0;i<3;i++)await f.store.capture(captured(`hook${i}`,{content:"RAW_BODY_SHOULD_BE_FETCHED ".repeat(200),source_references:[{ref:`event:backup-${i}`} ]}));
    await f.store.useHistory("configure",{mode:"c",collect:true,sync:false});
    let calls=0;globalThis.fetch=()=>{calls++;throw new Error("network forbidden");};
    f.store.relevanceSelector={provider:"qwen3-reranker-mlx",select:()=>{throw new Error("no hook inference");}};
    const output=await buildCodexMemoryContext({hook_event_name:"UserPromptSubmit",session_id:"preview",cwd:workspace,prompt:"database backup policy"},{store:f.store,env:{ORGBRAIN_WORKSPACES_FILE:workspacesFile,ORGBRAIN_ENABLE_CLOUD_MEMORY:"false",ORGBRAIN_ENABLE_ORG_SHARING:"false"}});
    const context=output.hookSpecificOutput.additionalContext;
    assert.match(context,/pending_host_selection/);assert.match(context,/candidate_limit=2/);assert.match(context,/orgbrain_memory_get/);
    assert.ok(!context.includes("RAW_BODY_SHOULD_BE_FETCHED"));assert.ok(Buffer.byteLength(context)<=7168);assert.equal(calls,0);
    const db=f.store.open({readOnly:true});try {
      const rows=db.prepare("SELECT source_id,source_version,reference_type,used_state FROM memory_usage_items WHERE usage_event_id IN (SELECT id FROM memory_usage_events WHERE capability='hook_context')").all();
      assert.equal(rows.length,2);assert.ok(rows.every(x=>x.source_version===1&&x.reference_type==="returned"&&x.used_state==="unknown"));
    } finally {db.close();}
  } finally {globalThis.fetch=original;await f.cleanup();}
});

test("host search and context default to twenty while explicit limits and minimum budgets remain exact", async () => {
  const f=await fixture();
  try {
    for(let i=0;i<22;i++) await f.store.capture(captured(`default-${i}`,{summary:`Database backup policy ${i}`,source_references:[{ref:`event:${i}`}]}));
    f.store.memoryJudge=()=>{throw new Error("host relevance must not call an internal judge");};
    f.store.contextSearchJudge=()=>{throw new Error("host relevance must not call an internal judge");};
    const search=await call(f.store,"orgbrain_memory_search",{query:"database backup",project_id:"test"});
    assert.equal(search.body.candidates.length,20);
    const context=await f.store.retrieveContext({tenant_id:"default",query:"database backup",project_id:"test",token_budget:16000});
    assert.equal(context.candidates.length,20);
    const limited=await f.store.retrieveContext({tenant_id:"default",query:"database backup",top_k:2,token_budget:16000});
    assert.equal(limited.candidates.length,2);
    for(const token_budget of [512,700,1500]) {
      const enriched=await call(f.store,"orgbrain_context_enrich",{query:"database backup",project_id:"test",work_type:"implementation",token_budget});
      assert.equal(enriched.result.isError,false,JSON.stringify(enriched.body));
      assert.ok(countContextTokens(enriched.body)<=token_budget);
      assert.deepEqual(enriched.body.evidence_bundle.evidence,[]);
    }
    const list=await handleLocalMcpRequest(f.store,{method:"tools/list"},{toolProfile:"answer-ux-readonly"});
    assert.deepEqual(list.tools.map(tool=>tool.name),["orgbrain_context_enrich","orgbrain_domain_context"]);
  } finally {await f.cleanup();}
});

test("explicit Qwen failure stays closed and does not deliver pending or raw fallback rows", async () => {
  const f=await fixture();const original=globalThis.fetch;
  try {
    await f.store.capture(captured("qwen-fail"));
    f.store.relevanceSelector=localRelevanceSelectorFromSettings({ORGBRAIN_LOCAL_RELEVANCE_PROVIDER:"qwen3-reranker-mlx",ORGBRAIN_LOCAL_RELEVANCE_REVISION:"e61197ed45024b0ed8a2d74b80b4d909f1255473"});
    globalThis.fetch=()=>{throw new Error("fixture provider unavailable");};
    const selected=await call(f.store,"orgbrain_memory_search",{query:"database backup"});
    assert.deepEqual(selected.body.results,[]);assert.equal(selected.body.candidates,undefined);
    assert.equal(selected.body.meta.local_relevance.status,"unavailable");assert.equal(selected.body.meta.usage_items.length,0);
  } finally {globalThis.fetch=original;await f.cleanup();}
});

test("optional null metadata is omitted without losing false, zero, pinned identity or applicability", async () => {
  const {workingLlmCandidate}=await import("../packages/orgbrain-cli/src/lib/working-llm-candidates.mjs");
  const condition="Only when the source and project still match; never retry a failed action without a new hypothesis.";
  const memory=captured("sparse",{current_version:7,content:"Database backup policy",reuse_rule:condition,
    business_category_id:null,scope_type:"project",scope_key:null,confirmation_state:null,
    verification_state:"verified",valid_from:0,valid_until:null,expires_at:null,lifecycle_state:"active",source_references:[]});
  const candidate=workingLlmCandidate(memory,{principal_id:null,project_id:"test",business_category_id:null,work_type:"implementation"});
  const assertNoNull=(value)=>{if(value&&typeof value==="object")for(const nested of Object.values(value)){assert.notEqual(nested,null);assertNoNull(nested);}};
  assertNoNull(candidate);
  assert.equal(candidate.full_body_omitted,false);assert.equal(candidate.additional_source_count,0);
  assert.equal(candidate.verification.conflict_count,0);assert.equal(candidate.validity.valid_from,0);
  assert.equal(candidate.verification.verification_state,"verified");assert.equal(candidate.validity.lifecycle_state,"active");
  assert.ok(candidate.preview.endsWith(condition));assert.ok(!Object.hasOwn(candidate,"source_reference"));
  assert.deepEqual(candidate.detail_ref.arguments,{tenant_id:"default",memory_id:"sparse",expected_version:7,project_id:"test",work_type:"implementation"});
  assert.equal(candidate.memory_id,"sparse");assert.equal(candidate.current_version,7);
});


test("answer UX keeps its sanitized evidence contract without exposing detail tools or calling relevance models", async () => {
  const f=await fixture();
  try {
    await f.store.capture(captured("answer-ux",{work_type:"other",content:"Internal full body must stay out of the answer profile.",summary:"Database backup policy needs two reviewers."}));
    f.store.memoryJudge=()=>{throw new Error("no profile inference");};
    f.store.contextSearchJudge=()=>{throw new Error("no profile inference");};
    f.store.relevanceSelector={provider:"qwen3-reranker-mlx",candidateLimit:20,select:()=>{throw new Error("no profile inference");}};
    const result=await handleLocalMcpRequest(f.store,{method:"tools/call",params:{name:"orgbrain_context_enrich",arguments:{tenant_id:"default",project_id:"test",query:"database backup policy reviewers"}}},{toolProfile:"answer-ux-readonly"});
    assert.equal(result.isError,false);const text=result.content[0].text,body=JSON.parse(text);
    assert.equal(body.evidence_bundle.evidence[0].summary,"Database backup policy needs two reviewers.");
    assert.doesNotMatch(text,/memory_id|usage_id|candidate_id|Internal full body/);
    await assert.rejects(handleLocalMcpRequest(f.store,{method:"tools/call",params:{name:"orgbrain_memory_get",arguments:{memory_id:"answer-ux",expected_version:1}}},{toolProfile:"answer-ux-readonly"}),/not available/);
  } finally {await f.cleanup();}
});

test("hook redacts preview PII while preserving numeric UUIDs and resolvable scoped detail references", async () => {
  const f=await fixture();
  try {
    const workspace=join(f.dir,"project"),workspacesFile=join(f.dir,"workspaces.json");
    await writeFile(workspacesFile,JSON.stringify({version:1,workspaces:{[workspace]:{tenant_id:"default",project_id:"test",default_work_type:"implementation"}}}));
    const memoryId="12345678-9012-4abc-8def-123456789abc";
    await f.store.capture(captured(memoryId,{summary:"Database backup policy. Contact user@example.com or 090-1234-5678.",source_references:[{ref:`event:${memoryId}`}]}));
    const output=await buildCodexMemoryContext({hook_event_name:"UserPromptSubmit",session_id:"numeric-id",cwd:workspace,prompt:"database backup policy"},
      {store:f.store,env:{ORGBRAIN_WORKSPACES_FILE:workspacesFile,ORGBRAIN_ENABLE_CLOUD_MEMORY:"false",ORGBRAIN_ENABLE_ORG_SHARING:"false",ORGBRAIN_USE_PRINCIPAL:"alice"}});
    const context=output.hookSpecificOutput.additionalContext;
    const candidate=context.split("\n\n").filter(part=>part.startsWith("{"))
      .map(part=>JSON.parse(part)).find(item=>item.detail_ref?.tool==="orgbrain_memory_get");
    assert.equal(candidate.memory_id,memoryId);assert.equal(candidate.current_version,1);
    assert.equal(candidate.detail_ref.arguments.memory_id,memoryId);assert.equal(candidate.detail_ref.arguments.expected_version,1);
    assert.equal(candidate.detail_ref.arguments.principal_id,"alice");assert.equal(candidate.detail_ref.arguments.project_id,"test");
    assert.equal(candidate.detail_ref.arguments.work_type,"implementation");assert.ok(!Object.hasOwn(candidate,"source_reference"));assert.ok(!Object.hasOwn(candidate,"scope"));
    assert.doesNotMatch(candidate.preview,/user@example\.com|090-1234-5678/);
    assert.match(candidate.preview,/\[REDACTED_EMAIL\]/);assert.match(candidate.preview,/\[REDACTED_PHONE\]/);
    const detail=await call(f.store,"orgbrain_memory_get",candidate.detail_ref.arguments);
    assert.equal(detail.result.isError,false);assert.equal(detail.body.memory.id,memoryId);
  } finally {await f.cleanup();}
});

test("pending search without a work type keeps tenant, project, principal, expiry and suppression boundaries", async () => {
  const f=await fixture();
  try {
    await f.store.capture(captured("restricted",{permissions:[{principal_id:"alice",permissions:["read"]}],
      source_references:[{ref:"event:restricted"}]}));
    await f.store.capture(captured("research",{work_type:"research",source_references:[{ref:"event:research"}]}));
    await f.store.capture(captured("other",{work_type:"other",source_references:[{ref:"event:other"}]}));
    await f.store.capture(captured("cross-tenant",{tenant_id:"other",work_type:"research",
      source_references:[{ref:"event:cross-tenant"}]}));
    await f.store.capture(captured("cross-project",{project_id:"other",work_type:"research",
      source_references:[{ref:"event:cross-project"}]}));
    await f.store.capture(captured("expired",{work_type:"research",expires_at:Date.now()-1000,
      source_references:[{ref:"event:expired"}]}));
    await f.store.capture(captured("suppressed",{work_type:"research",source_references:[{ref:"event:suppressed"}]}));
    await f.store.suppress("default","suppressed","fixture",{actor_type:"principal",actor_id:"alice"});
    const query={tenant_id:"default",project_id:"test",query:"database backup"};
    const anonymous=await call(f.store,"orgbrain_memory_search",query);
    const anonymousIds=anonymous.body.candidates.map(({memory_id})=>memory_id);
    assert.ok(anonymousIds.includes("research"));
    assert.ok(anonymousIds.includes("other"));
    assert.ok(!anonymousIds.includes("restricted"));
    assert.ok(!anonymousIds.includes("suppressed"));
    assert.ok(!anonymousIds.some(id=>["cross-tenant","cross-project","expired"].includes(id)));
    assert.deepEqual(anonymous.body.meta.usage_items.map(({source_id})=>source_id).sort(),anonymousIds.sort());

    const authorized=await call(f.store,"orgbrain_memory_search",{...query,principal_id:"alice"});
    const authorizedIds=authorized.body.candidates.map(({memory_id})=>memory_id).sort();
    assert.deepEqual(authorizedIds,["other","research","restricted"]);
    assert.ok(!authorizedIds.includes("suppressed"));
    const candidate=authorized.body.candidates.find(({memory_id})=>memory_id==="restricted");
    assert.equal(candidate.detail_ref.arguments.principal_id,"alice");
    assert.equal(candidate.detail_ref.arguments.project_id,"test");
    assert.equal(candidate.detail_ref.arguments.tenant_id,"default");
    assert.equal(Object.hasOwn(candidate.detail_ref.arguments,"work_type"),false);
    const detail=await call(f.store,"orgbrain_memory_get",candidate.detail_ref.arguments);
    assert.equal(detail.result.isError,false);assert.equal(detail.body.memory.id,"restricted");
    assert.equal(detail.body.memory.current_version,candidate.current_version);
    const denied=await call(f.store,"orgbrain_memory_search",{...query,principal_id:"bob"});
    assert.ok(!denied.body.candidates.some(({memory_id})=>memory_id==="restricted"));
    const explicitOther=await call(f.store,"orgbrain_memory_search",{...query,principal_id:"alice",work_type:"other"});
    assert.deepEqual(explicitOther.body.candidates.map(({memory_id})=>memory_id),["other"]);
    assert.equal(explicitOther.body.candidates[0].detail_ref.arguments.work_type,"other");
    const explicitImplementation=await call(f.store,"orgbrain_memory_search",{...query,principal_id:"alice",work_type:"implementation"});
    assert.deepEqual(explicitImplementation.body.candidates.map(({memory_id})=>memory_id).sort(),["other","restricted"]);
    assert.ok(explicitImplementation.body.candidates.every(({detail_ref})=>detail_ref.arguments.work_type==="implementation"));
    f.store.relevanceSelector=null;
    const legacy=await call(f.store,"orgbrain_memory_search",{...query,work_type:"implementation"});
    assert.deepEqual(legacy.body.results.map(({memory})=>memory.id).sort(),["other","restricted"]);
  } finally {await f.cleanup();}
});

test("CLI forwards an explicit principal through candidate retrieval and preserves the scoped detail reference", async () => {
  const f=await fixture();
  try {
    await f.store.capture(captured("cli-private",{permissions:[{principal_id:"alice",permissions:["read"]}]}));
    for(const principal of ["alice","bob"]){
      const cli=await run(process.execPath,["packages/orgbrain-cli/src/local-memory.mjs","memory","search","database backup","--db",f.store.dbPath,"--project-id","test","--principal-id",principal],
        {cwd:process.cwd(),env:{...process.env,ORGBRAIN_LOCAL_RELEVANCE_PROVIDER:"working-llm",ORGBRAIN_LOCAL_DENSE_PROVIDER:"off"}});
      const result=JSON.parse(cli.stdout);
      assert.equal(result.candidates.length,principal==="alice"?1:0);
      if(principal==="alice"){
        assert.equal(result.candidates[0].detail_ref.arguments.principal_id,"alice");
        assert.equal((await call(f.store,"orgbrain_memory_get",result.candidates[0].detail_ref.arguments)).result.isError,false);
      }
    }
  } finally {await f.cleanup();}
});

test("hook pending permissions require an explicit configured principal rather than the operating-system username", async () => {
  const f=await fixture();
  try {
    const workspace=join(f.dir,"project"),workspacesFile=join(f.dir,"workspaces.json");
    await writeFile(workspacesFile,JSON.stringify({version:1,workspaces:{[workspace]:{tenant_id:"default",project_id:"test",default_work_type:"implementation"}}}));
    await f.store.capture(captured("hook-private",{permissions:[{principal_id:"alice",permissions:["read"]}]}));
    for(const principal of [null,"alice","bob"]){
      const output=await buildCodexMemoryContext({hook_event_name:"UserPromptSubmit",session_id:`private-${principal}`,cwd:workspace,prompt:"database backup policy"},
        {store:f.store,env:{ORGBRAIN_WORKSPACES_FILE:workspacesFile,ORGBRAIN_ENABLE_CLOUD_MEMORY:"false",ORGBRAIN_ENABLE_ORG_SHARING:"false",USER:"alice",
          ...(principal?{ORGBRAIN_USE_PRINCIPAL:principal}:{})}});
      const context=output?.hookSpecificOutput.additionalContext??"";
      if(principal==="alice"){
        const candidate=context.split("\n\n").filter(part=>part.startsWith("{")).map(part=>JSON.parse(part)).find(item=>item.memory_id==="hook-private");
        assert.equal(candidate.detail_ref.arguments.principal_id,"alice");
        assert.equal((await call(f.store,"orgbrain_memory_get",candidate.detail_ref.arguments)).result.isError,false);
      }else assert.ok(!context.includes("hook-private"));
    }
  } finally {await f.cleanup();}
});

test("hook omits optional provenance URLs and display scope while keeping exact operational detail arguments", async () => {
  const f=await fixture();
  try {
    const workspace=join(f.dir,"project"),workspacesFile=join(f.dir,"workspaces.json");
    await writeFile(workspacesFile,JSON.stringify({version:1,workspaces:{[workspace]:{tenant_id:"default",project_id:"test",default_work_type:"implementation"}}}));
    const memoryId="12345678-9012-4abc-8def-123456789abc";
    const sourceUrl="https://example.invalid/private?token=fixture-only-secret&owner=source-owner@example.invalid";
    await f.store.capture(captured(memoryId,{summary:"Database backup policy. Contact preview-owner@example.invalid or 090-1234-5678.",
      source_references:[{ref:sourceUrl,source:"source-owner@example.invalid",source_id:"fixture-only-secret"}]}));
    const output=await buildCodexMemoryContext({hook_event_name:"UserPromptSubmit",session_id:"safe-provenance",cwd:workspace,prompt:"database backup policy"},
      {store:f.store,env:{ORGBRAIN_WORKSPACES_FILE:workspacesFile,ORGBRAIN_ENABLE_CLOUD_MEMORY:"false",ORGBRAIN_ENABLE_ORG_SHARING:"false",ORGBRAIN_USE_PRINCIPAL:"alice"}});
    const context=output.hookSpecificOutput.additionalContext;
    assert.ok(!context.includes("fixture-only-secret"));assert.ok(!context.includes("source-owner@example.invalid"));
    assert.ok(!context.includes("preview-owner@example.invalid"));assert.ok(!context.includes("090-1234-5678"));
    const candidate=context.split("\n\n").filter(part=>part.startsWith("{")).map(part=>JSON.parse(part)).find(item=>item.memory_id===memoryId);
    assert.ok(!Object.hasOwn(candidate,"source_reference"));assert.ok(!Object.hasOwn(candidate,"scope"));
    assert.equal(candidate.current_version,1);assert.equal(candidate.detail_ref.arguments.memory_id,memoryId);
    assert.equal(candidate.detail_ref.arguments.expected_version,1);assert.equal(candidate.detail_ref.arguments.project_id,"test");
    assert.equal(candidate.detail_ref.arguments.principal_id,"alice");assert.equal(candidate.detail_ref.arguments.work_type,"implementation");
    assert.match(candidate.preview,/\[REDACTED_EMAIL\]/);assert.match(candidate.preview,/\[REDACTED_PHONE\]/);
    const detail=await call(f.store,"orgbrain_memory_get",candidate.detail_ref.arguments);
    assert.equal(detail.result.isError,false);assert.equal(detail.body.memory.id,memoryId);
  } finally {await f.cleanup();}
});

test("pending contexts retain the requested compact or full format within the complete minimum budget", async () => {
  const f=await fixture();
  try {
    await f.store.capture(captured("format"));
    for(const context_format of ["compact","full"]){
      const context=await f.store.retrieveContext({tenant_id:"default",query:"database backup",context_format,token_budget:512});
      assert.equal(context.evidence_bundle.context_format,context_format);
      assert.ok(countContextTokens(context)<=512);assert.deepEqual(context.evidence_bundle.evidence,[]);
      assert.equal(context.meta.local_relevance.status,"pending_host_selection");
    }
  } finally {await f.cleanup();}
});

test("CLI pinned get returns full authorized details and rejects stale or forbidden reads without a body", async () => {
  const f=await fixture();
  try {
    await f.store.capture(captured("cli-get",{permissions:[{principal_id:"alice",permissions:["read"]}]}));
    const args=["packages/orgbrain-cli/src/local-memory.mjs","memory","get","cli-get","--db",f.store.dbPath,"--tenant-id","default","--project-id","test","--work-type","implementation"];
    const options={cwd:process.cwd(),env:{...process.env,ORGBRAIN_LOCAL_RELEVANCE_PROVIDER:"working-llm",ORGBRAIN_LOCAL_DENSE_PROVIDER:"off"}};
    const good=await run(process.execPath,[...args,"--expected-version","1","--principal-id","alice"],options);
    assert.equal(JSON.parse(good.stdout).memory.content,"Database backup full original body");
    assert.equal(JSON.parse(good.stdout).memory.current_version,1);
    for(const extra of [["--expected-version","2","--principal-id","alice"],["--expected-version","1","--principal-id","bob"],["--principal-id","alice"]]){
      await assert.rejects(run(process.execPath,[...args,...extra],options),error=>{
        assert.match(error.stderr,/memory_detail_unavailable/);assert.equal(error.stdout,"");
        assert.ok(!error.stderr.includes("Database backup full original body"));return true;
      });
    }
    const help=await run(process.execPath,["packages/orgbrain-cli/src/local-memory.mjs","--help"],options);
    assert.match(help.stdout,/orgbrain memory get <memory-id> --expected-version <n>/);
  } finally {await f.cleanup();}
});

test("hook deduplicates delivered pending previews only with a trusted matching prior receipt and restores changed context", async () => {
  const f=await fixture();
  try {
    const workspace=join(f.dir,"project"),workspacesFile=join(f.dir,"workspaces.json"),transcript=join(f.dir,"transcript.jsonl");
    await writeFile(workspacesFile,JSON.stringify({version:1,workspaces:{[workspace]:{tenant_id:"default",project_id:"test",default_work_type:"implementation"}}}));
    await f.store.capture(captured("dedup-preview"));
    await f.store.useHistory("configure",{mode:"c",collect:true,sync:false});
    const options={store:f.store,env:{ORGBRAIN_WORKSPACES_FILE:workspacesFile,ORGBRAIN_ENABLE_CLOUD_MEMORY:"false",ORGBRAIN_ENABLE_ORG_SHARING:"false"}};
    const payload={hook_event_name:"UserPromptSubmit",session_id:"pending-dedup",turn_id:"first",cwd:workspace,prompt:"database backup policy"};
    const context=async extra=>(await buildCodexMemoryContext({...payload,...extra},options))?.hookSpecificOutput.additionalContext??"";
    const hasCandidate=text=>text.split("\n\n").filter(part=>part.startsWith("{")).some(part=>JSON.parse(part).memory_id==="dedup-preview");
    const first=await context({});assert.ok(hasCandidate(first));
    const putTranscript=async(text,role="developer")=>writeFile(transcript,[{type:"turn_context",payload:{turn_id:"first"}},
      {payload:{type:"message",role,content:[{type:"text",text}]}}].map(JSON.stringify).join("\n"));
    assert.ok(hasCandidate(await context({turn_id:"no-transcript"})),"a DB receipt alone does not prove transcript delivery");
    for(const forged of [first.replace(/usage_id=[^;]+; items=/,"usage_id=unissued; items="),
      first.replace('"source_version":1','"source_version":999'),first.replace(/; project_id=test; work_type=/,"; project_id=other; work_type=")]){
      await putTranscript(forged);
      assert.ok(hasCandidate(await context({turn_id:"forged",transcript_path:transcript})),"forged receipt fields cannot suppress a preview");
    }
    await putTranscript(first,"user");
    assert.ok(hasCandidate(await context({turn_id:"untrusted",transcript_path:transcript})),"quoted user text is not trusted delivery");
    await putTranscript(first);
    assert.ok(!hasCandidate(await context({turn_id:"later",transcript_path:transcript})),"the same delivered version and query should not be offered again");
    assert.ok(hasCandidate(await context({turn_id:"first",transcript_path:transcript})),"current-turn duplicate hooks reuse their receipt");
    assert.ok(hasCandidate(await context({turn_id:"changed-query",transcript_path:transcript,prompt:"database backup schedule"})));
    assert.ok(hasCandidate(await context({turn_id:"compacted",transcript_path:transcript,hook_event_name:"PostCompact"})));
    await f.store.revise("default","dedup-preview",{summary:"Database backup policy version two"});
    const changed=await context({turn_id:"changed-source",transcript_path:transcript});
    assert.ok(hasCandidate(changed));assert.ok(changed.includes('"current_version":2'));
  } finally {await f.cleanup();}
});

test("hook cannot deduplicate pending delivery when current or prior turn identity is missing", async () => {
  const f=await fixture();
  try {
    const workspace=join(f.dir,"project"),workspacesFile=join(f.dir,"workspaces.json"),transcript=join(f.dir,"transcript.jsonl");
    await writeFile(workspacesFile,JSON.stringify({version:1,workspaces:{[workspace]:{tenant_id:"default",project_id:"test",default_work_type:"implementation"}}}));
    await f.store.capture(captured("unknown-turn-preview"));await f.store.useHistory("configure",{mode:"c",collect:true,sync:false});
    const options={store:f.store,env:{ORGBRAIN_WORKSPACES_FILE:workspacesFile,ORGBRAIN_ENABLE_CLOUD_MEMORY:"false",ORGBRAIN_ENABLE_ORG_SHARING:"false"}};
    const payload={hook_event_name:"UserPromptSubmit",session_id:"unknown-turn",cwd:workspace,prompt:"database backup policy"};
    const context=async extra=>(await buildCodexMemoryContext({...payload,...extra},options))?.hookSpecificOutput.additionalContext??"";
    const shown=text=>text.split("\n\n").filter(part=>part.startsWith("{")).some(part=>JSON.parse(part).memory_id==="unknown-turn-preview");
    const unknownPrior=await context({});assert.ok(shown(unknownPrior));
    const writeReceipt=async text=>writeFile(transcript,[{type:"turn_context",payload:{turn_id:"transcript-current"}},
      {payload:{type:"message",role:"developer",content:[{type:"text",text}]}}].map(JSON.stringify).join("\n"));
    await writeReceipt(unknownPrior);
    assert.ok(shown(await context({transcript_path:transcript})),"a receipt from an unknown turn cannot suppress the current unknown turn");
    assert.ok(shown(await context({turn_id:"known-current",transcript_path:transcript})),"a known current turn does not establish an unknown receipt's prior turn");
    const knownPrior=await context({turn_id:"known-prior"});await writeReceipt(knownPrior);
    assert.ok(shown(await context({transcript_path:transcript})),"a known prior receipt cannot suppress an unidentified current turn");
  } finally {await f.cleanup();}
});
