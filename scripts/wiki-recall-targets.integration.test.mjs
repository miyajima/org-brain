import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WikiService, setWikiFeature } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
import { callWikiTool } from "../packages/orgbrain-cli/src/lib/wiki-mcp.mjs";

test("CLI and MCP resolve recorded event windows and experiment IDs from real immutable reports",async()=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),"wiki-targets-cli-")));
  const env={...process.env,ORGBRAIN_FEATURES_FILE:join(home,"features.json"),ORGBRAIN_WIKI_ROOT:join(home,"wiki"),ORGBRAIN_WIKI_ENGINE:resolve("packages/wiki-engine/target/debug/orgbrain-wiki-engine")};
  const wiki=new WikiService({config:env.ORGBRAIN_FEATURES_FILE,root:env.ORGBRAIN_WIKI_ROOT,binary:env.ORGBRAIN_WIKI_ENGINE});
  const cli=(...args)=>JSON.parse(execFileSync(process.execPath,["packages/orgbrain-cli/src/local-memory.mjs","wiki",...args],{env,encoding:"utf8",stdio:"pipe"}));
  try {
    await setWikiFeature(wiki.config,true);await wiki.request({op:"init"});
    const wanted=await wiki.request({op:"capture",path:"reports/a.md",name:"a.md",text:"alpha beta 12件、配備は未確認。[原本](artifacts/run-a/REPORT.md)",summary:"# 報告",origin:{recorded_at:"2026-10-20T01:00:10Z"}});
    await wiki.request({op:"capture",path:"reports/b.md",name:"b.md",text:"alpha beta 99件、別の実験。[原本](artifacts/run-b/REPORT.md)",summary:"# 報告",origin:{recorded_at:"2026-10-20T01:00:20Z"}});
    await wiki.request({op:"capture",path:"reports/c.md",name:"c.md",text:"alpha beta 13件、後日配備済み。[原本](artifacts/run-a/REPORT.md)",summary:"# 報告",origin:{recorded_at:"2026-10-21T01:00:10Z"}});
    const targets=[{event_since:"2026-10-20T10:00:00+09:00",event_until:"2026-10-20T10:01:00+09:00",experiment_id:"run-a"}];
    const result=cli("recall","alpha beta","--targets-json",JSON.stringify(targets),"--excerpt-mode","passages","--passage-chars","500");
    assert.deepEqual(result.evidence.map(e=>e.source_id),[wanted.source_id]);
    assert.ok(result.evidence[0].text.includes("配備は未確認"));
    assert.deepEqual(result.unmatched_targets,[]);
    const mcp=await callWikiTool({},"orgbrain_wiki_recall",{query:"alpha beta",targets,excerpt_mode:"passages",passage_chars:500,token_budget:1400},{wiki});
    assert.deepEqual(mcp.evidence.map(e=>e.source_id),[wanted.source_id]);
    assert.ok(mcp.evidence[0].excerpt_ranges.length>0);
    assert.equal(mcp.evidence[0].timestamp,"2026-10-20T01:00:10Z");
  } finally {await rm(home,{recursive:true,force:true});}
});
