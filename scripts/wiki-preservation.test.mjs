import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WikiService, setWikiFeature, countWikiTokens } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
import { callWikiTool } from "../packages/orgbrain-cli/src/lib/wiki-mcp.mjs";

test("CLI captures byte-exact reports and recalls facts with provenance",async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),"wiki-preserve-cli-")));
  const env={...process.env,ORGBRAIN_FEATURES_FILE:join(home,"features.json"),ORGBRAIN_WIKI_ROOT:join(home,"wiki"),ORGBRAIN_WIKI_ENGINE:resolve("packages/wiki-engine/target/debug/orgbrain-wiki-engine")};
  const wiki=new WikiService({config:env.ORGBRAIN_FEATURES_FILE,root:env.ORGBRAIN_WIKI_ROOT,binary:env.ORGBRAIN_WIKI_ENGINE});
  const cli=(...args)=>JSON.parse(execFileSync(process.execPath,["packages/orgbrain-cli/src/local-memory.mjs","wiki",...args],{env,encoding:"utf8",stdio:"pipe"}));
  try {
    await setWikiFeature(wiki.config,true);await wiki.request({op:"init"});
    const text="# 復旧\n768次元の生成は成功。\nただし索引利用は未確認。\n条件は同じ版。\n";
    const file=join(home,"report.md");await writeFile(file,text);
    const saved=cli("capture","reports/recovery.md","--input",file,"--summary","# 結果\n復旧しました。","--recorded-at","2026-10-20T01:00:00Z");
    assert.equal(saved.coverage.missing_count,0);
    const original=await wiki.request({op:"source_read",source_id:saved.source_id,version:saved.version});
    assert.equal(original.text,text);
    await rm(file);
    assert.equal((await wiki.request({op:"source_read",source_id:saved.source_id,version:saved.version})).text,text);
    const recalled=cli("recall","768 復旧");
    assert.ok(recalled.evidence.some(e=>e.text.includes("索引利用は未確認")));
    assert.equal(recalled.writes_performed,false);
    const broad=cli("recall","768 復旧","--context-mode","broad");
    assert.equal(broad.context_mode,"broad");
    assert.ok(broad.evidence.some(e=>e.kind==="wiki"));
  } finally {await rm(home,{recursive:true,force:true});}
});

test("MCP capture stays reported and recall obeys token budget and feature-off",async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),"wiki-preserve-mcp-")));
  const wiki=new WikiService({config:join(home,"features.json"),root:join(home,"wiki"),binary:resolve("packages/wiki-engine/target/debug/orgbrain-wiki-engine")});
  try {
    await setWikiFeature(wiki.config,true);await wiki.request({op:"init"});
    const captured=await callWikiTool({},"orgbrain_wiki_capture",{path:"a.md",name:"a.txt",text:"# 重要\n146件成功。配備は未確認。\n",summary:"# 要約\nテスト成功。"},{wiki});
    assert.equal(captured.verification_state,"reported_unverified");
    assert.equal(captured.memory_intake,undefined);
    const result=await callWikiTool({},"orgbrain_wiki_recall",{query:"146 未確認",token_budget:900},{wiki});
    assert.ok(countWikiTokens(result)<=900);
    assert.ok(result.evidence.some(e=>e.text.includes("未確認")));
    await setWikiFeature(wiki.config,false);
    await assert.rejects(callWikiTool({},"orgbrain_wiki_recall",{query:"needle",session_files:[join(home,"not-read")],workspace:home},{wiki}),/feature_disabled/);
  } finally {await rm(home,{recursive:true,force:true});}
});
