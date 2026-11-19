import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { handleLocalMcpRequest } from "../packages/orgbrain-cli/src/local-mcp.mjs";
import { buildCodexAttemptImportReport, applyCodexAttemptImportReport } from "../packages/orgbrain-cli/src/codex-session-import.mjs";
import { preflightHookAction, recordHookActionResult } from "../packages/orgbrain-cli/src/lib/action-attempt-hook.mjs";
import { safeAttemptActionLabel } from "../packages/shared/src/attempt-history-runtime.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orgbrain-action-attempts-"));
  const store = new LocalMemoryStore(join(root, "memory.sqlite"));
  return { root, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function attempt(id, overrides = {}) {
  return {
    id, project_id: "consentside", action_key: "sip:gateway:retry", action_label: "SIP gateway を再設定",
    target: "staging gateway", conditions: { version: "v1", config: "a" }, outcome: "failure",
    result_summary: "設定値が拒否された", failure_kind: "deterministic", performed_at: Date.now() - 1_000,
    executed_by_type: "agent", executed_by: "codex", evidence: [{ ref_type: "task_event", ref_id: `event:${id}`, content_hash: "a".repeat(64) }],
    source: "fixture", source_key: `source:${id}`, ...overrides
  };
}

test("verified attempts stop identical remedies, allow a changed hypothesis, and preserve corrections", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.recordAttempt("default", attempt("first"), { trusted: true });
    assert.equal((await ctx.store.listFailurePatterns("default", { projectId: "consentside" })).filter((item) => item.is_active).length, 1);
    const blocked = await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v1", config: "a" } });
    assert.equal(blocked.decision, "block");
    assert.equal(blocked.prior_attempts[0].evidence[0].ref_id, "event:first");
    const feedback = await ctx.store.recordAttemptMetricEvent("default", {
      project_id: "consentside", kind: "feedback", source: "mcp",
      related_event_id: blocked.preflight_event_id, feedback_verdict: "false_block",
      evidence: [{ ref_type: "task_event", ref_id: "event:feedback", content_hash: "c".repeat(64) }]
    });
    assert.equal(feedback.verification_state, "reported");
    const changed = await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v2", config: "a" } });
    assert.equal(changed.decision, "block");
    assert.equal(changed.reason, "failed_action_requires_review");
    const proposed = await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v2", config: "a" }, change_hypothesis: "新しい版で設定が受理される", alternatives: [{ action_key: "sip:gateway:other", label: "別の経路" }] });
    assert.equal(proposed.decision, "allow");
    assert.equal(proposed.alternative_candidates[0].status, "no_accessible_prior_attempt");
    await ctx.store.recordAttempt("default", attempt("correction", { supersedes_id: "first", outcome: "success", result_summary: "実際には成功していた", failure_kind: undefined, performed_at: Date.now() }), { trusted: true });
    assert.equal((await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v1", config: "a" } })).decision, "allow");
    assert.equal((await ctx.store.searchAttempts("default", { project_id: "consentside" })).length, 1);
    assert.equal((await ctx.store.listFailurePatterns("default", { projectId: "consentside" })).filter((item) => item.is_active).length, 0);
    const metrics = await ctx.store.actionAttemptMetricsReport("default", "consentside");
    assert.equal(metrics.preflight_blocks, 2);
    assert.equal(metrics.false_blocks_reported, 1);
    assert.equal(metrics.false_blocks_verified, 0);
  } finally { await ctx.cleanup(); }
});

test("a later verified success resolves an earlier failure without changing the audit record", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.recordAttempt("default", attempt("failed-earlier", {
      performed_at: Date.parse("2026-08-25T00:00:00Z")
    }), { trusted: true });
    await ctx.store.recordAttempt("default", attempt("success-later", {
      outcome: "success", failure_kind: undefined, result_summary: "再試行は成功",
      performed_at: Date.parse("2026-08-26T00:00:00Z")
    }), { trusted: true });
    assert.equal((await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v1", config: "a" } })).decision, "allow");
    await ctx.store.recordAttempt("default", attempt("reported-after-success", {
      performed_at: Date.parse("2026-08-27T00:00:00Z")
    }));
    assert.equal((await ctx.store.preflightAction("default", { project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v1", config: "a" } })).decision, "warn");
    assert.equal((await ctx.store.searchAttempts("default", { project_id: "consentside" })).length, 3);
    assert.equal((await ctx.store.listFailurePatterns("default", { projectId: "consentside" })).filter((item) => item.is_active).length, 0);
  } finally { await ctx.cleanup(); }
});

test("a verified transient failure warns instead of blocking", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.recordAttempt("default", attempt("transient", { failure_kind: "transient" }), { trusted: true });
    const result = await ctx.store.preflightAction("default", {
      project_id: "consentside", action_key: "sip:gateway:retry", conditions: { version: "v1", config: "a" }
    });
    assert.equal(result.decision, "warn");
    assert.equal(result.reason, "failure_not_deterministic_or_verified");
  } finally { await ctx.cleanup(); }
});

test("verified imported failures require review before an identical retry even without historical conditions", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.recordAttempt('default', attempt('imported', { attempt_type:'tool_result', conditions:{}, failure_kind:'unknown' }), {trusted:true});
    for (const conditions of [{}, {version:'current'}]) {
      const result=await ctx.store.preflightAction('default',{project_id:'consentside',action_key:'sip:gateway:retry',conditions});
      assert.equal(result.decision,'block');
      assert.equal(result.reason,'failed_action_requires_review');
      assert.equal(result.prior_attempts[0].failure_kind,'unknown');
    }
    assert.equal((await ctx.store.listFailurePatterns('default',{projectId:'consentside'})).length,0);
    await ctx.store.recordAttempt('default',attempt('resolved-import',{attempt_type:'tool_result',conditions:{},outcome:'success',performed_at:Date.now()}),{trusted:true});
    assert.equal((await ctx.store.preflightAction('default',{project_id:'consentside',action_key:'sip:gateway:retry',conditions:{}})).decision,'allow');
  } finally { await ctx.cleanup(); }
});

test("reviewed retries are explicit, task scoped, bound to conditions and consumed only once", async () => {
  const ctx=await fixture();
  try {
    await ctx.store.recordAttempt('default',attempt('imported',{attempt_type:'tool_result',conditions:{},failure_kind:'unknown'}),{trusted:true});
    const input={project_id:'consentside',action_key:'sip:gateway:retry',conditions:{version:'v2'},task_id:'codex:one'};
    await assert.rejects(ctx.store.preflightAction('default',{...input,retry_once:true}),/retry_reason_required/);
    await assert.rejects(ctx.store.preflightAction('default',{...input,task_id:undefined,retry_once:true,change_hypothesis:'fixed configuration'}),/retry_task_required/);
    const allowed=await ctx.store.preflightAction('default',{...input,retry_once:true,change_hypothesis:'fixed configuration'});
    assert.equal(allowed.decision,'allow');
    assert.equal(allowed.retry_permit.status,'issued');
    assert.equal((await ctx.store.preflightAction('default',{...input,task_id:'codex:other'},{source:'hook'})).decision,'block');
    assert.equal((await ctx.store.preflightAction('default',{...input,conditions:{version:'v3'}},{source:'hook'})).decision,'block');
    const consumed=await ctx.store.preflightAction('default',input,{source:'hook'});
    assert.equal(consumed.decision,'allow');
    assert.equal(consumed.reason,'reviewed_retry_once');
    assert.equal((await ctx.store.preflightAction('default',input,{source:'hook'})).decision,'block');
  } finally { await ctx.cleanup(); }
});

test("expired and stale retry permits never release a later failure or a deterministic same-condition block", async () => {
  const ctx=await fixture();
  try {
    await ctx.store.recordAttempt('default',attempt('unknown',{attempt_type:'tool_result',failure_kind:'unknown'}),{trusted:true});
    const input={project_id:'consentside',action_key:'sip:gateway:retry',task_id:'codex:one',conditions:{version:'v1',config:'a'}};
    const permit=await ctx.store.preflightAction('default',{...input,retry_once:true,change_hypothesis:'the unavailable service has recovered'});
    const db=ctx.store.open();
    db.prepare('UPDATE local_action_retry_permits SET expires_at=0 WHERE id=?').run(permit.retry_permit.id);db.close();
    assert.equal((await ctx.store.preflightAction('default',input,{source:'hook'})).decision,'block');
    await ctx.store.preflightAction('default',{...input,retry_once:true,change_hypothesis:'the service is now healthy'});
    await ctx.store.recordAttempt('default',attempt('newer',{attempt_type:'tool_result',failure_kind:'unknown',performed_at:Date.now()}),{trusted:true});
    assert.equal((await ctx.store.preflightAction('default',input,{source:'hook'})).decision,'block');
    await ctx.store.recordAttempt('default',attempt('deterministic',{performed_at:Date.now()+1}),{trusted:true});
    const blocked=await ctx.store.preflightAction('default',{...input,retry_once:true,change_hypothesis:'try unchanged again'});
    assert.equal(blocked.decision,'block');
    assert.equal(blocked.reason,'verified_same_condition_failure');
    assert.equal(blocked.retry_permit,undefined);
  } finally { await ctx.cleanup(); }
});

test('hook retry context round trips through MCP and releases only one concurrent check', async () => {
  const ctx = await fixture();
  try {
    const payload = {tool_name:'functions.exec_command', session_id:'retry-integration', tool_call_id:'failed-call',
      tool_input:{cmd:'npm run failed-check',workdir:ctx.root}, tool_result:{exit_code:17}};
    await recordHookActionResult(payload,ctx.store,'default','consentside');
    const blocked = await preflightHookAction(payload,ctx.store,'default','consentside');
    assert.equal(blocked.decision,'block');
    const input = {...blocked.retry_context,retry_once:true,change_hypothesis:'The missing test fixture has now been restored'};
    await assert.rejects(ctx.store.preflightAction('default',{...input,change_hypothesis:'password=private-value'}),/sensitive_retry_reason/);
    assert.equal((await preflightHookAction(payload,ctx.store,'default','consentside')).decision,'block');
    const response = await handleLocalMcpRequest(ctx.store,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'orgbrain_action_preflight',arguments:input}});
    assert.equal(JSON.parse(response.content[0].text).retry_permit.status,'issued');
    const outcomes = await Promise.all([preflightHookAction(payload,ctx.store,'default','consentside'),preflightHookAction(payload,ctx.store,'default','consentside')]);
    assert.deepEqual(outcomes.map(x=>x.decision).sort(),['allow','block']);
    await recordHookActionResult({...payload,tool_call_id:'successful-call',tool_result:{exit_code:0}},ctx.store,'default','consentside');
    assert.equal((await preflightHookAction(payload,ctx.store,'default','consentside')).decision,'allow');
  } finally { await ctx.cleanup(); }
});

