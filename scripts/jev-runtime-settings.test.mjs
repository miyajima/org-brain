import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadBundledJudgmentSettings } from "../packages/orgbrain-cli/src/lib/jev-runtime-settings.mjs";

test("bundled Jev settings respect explicit off and cannot persist provider credentials",async()=>{
  const root=await mkdtemp(join(tmpdir(),"jev-runtime-settings-"));
  try{
    await mkdir(join(root,"dist"));
    const options={buildInfo:{source:"standalone"},bundleUrl:pathToFileURL(join(root,"dist/orgbrain.mjs")).href,
      env:{ORGBRAIN_JEV_USE_MODE:"off"}};
    await writeFile(join(root,"jev-settings.json"),JSON.stringify({ORGBRAIN_JEV_PROJECTS:"org-brain",ORGBRAIN_JEV_USE_MODE:"shadow",ORGBRAIN_JEV_OBJECTIVE:"cost",ORGBRAIN_JEV_SEARCH_MODE:"shadow"}));
    await loadBundledJudgmentSettings(options);
    assert.equal(options.env.ORGBRAIN_JEV_USE_MODE,"off");assert.equal(options.env.ORGBRAIN_JEV_OBJECTIVE,"cost");
    assert.equal(options.env.ORGBRAIN_JEV_SEARCH_MODE,"shadow");
    await writeFile(join(root,"jev-settings.json"),JSON.stringify({OPENROUTER_API_KEY:"test-secret"}));
    await assert.rejects(loadBundledJudgmentSettings(options),/invalid_bundled_judgment_settings/u);
  }finally{await rm(root,{recursive:true,force:true});}
});
