import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from 'acorn';
import { safeAttemptActionLabel, commandExitResult } from "@org-brain/shared/runtime/attempt-history-runtime";
import { hasTaskIdentity, taskKeyFromHookPayload } from './task-commitment-store.mjs';

const execFileAsync = promisify(execFile);
const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

function asObject(value) {
  if (typeof value === "string") { try { return asObject(JSON.parse(value)); } catch { return null; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function toolName(payload) {
  return String(payload.tool_name ?? payload.name ?? payload.tool ?? "").split(/[.:/]/u).at(-1);
}

function actionFromInput(name, input, payload) {
  if (name === "Bash") name = "exec_command";
  if (name !== "exec_command" && name !== "apply_patch") return null;
  const operation = name === "exec_command" ? input?.command ?? input?.cmd : input?.input ?? input?.patch;
  if (typeof operation !== "string" || !operation.trim()) return null;
  return {
    tool: name,
    command: name === 'exec_command' ? operation : null,
    action_key: `tool:${name}:${digest(operation).slice(0, 48)}`,
    action_label: safeAttemptActionLabel(operation, name),
    target: name,
    workdir: typeof input?.workdir === "string" ? input.workdir : payload.cwd
  };
}

function actionsFromHook(payload) {
  const name=toolName(payload), raw=payload.tool_input ?? payload.input ?? payload.arguments;
  const input=asObject(raw);
  if(name!=='exec') {
    const action=actionFromInput(name,input,payload);
    return {actions:action?[action]:[],opaque:!action};
  }
  const code=typeof raw==='string' && !input ? raw : input?.code;
  const actions=[];let opaque=false, resultLinked=false;
  if(typeof code!=='string'||code.length>131072)return {actions,opaque:true};
  const literal=node=>node?.type==='Literal' && !node.regex ? node.value
    : node?.type==='TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : undefined;
  const visit=node=>{
    if(!node)return;
    if(node.type==='AwaitExpression'){visit(node.argument);return;}
    if(node.type==='Literal'||node.type==='Identifier')return;
    if(node.type!=='CallExpression'){opaque=true;return;}
    const callee=node.callee;
    if(callee.type==='Identifier'&&['text','notify'].includes(callee.name)) {node.arguments.forEach(visit);return;}
    if(callee.type!=='MemberExpression'||callee.computed||callee.optional){opaque=true;return;}
    if(callee.object.name==='Promise'&&['all','allSettled'].includes(callee.property.name)&&node.arguments[0]?.type==='ArrayExpression'){
      node.arguments[0].elements.forEach(visit);return;
    }
    if(callee.object.name!=='tools'||callee.property.name!=='exec_command'||node.arguments.length!==1||node.arguments[0].type!=='ObjectExpression'){opaque=true;return;}
    const args=Object.create(null);
    for(const prop of node.arguments[0].properties) {
      const key=prop.key?.name ?? literal(prop.key), value=literal(prop.value);
      if(prop.type!=='Property'||prop.computed||prop.kind!=='init'||prop.method||typeof key!=='string'||value===undefined){opaque=true;return;}
      args[key]=value;
    }
    const action=actionFromInput('exec_command',args,payload);
    if(action)actions.push(action);else opaque=true;
  };
  try {
    const program=parse(code,{ecmaVersion:'latest',sourceType:'module'});
    for(const statement of program.body) {
      if(statement.type==='ExpressionStatement')visit(statement.expression);
      else if(statement.type==='VariableDeclaration') {
        if(statement.declarations.some(d=>d.id.type!=='Identifier'||['tools','text','notify','Promise'].includes(d.id.name)))return {actions:[],opaque:true};
        statement.declarations.forEach(d=>visit(d.init));
      } else if(statement.type!=='EmptyStatement')opaque=true;
    }
    // Only these complete programs establish that the emitted value belongs to
    // the command. A literal JSON message elsewhere is not execution evidence.
    const body=program.body, last=body.at(-1)?.expression;
    const printed=last?.type==='CallExpression' && last.callee.type==='Identifier'
      && last.callee.name==='text' && last.arguments.length===1 ? last.arguments[0] : null;
    const awaitedCommand=node=>node?.type==='AwaitExpression' && node.argument.type==='CallExpression'
      && node.argument.callee.type==='MemberExpression' && node.argument.callee.object.name==='tools'
      && node.argument.callee.property.name==='exec_command';
    if(body.length===1 && awaitedCommand(printed)) resultLinked=true;
    if(body.length===2 && body[0].type==='VariableDeclaration' && body[0].declarations.length===1) {
      const declared=body[0].declarations[0];
      resultLinked=awaitedCommand(declared.init) && printed?.type==='Identifier' && printed.name===declared.id.name;
    }
  } catch {return {actions:[],opaque:true};}
  return {actions,opaque,resultLinked};
}

function structuredResult(payload, wrapped, command) {
  const raw = payload.tool_result ?? payload.tool_response ?? payload.result ?? payload.output;
  // Codex Bash sends stdout text, without an exit code. JSON-looking stdout
  // is command content, not host-provided execution metadata.
  if (toolName(payload) === "Bash" && typeof raw === "string") return null;
  let result = asObject(raw);
  if (wrapped && Array.isArray(result?.content) && result.content.length !== 1) return null;
  if (Array.isArray(result?.content)) result = asObject(result.content.find((item) => item?.type === "text")?.text) ?? result;
  if (Number.isInteger(result?.exit_code)) return {...commandExitResult(command, result.exit_code, result.stderr), raw};
  // A successful wrapper may contain a failed or unfinished command.
  if (wrapped) return null;
  if (result?.isError === true || result?.is_error === true) return { outcome: "failure", result_summary: "tool error", raw };
  if (result?.isError === false || result?.is_error === false) return { outcome: "success", result_summary: "tool succeeded", raw };
  return null;
}

async function workspaceConditions(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  try {
    const [head, status, diff] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 700, maxBuffer: 1024 }),
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeout: 700, maxBuffer: 100_000 }),
      execFileAsync("git", ["diff", "HEAD", "--binary"], { cwd, timeout: 700, maxBuffer: 2_000_000 })
    ]);
    if (status.stdout.split("\n").some((line) => line.startsWith("??"))) return null;
    return { git_head: head.stdout.trim(), tracked_diff: digest(diff.stdout) };
  } catch { return null; }
}