test('CLI hook records a failure then denies its repeat for direct and static wrapped commands', async () => {
  const ctx = await fixture();
  try {
    const mapping=join(ctx.root,'workspaces.json'), envFile=join(ctx.root,'hooks.env');
    await writeFile(mapping,JSON.stringify({version:3,workspaces:{[ctx.root]:{tenant_id:'default',project_id:'consentside',memory_learning_mode:'off'}}}));
    await writeFile(envFile,'ORGBRAIN_ENABLE_CLOUD_MEMORY=false\nORGBRAIN_LOCAL_HOOK_CAPTURE=false\n');
    const cli=process.env.ORGBRAIN_TEST_CLI_PATH ?? new URL('../packages/orgbrain-cli/src/local-memory.mjs',import.meta.url).pathname;
    const env={...process.env,ORGBRAIN_LOCAL_DB:join(ctx.root,'memory.sqlite'),ORGBRAIN_WORKSPACES_FILE:mapping,
      ORGBRAIN_HOOK_ENV_FILES:envFile,ORGBRAIN_ATTEMPT_HOOK_PROJECTS:'consentside'};
    const hook=(name,payload)=>{
      const result=spawnSync(process.execPath,['--no-warnings',cli,'hook',name],{env,input:JSON.stringify(payload),encoding:'utf8',timeout:20000});
      assert.equal(result.status,0,result.stderr);
      return JSON.parse(result.stdout);
    };
    const payload={cwd:ctx.root,session_id:'cli-roundtrip',tool_name:'functions.exec_command',tool_input:{cmd:'exit 17',workdir:ctx.root},tool_call_id:'failed-cli-call'};
    assert.notEqual(hook('codex-pre-tool',payload).hookSpecificOutput?.permissionDecision,'deny');
    hook('codex-post-tool',{...payload,tool_result:{exit_code:17}});
    assert.equal(hook('codex-pre-tool',payload).hookSpecificOutput.permissionDecision,'deny');
    const native={cwd:ctx.root,session_id:'cli-roundtrip',tool_name:'Bash',tool_input:{command:'exit 17'},tool_use_id:'native-cli-call'};
    assert.equal(hook('codex-pre-tool',native).hookSpecificOutput.permissionDecision,'deny');
    const wrapped={...payload,tool_name:'functions.exec',tool_input:{code:"text(await tools.exec_command({cmd:'exit 17'}));"}};
    assert.equal(hook('codex-pre-tool',wrapped).hookSpecificOutput.permissionDecision,'deny');
    assert.notEqual(hook('codex-pre-tool',{...payload,tool_input:{cmd:'exit 0'}}).hookSpecificOutput?.permissionDecision,'deny');
  } finally {await ctx.cleanup();}
});

