import {describe,it,expect} from 'vitest';
import {normalizeMemoryPlaybook} from '@org-brain/shared';
const scope={level:'project',project_id:'workflow-fixture'};
const pb=()=>({schema_version:'memory-playbook/v1',sources:[{ref:'repo:workflow-fixture/skills/job/SKILL.md',version:'fixture-v1',content_hash:'sha256:'+'a'.repeat(64)}],prerequisites:'Read the Job skill and its mandatory safe read gate.',steps:[{command:{executable:'fixture-jobctl',args:['status','--job','<current-job-id>'],tool_version:'fixture-v1'},expected_output:'Authorized current Job status',stop_when:'Scope or version mismatch',on_failure:'Follow the skill without expanding IAM'}],refresh_when:'Refresh the cited section when its version changes'});
describe('bounded typed playbook command validation',()=>{
  it.each([
    ['fixture-jobctl',['status','--job','<current-job-id>']],
    ['gcloud',['run','jobs','describe','<current-job-id>','--project','<current-project-id>','--region','<current-region>']],
    ['gcloud',['logging','read','<current-filter>','--project','<current-project-id>','--limit','20']]
  ])('accepts read template %s while retaining unverified state',(executable,args)=>{
    const p=pb();p.steps[0].command={executable:executable as string,args:args as string[],tool_version:'fixture-v1'};
    const normalized=normalizeMemoryPlaybook(p,scope as any);
    expect(normalized.verification_state).toBe('unverified');expect(normalized.steps[0].command.validation_state).toBe('template_checked_unverified');expect(normalized.sources[0].evidence_status).toBe('supplied_unverified');
  });
  it.each([
    ['gcloud',['run','jobs','execute','<current-job-id>']],
    ['gcloud',['projects','add-iam-policy-binding','<current-project-id>']],
    ['gcloud',['logging','read','<current-filter>','--project','<current-project-id>','--limit','20','--flag','extra']],
    ['gcloud',['run','jobs','describe','fixed-target','--project','<current-project-id>','--region','<current-region>']],
    ['bash',['-c','rm -rf fixture']],['curl',['https://example.invalid']],
    ['fixture-jobctl',['status','--job','<current-job-id>; rm fixture']],
    ['fixture-jobctl',['status','--job','<current-job-id> | sh']],
    ['fixture-jobctl',['status','--job','$(echo fixture)']],
    ['fixture-jobctl',['status','--job','`echo fixture`']],
    ['fixture-jobctl',['status','--job','<current-job-id>\nrm fixture']],
    ['fixture-jobctl',['status','--job','＜current-job-id＞；rm fixture']]
  ])('rejects dangerous/unsupported command %s',(executable,args)=>{
    const p=pb();p.steps[0].command={executable:executable as string,args:args as string[],tool_version:'fixture-v1'};expect(()=>normalizeMemoryPlaybook(p,scope as any)).toThrow();
  });
  it('rejects caller-supplied verified state',()=>{const p=pb() as any;p.steps[0].command.validation_state='verified';expect(()=>normalizeMemoryPlaybook(p,scope as any)).toThrow();});
});