export async function preflightHookAction(payload, store, tenantId, projectId) {
  const name = toolName(payload);
  if (!/^(?:Bash|exec|exec_command|apply_patch)$/u.test(name)) return null;
  const parsed = actionsFromHook(payload);
  if (!parsed.actions.length) {
    await store.recordActionHookCoverage(tenantId, projectId, name, "opaque");
    return { decision: "warn", reason: "opaque_tool_action" };
  }
  const explicitTask = payload.task_id ?? payload.task_key ?? payload.session_id ?? payload.thread_id;
  const taskId = hasTaskIdentity(payload)
    ? (typeof explicitTask === 'string' && explicitTask.startsWith('codex:') ? explicitTask : taskKeyFromHookPayload(payload)) : null;
  let decision={decision:'allow',reason:'no_accessible_prior_attempt',prior_attempts:[]},retryContext;
  for(const action of parsed.actions) {
    const conditions = await workspaceConditions(action.workdir);
    const checked = await store.preflightAction(tenantId, { project_id: projectId, action_key: action.action_key, conditions, task_id: taskId }, {
      source: "hook", command: action.command, consumeRetry: parsed.actions.length === 1 && !parsed.opaque
    });
    if(checked.decision!=='allow'||decision.decision==='allow')decision=checked;
    if(checked.decision==='block'){
      if(taskId&&checked.reason==='failed_action_requires_review')retryContext={tenant_id:tenantId,project_id:projectId,task_id:taskId,action_key:action.action_key,conditions:conditions ?? {}};
      break;
    }
  }
  if(parsed.opaque) {
    await store.recordActionHookCoverage(tenantId,projectId,name,'opaque');
    if(decision.decision==='allow')decision={decision:'warn',reason:'opaque_tool_action'};
  }
  await store.recordActionHookCoverage(tenantId, projectId, name, decision.decision === "block" ? "blocked" : "checked");
  return {...decision,...(retryContext?{retry_context:retryContext}:{})};
}

export async function recordHookActionResult(payload, store, tenantId, projectId) {
  const name = toolName(payload);
  if (!/^(?:Bash|exec|exec_command|apply_patch)$/u.test(name)) return null;
  const parsed = actionsFromHook(payload);
  const action = parsed.actions.length === 1 && !parsed.opaque && (name !== 'exec' || parsed.resultLinked) ? parsed.actions[0] : null;
  const result = structuredResult(payload, name === 'exec', action?.command);
  const callId = payload.tool_call_id ?? payload.call_id ?? payload.tool_use_id;
  if (!action || !result || !callId) {
    await store.recordActionHookCoverage(tenantId, projectId, name, "opaque");
    return { recorded: false, reason: "opaque_or_unlinked_result" };
  }
  const prior = await store.searchAttempts(tenantId, { project_id: projectId, action_key: action.action_key, limit: 1 });
  if (result.outcome === "success" && prior.length === 0) return { recorded: false, reason: "unrelated_success" };
  const sourceKey = digest(`${payload.session_id ?? payload.thread_id ?? ""}\0${callId}`);
  const conditions = await workspaceConditions(action.workdir);
  const attempt = await store.recordAttempt(tenantId, {
    id: sourceKey, project_id: projectId, action_key: action.action_key,
    action_label: action.action_label, attempt_type: "tool_result", target: action.target,
    conditions: conditions ?? {}, outcome: result.outcome, result_summary: result.result_summary,
    failure_kind: result.outcome === "failure" ? "unknown" : undefined,
    performed_at: Date.now(), executed_by_type: "agent", executed_by: "codex",
    evidence: [{ ref_type: "hook_tool_result", ref_id: digest(String(callId)), content_hash: digest(result.raw) }],
    source: "codex_post_tool", source_key: sourceKey
  }, { trusted: true });
  await store.recordActionHookCoverage(tenantId, projectId, name, "recorded");
  return { recorded: true, attempt_id: attempt.id, outcome: attempt.outcome };
}