test('Codex Bash hooks share historical command keys and preserve no-match searches', async () => {
  const ctx=await fixture();
  try {
    const command='exit 17';
    const direct={tool_name:'exec_command',session_id:'native-bash',tool_call_id:'historical',tool_input:{cmd:command},cwd:ctx.root,tool_result:{exit_code:17}};
    await recordHookActionResult(direct,ctx.store,'default','consentside');
    const native={tool_name:'Bash',session_id:'native-bash',tool_use_id:'native-failure',tool_input:{command},cwd:ctx.root};
    assert.equal((await preflightHookAction(native,ctx.store,'default','consentside'))?.decision,'block');
    assert.equal((await recordHookActionResult({...native,tool_response:{exit_code:17,stderr:''}},ctx.store,'default','consentside'))?.outcome,'failure');
    const search={...native,tool_use_id:'native-search',tool_input:{command:"printf 'healthy\\n' | rg '^absent$'"},tool_response:{exit_code:1,stderr:''}};
    assert.equal((await recordHookActionResult(search,ctx.store,'default','consentside'))?.outcome,'inconclusive');
    assert.notEqual((await preflightHookAction(search,ctx.store,'default','consentside'))?.decision,'block');
    for(const tool_response of ['Process exited with code 0','{"exit_code":0}','{"isError":false}','{"exit_code":1}','{"is_error":true}']) {
      assert.deepEqual(await recordHookActionResult({...native,tool_use_id:'native-text-only',tool_response},ctx.store,'default','consentside'),{recorded:false,reason:'opaque_or_unlinked_result'});
    }
    const rows=await ctx.store.searchAttempts('default',{project_id:'consentside'});
    assert.equal(rows.filter(x=>x.action_key===`tool:exec_command:${createHash('sha256').update(command).digest('hex').slice(0,48)}`).length,2);
  } finally {await ctx.cleanup();}
});

