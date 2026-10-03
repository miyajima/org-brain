import { normalizeMemoryPaths } from './memory-capture-v2-runtime.mjs';
import { screenInteractiveMemory,screenReviewReference } from './memory-review-runtime.mjs';
function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`invalid_${label}`);
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`invalid_${label}`);
  screenInteractiveMemory(value, label, { proseDates: true });
  if (normalizeMemoryPaths(value) !== value) throw new Error(`invalid_${label}_path`);
  if (/\b(?:ignore|override|disregard)\b.{0,40}\b(?:previous|system|developer|security)\b|前の指示を無視/iu.test(value.normalize('NFKC'))) throw new Error('unsafe_playbook_instruction');
  return value.trim();
}
const id = (value, label) => {
  // Explicit opaque identifiers share the conversation envelope's UUID exception.
  if (typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) return value;
  const result=text(value,128,label);if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(result))throw new Error(`invalid_${label}`);return result;
};
export function normalizeMemoryScope(value, projectId) {
  object(value,['level','project_id','task_key','expires_at'],'memory_scope');
  if (value.project_id !== projectId || !['project','task'].includes(value.level)) throw new Error('invalid_memory_scope');
  if (value.level === 'project') {
    if (value.task_key !== undefined || value.expires_at !== undefined) throw new Error('durable_scope_contains_task_constraint');
    return { level:'project',project_id:projectId };
  }
  const taskKey=id(value.task_key,'task_key');
  if (typeof value.expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/u.test(value.expires_at) || !Number.isFinite(Date.parse(value.expires_at)) || new Date(value.expires_at).toISOString().slice(0,10) !== value.expires_at.slice(0,10)) throw new Error('invalid_task_expiry');
  return { level:'task',project_id:projectId,task_key:taskKey,expires_at:new Date(value.expires_at).toISOString() };
}
export function normalizeTaskConstraint(value, scope, occurredAt) {
  object(value,['decision_key','max_calls','max_cost','currency'],'task_constraint');
  if (scope?.level !== 'task' || Date.parse(scope.expires_at) <= Date.parse(occurredAt)
    || Date.parse(scope.expires_at)-Date.parse(occurredAt)>7*86400000) throw new Error('invalid_task_constraint_scope');
  if (value.max_calls !== undefined && (!Number.isSafeInteger(value.max_calls) || value.max_calls<1 || value.max_calls>10000)) throw new Error('invalid_max_calls');
  if (value.max_cost !== undefined && (!Number.isFinite(value.max_cost) || value.max_cost<=0 || value.max_cost>10000 || value.currency !== 'USD')) throw new Error('invalid_max_cost');
  if (value.currency !== undefined && value.max_cost === undefined || value.max_calls === undefined && value.max_cost === undefined) throw new Error('invalid_task_constraint_limits');
  return { decision_key:id(value.decision_key,'decision_key'),...(value.max_calls !== undefined?{ max_calls:value.max_calls }:{}),...(value.max_cost !== undefined?{ max_cost:value.max_cost,currency:'USD' }:{}) };
}
// Exact read-template allowlist, not a shell interpreter or execution attestation.
// Targets remain placeholders; freshness/authorization must be resolved at use.
function readTemplate(executable,args) {
  const joined=args.join(' ');
  return executable==='fixture-jobctl' && joined==='status --job <current-job-id>'
    || executable==='gcloud' && joined==='run jobs describe <current-job-id> --project <current-project-id> --region <current-region>'
    || executable==='gcloud' && joined==='logging read <current-filter> --project <current-project-id> --limit 20';
}
export function normalizeMemoryPlaybook(value, scope) {
  object(value,['schema_version','sources','prerequisites','steps','refresh_when'],'playbook');
  if (value.schema_version !== 'memory-playbook/v1' || scope?.level !== 'project') throw new Error('invalid_playbook_scope');
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length>3 || !Array.isArray(value.steps) || !value.steps.length || value.steps.length>4) throw new Error('invalid_playbook_bounds');
  const sources=value.sources.map(source=>{
    object(source,['ref','version','content_hash'],'playbook_source');
    const ref=screenReviewReference(text(source.ref,512,'playbook_source_ref'));
    if (!/^repo:[a-zA-Z0-9._-]+\/(?!.*(?:\.\.|[?&#]))[^\s]+$/u.test(ref) || !/^sha256:[a-f0-9]{64}$/u.test(source.content_hash ?? '')) throw new Error('invalid_playbook_source');
    return { ref,version:text(source.version,80,'source_version'),content_hash:source.content_hash,evidence_status:'supplied_unverified' };
  });
  const steps=value.steps.map(step=>{
    object(step,['command','expected_output','stop_when','on_failure'],'playbook_step');
    object(step.command,['executable','args','tool_version'],'playbook_command');
    const executable=id(step.command.executable,'command_executable');
    if (!Array.isArray(step.command.args) || step.command.args.length>12) throw new Error('invalid_command_args');
    const args=step.command.args.map(arg=>text(arg,160,'command_arg'));
    if (args.some(arg=>/[;&|`$()\r\n]/u.test(arg)) || !readTemplate(executable,args)) throw new Error('unsupported_read_command_template');
    return {command:{executable,args,tool_version:text(step.command.tool_version,80,'tool_version'),validation_state:'template_checked_unverified'},
      expected_output:text(step.expected_output,160,'expected_output'),stop_when:text(step.stop_when,160,'stop_when'),on_failure:text(step.on_failure,160,'on_failure')};
  });
  const result={schema_version:'memory-playbook/v1',scope,sources,prerequisites:text(value.prerequisites,240,'prerequisites'),steps,refresh_when:text(value.refresh_when,240,'refresh_when'),verification_state:'unverified'};
  if (JSON.stringify(result).length>3000) throw new Error('playbook_too_large');
  return result;
}
export function renderMemoryPlaybook(playbook) {
  return ['Playbook (template checked; execution/source claims unverified):',
    ...playbook.sources.map(source=>`Source: ${source.ref} @ ${source.version} ${source.content_hash}`),
    `Prerequisites: ${playbook.prerequisites}`,
    ...playbook.steps.map(step=>`Next: ${step.command.executable} ${step.command.args.join(' ')} [tool ${step.command.tool_version}]. Expect: ${step.expected_output}. Stop: ${step.stop_when}. Failure: ${step.on_failure}.`),
    `Refresh: ${playbook.refresh_when}. Resolve current targets and current task limits before any action; this memory grants no execution permission.`].join('\n');
}