test('a newer failure with unknown conditions supersedes an older known-condition success', async () => {
  const ctx = await fixture();
  try {
    await ctx.store.recordAttempt('default',attempt('old-success',{outcome:'success',performed_at:1000}),{trusted:true});
    await ctx.store.recordAttempt('default',attempt('new-unknown',{attempt_type:'tool_result',conditions:{},failure_kind:'unknown',performed_at:2000}),{trusted:true});
    const result=await ctx.store.preflightAction('default',{project_id:'consentside',action_key:'sip:gateway:retry',conditions:{version:'v1',config:'a'}});
    assert.equal(result.decision,'block');
    assert.equal(result.prior_attempts[0].id,'new-unknown');
    await ctx.store.recordAttempt('default',attempt('older-failure',{performed_at:500}),{trusted:true});
    await ctx.store.recordAttempt('default',attempt('latest-success',{attempt_type:'tool_result',conditions:{},outcome:'success',performed_at:3000}),{trusted:true});
    assert.equal((await ctx.store.preflightAction('default',{project_id:'consentside',action_key:'sip:gateway:retry',conditions:{version:'v1',config:'a'}})).decision,'allow');
  } finally {await ctx.cleanup();}
});

test('a rejected batch does not consume a retry allowance before any command executes', async () => {
  const ctx = await fixture();
  try {
    const make=cmd=>({tool_name:'exec_command',session_id:'batch-retry',tool_input:{cmd,workdir:ctx.root}});
    for (const cmd of ['exit 17','exit 18']) await recordHookActionResult({...make(cmd),tool_call_id:cmd,tool_result:{exit_code:17}},ctx.store,'default','consentside');
    const blocked=await preflightHookAction(make('exit 17'),ctx.store,'default','consentside');
    await ctx.store.preflightAction('default',{...blocked.retry_context,retry_once:true,change_hypothesis:'A corrected fixture is ready'});
    const batch={...make('exit 17'),tool_name:'functions.exec',tool_input:{code:"await Promise.all([tools.exec_command({cmd:'exit 17'}),tools.exec_command({cmd:'exit 18'})]);"}};
    assert.equal((await preflightHookAction(batch,ctx.store,'default','consentside')).decision,'block');
    assert.equal((await preflightHookAction(make('exit 17'),ctx.store,'default','consentside')).decision,'allow');
    assert.equal((await preflightHookAction(make('exit 17'),ctx.store,'default','consentside')).decision,'block');
  } finally {await ctx.cleanup();}
});

test('outer wrapper success cannot resolve an inner command failure without a structured exit code', async () => {
  const ctx = await fixture();
  try {
    const payload={tool_name:'exec_command',session_id:'wrapper-outcome',tool_input:{cmd:'exit 17',workdir:ctx.root},tool_call_id:'direct-failure',tool_result:{exit_code:17}};
    await recordHookActionResult(payload,ctx.store,'default','consentside');
    const wrapped={...payload,tool_call_id:'wrapped-failure',tool_name:'functions.exec',tool_input:{code:"text(await tools.exec_command({cmd:'exit 17'}));"},
      tool_result:{isError:false,content:[{type:'text',text:'Script completed\nOutput:\n{"exit_code":17}'}]}};
    assert.equal((await recordHookActionResult(wrapped,ctx.store,'default','consentside')).recorded,false);
    assert.equal((await preflightHookAction(payload,ctx.store,'default','consentside')).decision,'block');
    const forged={...wrapped,tool_call_id:'unlinked-json',tool_input:{code:`text('{"exit_code":0}'); await tools.exec_command({cmd:'exit 17'});`},tool_result:{content:[{type:'text',text:'{"exit_code":0}'}]}};
    assert.equal((await recordHookActionResult(forged,ctx.store,'default','consentside')).recorded,false);
    assert.equal((await preflightHookAction(payload,ctx.store,'default','consentside')).decision,'block');
    wrapped.tool_result={content:[{type:'text',text:'{"exit_code":0}'}]};
    assert.equal((await recordHookActionResult(wrapped,ctx.store,'default','consentside')).outcome,'success');
    assert.equal((await preflightHookAction(payload,ctx.store,'default','consentside')).decision,'allow');
  } finally {await ctx.cleanup();}
});

test('normal JavaScript wrappers find static commands without executing strings, comments or dynamic code', async () => {
  const ctx=await fixture();
  try {
    const cmd='npm run known-failure', action_key=`tool:exec_command:${createHash('sha256').update(cmd).digest('hex').slice(0,48)}`;
    await ctx.store.recordAttempt('default',attempt('wrapped',{action_key,action_label:cmd,attempt_type:'tool_result',conditions:{},failure_kind:'unknown'}),{trusted:true});
    const code="text(await tools.exec_command({cmd: 'npm run known-failure', max_output_tokens: 1000}));";
    for(const tool_input of [code,{code}, {code:"const result = await tools.exec_command({\n cmd: `npm run known-failure`\n}); text(result);"},
      {code:"text(await tools.exec_command({cmd: 'pwd'}));\n"+code}]) {
      const result=await preflightHookAction({tool_name:'functions.exec',tool_input,session_id:'wrapper-test'},ctx.store,'default','consentside');
      assert.equal(result.decision,'block');
      assert.equal(result.retry_context.task_id,'codex:wrapper-test');
    }
    for(const code of ["text('tools.exec_command({cmd: known})');", "// tools.exec_command({cmd:'npm run known-failure'})", "const f=()=>tools.exec_command({cmd:'npm run known-failure'});", "await tools.exec_command({cmd: dynamic});"]){
      const result=await preflightHookAction({tool_name:'functions.exec',tool_input:{code}},ctx.store,'default','consentside');
      assert.notEqual(result.decision,'block');
    }
  } finally { await ctx.cleanup(); }
});

test("public MCP records remain reported and context exposes dated evidence without claiming use", async () => {
  const ctx = await fixture();
  try {
    const input = attempt("reported", { action_label: "Zoom callback を再設定" });
    const recorded = await handleLocalMcpRequest(ctx.store, { method: "tools/call", params: { name: "orgbrain_attempt_record", arguments: { attempt: input } } });
    const row = JSON.parse(recorded.content[0].text);
    assert.equal(row.verification_state, "reported");
    assert.equal(row.executed_by_type, "unknown");
    const check = await ctx.store.preflightAction("default", { project_id: "consentside", action_key: input.action_key, conditions: input.conditions });
    assert.equal(check.decision, "warn");
    const enriched = await handleLocalMcpRequest(ctx.store, { method: "tools/call", params: { name: "orgbrain_context_enrich", arguments: { project_id: "consentside", query: "Zoom callback", work_type: "implementation" } } });
    const context = JSON.parse(enriched.content[0].text);
    assert.equal(context.prior_attempts[0].action_label, input.action_label);
    assert.equal(context.prior_attempts[0].performed_at, input.performed_at);
    assert.equal(context.prior_attempts[0].evidence.length, 1);
    assert.equal(context.attempt_usage_ids.length, 1);
    const adoption = await handleLocalMcpRequest(ctx.store, { method: "tools/call", params: { name: "orgbrain_attempt_use_record", arguments: {
      project_id: "consentside", attempt_id: row.id, stage: "adopted", task_id: "task-one",
      evidence: [{ ref_type: "task_event", ref_id: "event:adoption", content_hash: "b".repeat(64) }]
    } } });
    assert.equal(JSON.parse(adoption.content[0].text).verification_state, "reported");
    const useReport = await ctx.store.attemptUseReport("default", "consentside");
    assert.deepEqual(useReport.map((item) => [item.stage, item.verification_state, item.count]), [
      ["adopted", "reported", 1], ["returned", "observed", 1]
    ]);
    const metrics = await ctx.store.actionAttemptMetricsReport("default", "consentside");
    assert.equal(metrics.context_queries, 1);
    assert.equal(metrics.history_return_rate, 1);
    assert.equal(metrics.verified_adoption_rate, 0);
    await assert.rejects(() => ctx.store.recordAttempt("default", attempt("secret", { result_summary: "api_key=supersecretvalue" }), { trusted: true }), /sensitive_result_summary/u);
    assert.equal(safeAttemptActionLabel("curl --token=supersecretvalue https://example.invalid", "exec_command"), "exec_command operation");
    await assert.rejects(() => ctx.store.recordAttempt("default", attempt("secret-label", { action_label: "token=supersecretvalue" }), { trusted: true }), /sensitive_action_label/u);
  } finally { await ctx.cleanup(); }
});

test("verified principal attribution needs a current profile; unknown executor stays unknown", async () => {
  const ctx = await fixture();
  try {
    await ctx.store.updateProfile("default", "user:alice", { display_name: "A" });
    await ctx.store.recordAttempt("default", attempt("alice", {
      executed_by_type: "principal", executed_by: "user:alice", performed_at: Date.parse("2026-08-25T00:00:00Z")
    }), { trusted: true, principal: "user:requester" });
    await ctx.store.recordAttempt("default", attempt("unknown", {
      action_key: "sip:gateway:other", executed_by_type: "unknown", executed_by: null,
      performed_at: Date.parse("2026-08-26T00:00:00Z")
    }), { trusted: true });
    const rows = await ctx.store.searchAttempts("default", { project_id: "consentside" });
    const named = rows.find((row) => row.id === "alice");
    assert.equal(named.requested_by, "user:requester");
    assert.match(named.summary_ja, /2026年8月25日にAさんが/u);
    assert.ok(named.evidence.length);
    const unknown = rows.find((row) => row.id === "unknown");
    assert.match(unknown.summary_ja, /実行者未確認/u);
    assert.doesNotMatch(unknown.summary_ja, /Aさん/u);
  } finally { await ctx.cleanup(); }
});

test("structured failed PostToolUse result is saved before task completion", async () => {
  const ctx = await fixture();
  try {
    const result = await recordHookActionResult({
      tool_name: "functions.exec_command", session_id: "session-one", tool_call_id: "call-one",
      tool_input: { cmd: "npm run check", workdir: ctx.root },
      tool_result: { exit_code: 2, output: "private diagnostic" }
    }, ctx.store, "default", "consentside");
    assert.equal(result.recorded, true);
    const rows = await ctx.store.searchAttempts("default", { project_id: "consentside" });
    assert.equal(rows[0].outcome, "failure");
    assert.equal(rows[0].attempt_type, "tool_result");
    assert.equal(rows[0].verification_state, "verified");
    assert.ok(!JSON.stringify(rows[0]).includes("private diagnostic"));
  } finally { await ctx.cleanup(); }
});

test('search-only exit one remains inconclusive and does not block a repeat', async () => {
  const ctx=await fixture();
  try {
    const commands=["rg '^absent$' file.txt", "/usr/bin/grep -q absent file.txt",
      "printf 'healthy\\n' | rg '^absent$'", "lsof -nP -iTCP | rg 'strata|llama'\nlaunchctl list | rg 'strata|flash'",
      "printf 'a; b|c\\n' | rg '^absent$'", "rtk rg absent file.txt"];
    for(const [i,cmd] of commands.entries()) {
      const payload={tool_name:'exec_command',session_id:'search-status',tool_call_id:`search-${i}`,tool_input:{cmd,workdir:ctx.root},tool_result:{exit_code:1,stderr:''}};
      assert.equal((await recordHookActionResult(payload,ctx.store,'default','consentside')).outcome,'inconclusive');
      assert.notEqual((await preflightHookAction(payload,ctx.store,'default','consentside')).decision,'block');
    }
    assert.equal((await ctx.store.searchAttempts('default',{project_id:'consentside'})).filter(x=>x.outcome==='failure').length,0);
  } finally {await ctx.cleanup();}
});

test('search syntax errors, stderr and failures outside a search-only program still block', async () => {
  const ctx=await fixture();
  try {
    const cases=[['rg "[" file.txt',2,'regex error'],['grep absent missing-file',2,'missing file'],
      ["printf 'x' | rg absent",1,'printf: write error'],['npm test && rg absent file.txt',1,''],
      ['false | rg absent',1,''],['rg absent file.txt; false',1,''],['rg "$(false)" file.txt',1,''],
      ['rg --pre=failed-tool absent file.txt',1,''],['echo failed > output.txt; rg absent output.txt',1,'']];
    for(const [i,[cmd,exit_code,stderr]] of cases.entries()) {
      const payload={tool_name:'exec_command',session_id:'search-errors',tool_call_id:`error-${i}`,tool_input:{cmd,workdir:ctx.root},tool_result:{exit_code,stderr}};
      assert.equal((await recordHookActionResult(payload,ctx.store,'default','consentside')).outcome,'failure');
      assert.equal((await preflightHookAction(payload,ctx.store,'default','consentside')).decision,'block');
    }
  } finally {await ctx.cleanup();}
});

test('legacy search status one is reconsidered without deleting history or releasing real errors', async () => {
  const ctx=await fixture();
  try {
    const cmd="printf 'healthy\\n' | rg '^absent$'",action_key=`tool:exec_command:${createHash('sha256').update(cmd).digest('hex').slice(0,48)}`;
    const payload={tool_name:'exec_command',session_id:'legacy-search',tool_input:{cmd,workdir:ctx.root}};
    await ctx.store.recordAttempt('default',attempt('legacy-search',{action_key,attempt_type:'tool_result',conditions:{},result_summary:'exit code 1',failure_kind:'unknown'}),{trusted:true});
    const reviewed=await preflightHookAction(payload,ctx.store,'default','consentside');
    assert.equal(reviewed.decision,'warn');
    assert.equal(reviewed.reason,'search_status_inconclusive');
    assert.equal((await ctx.store.searchAttempts('default',{project_id:'consentside',action_key}))[0].outcome,'failure');
    await ctx.store.recordAttempt('default',attempt('real-search-error',{action_key,attempt_type:'tool_result',conditions:{},result_summary:'exit code 2',failure_kind:'unknown',performed_at:Date.now()}),{trusted:true});
    assert.equal((await preflightHookAction(payload,ctx.store,'default','consentside')).decision,'block');
  } finally {await ctx.cleanup();}
});

test('both historical command events and tool outputs distinguish search status from errors', async () => {
  const ctx=await fixture();
  try {
    const file=join(ctx.root,'source.jsonl'),at='2026-11-18T00:00:00Z';
    const commands=[{cmd:"printf 'healthy\\n' | rg '^absent$'",exit_code:1},{cmd:'rg "[" file.txt',exit_code:2}];
    const rows=[{timestamp:at,type:'session_meta',payload:{id:'search-import',cwd:ctx.root,thread_source:'user'}}];
    for(const [i,x] of commands.entries()) {
      rows.push({timestamp:at,type:'event_msg',payload:{type:'item_completed',completed_at_ms:Date.parse(at),item:{type:'CommandExecution',id:`command-${i}`,cwd:ctx.root,command:['/bin/zsh','-lc',x.cmd],exit_code:x.exit_code,stderr:''}}});
      rows.push({timestamp:at,type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:`tool-${i}`,arguments:JSON.stringify({cmd:x.cmd})}});
      rows.push({timestamp:at,type:'response_item',payload:{type:'function_call_output',call_id:`tool-${i}`,output:JSON.stringify({exit_code:x.exit_code,stderr:''})}});
    }
    await writeFile(file,rows.map(JSON.stringify).join('\n')+'\n');
    const options={workspaceRoot:ctx.root,sessionFiles:[file],env:{ORGBRAIN_ENABLE_CLOUD_MEMORY:'false',ORGBRAIN_ENABLE_ORG_SHARING:'false',ORGBRAIN_WORKSPACES_FILE:join(ctx.root,'missing.json')}};
    const report=await buildCodexAttemptImportReport(options);
    assert.equal(report.plan.candidates.filter(x=>x.outcome==='inconclusive').length,2);
    assert.equal(report.plan.candidates.filter(x=>x.outcome==='failure').length,2);
    await applyCodexAttemptImportReport(report,{...options,store:ctx.store,expectedPlanHash:report.plan_hash});
    for(const [i,x] of commands.entries()) {
      const action_key=`tool:exec_command:${createHash('sha256').update(x.cmd).digest('hex').slice(0,48)}`;
      const decision=await ctx.store.preflightAction('default',{project_id:report.plan.target.project_id,action_key,conditions:{}});
      assert.equal(decision.decision==='block',i===1);
    }
  } finally {await ctx.cleanup();}
});

test('reimport corrects legacy search classification without replacing original evidence', async () => {
  const ctx=await fixture();
  try {
    const file=join(ctx.root,'legacy-source.jsonl'),at='2026-11-18T00:00:00Z';
    const rows=[{timestamp:at,type:'session_meta',payload:{id:'legacy-import',cwd:ctx.root,thread_source:'user'}}];
    for(const [i,stderr] of ['', 'query producer error'].entries()) rows.push({timestamp:at,type:'event_msg',payload:{type:'item_completed',completed_at_ms:Date.parse(at),item:{type:'CommandExecution',id:`command-${i}`,cwd:ctx.root,command:['/bin/zsh','-lc',`printf 'healthy' | rg 'absent-${i}'`],exit_code:1,stderr}}});
    await writeFile(file,rows.map(JSON.stringify).join('\n')+'\n');
    const options={workspaceRoot:ctx.root,sessionFiles:[file],env:{ORGBRAIN_ENABLE_CLOUD_MEMORY:'false',ORGBRAIN_ENABLE_ORG_SHARING:'false',ORGBRAIN_WORKSPACES_FILE:join(ctx.root,'missing.json')}};
    const report=await buildCodexAttemptImportReport(options);
    for(const candidate of report.plan.candidates) await ctx.store.recordAttempt('default',{...candidate,outcome:'failure',failure_kind:'unknown',result_summary:'exit code 1'},{trusted:true});
    const applied=await applyCodexAttemptImportReport(report,{...options,store:ctx.store,expectedPlanHash:report.plan_hash});
    assert.equal(applied.created,2);
    const repeated=await applyCodexAttemptImportReport(report,{...options,store:ctx.store,expectedPlanHash:report.plan_hash});
    assert.equal(repeated.deduplicated,2);
    const db=ctx.store.open();
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM action_attempts').get().n,4);
      for(const candidate of report.plan.candidates) {
        const original=db.prepare('SELECT * FROM action_attempts WHERE id=?').get(candidate.id);
        assert.equal(original.outcome,'failure');assert.equal(original.result_summary,'exit code 1');
        const corrected=db.prepare('SELECT * FROM action_attempts WHERE supersedes_id=?').get(candidate.id);
        assert.equal(corrected.outcome,candidate.outcome);assert.equal(corrected.result_summary,candidate.result_summary);
        assert.equal(corrected.evidence_json,original.evidence_json);
      }
      db.prepare("UPDATE action_attempts SET action_label='different original' WHERE id=?").run(report.plan.candidates[0].id);
    } finally {db.close();}
    await assert.rejects(applyCodexAttemptImportReport(report,{...options,store:ctx.store,expectedPlanHash:report.plan_hash}),/attempt_source_key_conflict/);
  } finally {await ctx.cleanup();}
});

test("PreToolUse blocks a confirmed duplicate and requires review after a change", async () => {
  const ctx = await fixture();
  try {
    const workspace = join(ctx.root, "repo");
    await mkdir(workspace);
    await writeFile(join(workspace, "file.txt"), "before\n");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
    execFileSync("git", ["add", "file.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });
    const sha = (value) => createHash("sha256").update(value).digest("hex");
    const cmd = "npm run broken-fix";
    const actionKey = `tool:exec_command:${sha(cmd).slice(0, 48)}`;
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
    await ctx.store.recordAttempt("default", attempt("known", {
      action_key: actionKey, action_label: cmd, conditions: { git_head: head, tracked_diff: sha("") }
    }), { trusted: true });
    const payload = { tool_name: "functions.exec_command", tool_input: { cmd, workdir: workspace }, cwd: workspace };
    const blocked = await preflightHookAction(payload, ctx.store, "default", "consentside");
    assert.equal(blocked.decision, "block");
    await writeFile(join(workspace, "file.txt"), "changed\n");
    const changed = await preflightHookAction(payload, ctx.store, "default", "consentside");
    assert.equal(changed.decision, "block");
    assert.equal(changed.reason, "failed_action_requires_review");
    const opaque = await preflightHookAction({ tool_name: "functions.exec", tool_input: { code: "const x = await tools.exec_command(dynamic)" }, cwd: workspace }, ctx.store, "default", "consentside");
    assert.equal(opaque.reason, "opaque_tool_action");
  } finally { await ctx.cleanup(); }
});

test("historical import accepts structured command outcomes, excludes opaque output, and is idempotent", async () => {
  const ctx = await fixture();
  try {
    const workspace = join(ctx.root, "consentside");
    const sessionsRoot = join(ctx.root, "sessions");
    await mkdir(workspace);
    await mkdir(sessionsRoot);
    const sessionId = "session-fixture";
    const base = { timestamp: "2026-08-25T00:00:00.000Z", type: "session_meta", payload: { id: sessionId, cwd: workspace, thread_source: "user" } };
    const event = (id, exit, second) => ({ timestamp: `2026-08-25T00:00:0${second}.000Z`, type: "event_msg", payload: {
      type: "item_completed", completed_at_ms: Date.parse(`2026-08-25T00:00:0${second}.000Z`),
      item: { type: "CommandExecution", id, cwd: pathToFileURL(workspace).href,
        command: ["/bin/zsh", "-lc", "npm run check"], exit_code: exit, stdout: "private output", stderr: "" }
    } });
    const file = join(sessionsRoot, "one.jsonl");
    await writeFile(file, [base, event("exec-one", 2, 1), event("exec-two", 0, 2),
      { timestamp: "2026-08-25T00:00:03.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "opaque", output: "[object Object]" } }
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const options = { workspaceRoot: workspace, sessionFiles: [file], sessionsRoot, env: {
      ORGBRAIN_ENABLE_CLOUD_MEMORY: "false", ORGBRAIN_ENABLE_ORG_SHARING: "false",
      ORGBRAIN_WORKSPACES_FILE: join(ctx.root, "missing.json"), ORGBRAIN_TENANT_ID: "default"
    } };
    const report = await buildCodexAttemptImportReport(options);
    assert.equal(report.summary.candidates, 2);
    assert.equal(report.summary.nonzero_tool_exits, 1);
    assert.ok(!JSON.stringify(report).includes("private output"));
    const unrelated = join(sessionsRoot, "unrelated.jsonl");
    await writeFile(unrelated, `${JSON.stringify({ ...base, payload: { ...base.payload, id: "unrelated", cwd: ctx.root } })}\n`);
    options.sessionFiles.push(unrelated);
    const first = await applyCodexAttemptImportReport(report, { ...options, store: ctx.store, expectedPlanHash: report.plan_hash });
    const second = await applyCodexAttemptImportReport(report, { ...options, store: ctx.store, expectedPlanHash: report.plan_hash });
    assert.equal(first.created, 2);
    assert.equal(second.deduplicated, 2);
    assert.equal((await ctx.store.searchAttempts("default", { project_id: "consentside" })).length, 2);
  } finally { await ctx.cleanup(); }
});
